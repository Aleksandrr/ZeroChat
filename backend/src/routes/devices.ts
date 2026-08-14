/**
 * Device Routes - API для управления устройствами
 * 
 * Эндпоинты:
 * - GET /api/devices - Получить список устройств
 * - DELETE /api/devices/:id - Удалить устройство (выход с устройства)
 * - PATCH /api/devices/:id - Обновить имя устройства
 * 
 * Согласно протоколу Sesame (docs/signal/sesame.md):
 * - Каждое устройство имеет уникальный DeviceID
 * - При удалении устройства отзываются токены и ключи
 * 
 * @see plans/этап-3-мультидевайс-и-синхронизация.md - Задача 3.1
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'crypto';
import { verifyAccessToken } from '../utils/jwt';
import {
  getUserDevices,
  removeDevice,
  updateDeviceName,
} from '../services/devices';
import {
  verifyCode,
  getPendingVerifications,
} from '../services/device-verification';
import { prisma } from '../prisma/client';
import type { WebSocketManager } from '../ws/manager';
import { CommandMessage } from '../ws/types';
import { createProblemDetails } from '../utils/shared';

// Problem Details RFC 7807

// Расширение типов Fastify для добавления wsManager
declare module 'fastify' {
  interface FastifyInstance {
    wsManager: WebSocketManager;
  }
}


// Pre-handler для аутентификации
const authPreHandler = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
  try {
    const authHeader = request.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send(createProblemDetails(
        'Unauthorized',
        401,
        'No token provided'
      ));
    }

    const token = authHeader.substring(7);
    const decoded = verifyAccessToken(token);
    (request as any).user = decoded;
  } catch (error) {
    return reply.code(401).send(createProblemDetails(
      'Unauthorized',
      401,
      'Invalid token'
    ));
  }
};

export const deviceRoutes = async (fastify: FastifyInstance) => {
  // ==================== GET /api/devices ====================
  // Получить список устройств текущего пользователя
  fastify.get('/devices', {
    preHandler: authPreHandler,
    handler: async (request, reply) => {
      try {
        const userId = (request as any).user.userId;
        const currentDeviceId = (request as any).user.deviceId;

        const result = await getUserDevices(userId, currentDeviceId);

        return {
          success: true,
          devices: result.devices.map(d => ({
            id: d.id,
            device_uuid: d.deviceId,
            name: d.name,
            type: d.type,
            fingerprint: d.fingerprint,
            last_seen_at: d.lastSeen ? d.lastSeen.toISOString() : null,
            verified_at: d.verifiedAt ? d.verifiedAt.toISOString() : null,
            is_current: d.deviceId === currentDeviceId,
            created_at: d.createdAt.toISOString(),
          })),
          current_device_id: result.currentDeviceId,
        };
      } catch (error) {
        fastify.log.error({ error: 'Failed to get devices', details: error });
        return reply.code(500).send(createProblemDetails(
          'Internal Server Error',
          500,
          error instanceof Error ? error.message : 'Failed to get devices'
        ));
      }
    },
  });

  // ==================== DELETE /api/devices/:id ====================
  // Удалить устройство (выход с устройства)
  fastify.delete('/devices/:id', {
    preHandler: authPreHandler,
    handler: async (request, reply) => {
      try {
        const userId = (request as any).user.userId;
        const currentDeviceId = (request as any).user.deviceId;
        const { id } = request.params as { id: string };

        // Проверяем, что пользователь не удаляет текущее устройство
        // (для этого есть /api/auth/logout)
        const device = await prisma.device.findFirst({
          where: { id, userId },
          select: { deviceId: true },
        });

        if (device && device.deviceId === currentDeviceId) {
          return reply.code(400).send(createProblemDetails(
            'Bad Request',
            400,
            'Cannot remove current device. Use /api/auth/logout instead.',
            'https://zerochat.app/errors/current-device-removal'
          ));
        }

        await removeDevice(userId, id);

        return {
          success: true,
          message: 'Device removed successfully',
        };
      } catch (error) {
        fastify.log.error({ error: 'Failed to remove device', details: error });
        
        if (error instanceof Error && error.message.includes('last active device')) {
          return reply.code(400).send(createProblemDetails(
            'Bad Request',
            400,
            error.message,
            'https://zerochat.app/errors/last-device'
          ));
        }

        if (error instanceof Error && error.message.includes('not found')) {
          return reply.code(404).send(createProblemDetails(
            'Not Found',
            404,
            error.message
          ));
        }

        return reply.code(500).send(createProblemDetails(
          'Internal Server Error',
          500,
          error instanceof Error ? error.message : 'Failed to remove device'
        ));
      }
    },
  });

  // ==================== PATCH /api/devices/:id ====================
  // Обновить имя устройства
  fastify.patch('/devices/:id', {
    preHandler: authPreHandler,
    handler: async (request, reply) => {
      try {
        const userId = (request as any).user.userId;
        const { id } = request.params as { id: string };
        const { name } = request.body as { name?: string };

        if (!name || typeof name !== 'string') {
          return reply.code(400).send(createProblemDetails(
            'Bad Request',
            400,
            'Device name is required'
          ));
        }

        const updated = await updateDeviceName(userId, id, name);

        return {
          success: true,
          device: {
            id: updated.id,
            device_uuid: updated.deviceId,
            name: updated.name,
            type: updated.type,
            fingerprint: updated.fingerprint,
            last_seen_at: updated.lastSeen ? updated.lastSeen.toISOString() : null,
            verified_at: updated.verifiedAt ? updated.verifiedAt.toISOString() : null,
            created_at: updated.createdAt.toISOString(),
          },
        };
      } catch (error) {
        fastify.log.error({ error: 'Failed to update device', details: error });

        if (error instanceof Error && error.message.includes('not found')) {
          return reply.code(404).send(createProblemDetails(
            'Not Found',
            404,
            error.message
          ));
        }

        if (error instanceof Error && error.message.includes('must be between')) {
          return reply.code(400).send(createProblemDetails(
            'Bad Request',
            400,
            error.message
          ));
        }

        return reply.code(500).send(createProblemDetails(
          'Internal Server Error',
          500,
          error instanceof Error ? error.message : 'Failed to update device'
        ));
      }
    },
  });

   // ==================== POST /api/devices/:id/verification-code ====================
   // Запрашивает код верификации для устройства (децентрализованный флоу)
   // Код генерируется на другом верифицированном онлайн устройстве
   fastify.post('/devices/:id/verification-code', {
     preHandler: authPreHandler,
     handler: async (request, reply) => {
       try {
         const userId = (request as any).user.userId;
         const { id } = request.params as { id: string };

         // Проверяем, что устройство принадлежит пользователю по deviceId (UUID)
         const device = await prisma.device.findFirst({
           where: {
             deviceId: id,
             userId,
             isActive: true,
           },
           select: {
             deviceId: true,
             verifiedAt: true,
             name: true,
             lastCodeRequestAt: true,
             generationCount: true,
           },
         });

         if (!device) {
           return reply.code(404).send(createProblemDetails(
             'Not Found',
             404,
             'Device not found'
           ));
         }

         // Проверяем, что устройство не верифицировано
         if (device.verifiedAt) {
           return reply.code(400).send(createProblemDetails(
             'Bad Request',
             400,
             'Device is already verified'
           ));
         }

         // Проверяем cooldown (1 минута)
         const COOLDOWN_MS = 60 * 1000;
         if (device.lastCodeRequestAt) {
           const timeSinceLastRequest = Date.now() - new Date(device.lastCodeRequestAt).getTime();
           if (timeSinceLastRequest < COOLDOWN_MS) {
             const retryAfter = Math.ceil((COOLDOWN_MS - timeSinceLastRequest) / 1000);
             return reply.code(429).send({
               success: false,
               message: 'Please wait before requesting a new code',
               retryAfter
             });
           }
         }

         // Проверяем лимит генераций (3 попытки)
         const MAX_GENERATIONS = 3;
         if (device.generationCount >= MAX_GENERATIONS) {
           const LOCKOUT_MS = 15 * 60 * 1000; // 15 минут
           await prisma.device.update({
             where: { deviceId: id },
             data: { lockedUntil: new Date(Date.now() + LOCKOUT_MS) }
           });
           return reply.code(429).send(createProblemDetails(
             'Too Many Requests',
             429,
             'Maximum generation limit reached. Device locked for 15 minutes.'
           ));
         }

         // НОВАЯ ЛОГИКА: отправляем команду первому верифицированному онлайн устройству
         const wsManager = request.server.wsManager as WebSocketManager | undefined;
         
         // RC-8 FIX: Ensure wsManager is initialized
         if (!wsManager) {
           fastify.log.error({ userId, deviceId: id, error: 'wsManager not initialized' });
           return reply.code(500).send(createProblemDetails(
             'Internal Server Error',
             500,
             'WebSocket manager not initialized'
           ));
         }
         
         fastify.log.info({ userId, deviceId: id, msg: 'Finding online clients for verification code request' });
         
         const onlineClients = wsManager.getClientsByUserId(userId)
           .filter(client => {
             const clientDevice = client.getDeviceId();
             // Это должно быть верифицированное устройство (не то, которое запрашивает)
             return clientDevice !== id;
           });

         fastify.log.info({ userId, deviceId: id, onlineClientsCount: onlineClients.length, msg: 'Online clients found' });

         if (onlineClients.length === 0) {
           return reply.code(409).send(createProblemDetails(
             'Conflict',
             409,
             'No verified devices online to generate verification code'
           ));
         }

          // Берём первое онлайн устройство (можно добавить логику round-robin)
          const targetClient = onlineClients[0]!;
          fastify.log.info({ userId, deviceId: id, targetClientDevice: targetClient.getDeviceId(), msg: 'Sending verification_request command' });

         // Отправляем команду через Command Bus
         const commandId = randomUUID();
         const commandMessage: CommandMessage = {
           commandId,
           command: 'device.verification_request',
           payload: {
             newDeviceId: id,
             newDeviceName: device.name
           },
           metadata: {
             version: 1,
             issuer: {
               userId,
               deviceId: id,  // Устройство, которое запрашивает код
               signalDeviceId: (request as any).user.signalDeviceId // из JWT claims
             },
             priority: 'high',
             encrypted: false,
             createdAt: Date.now()
           }
         };

         // Отправляем как WebSocket сообщение типа 'command'
         const sent = targetClient.send({
           type: 'command',
           payload: commandMessage
         });
         
         fastify.log.info({ userId, deviceId: id, commandId, sent, msg: 'Command send result' });
         
         if (!sent) {
           return reply.code(500).send(createProblemDetails(
             'Internal Server Error',
             500,
             'Failed to send command to device'
           ));
         }

         // Увеличиваем счётчик запросов (для cooldown)
         await prisma.device.update({
           where: { deviceId: id },
           data: {
             lastCodeRequestAt: new Date(),
             generationCount: { increment: 1 }
           }
         });

         return {
           success: true,
           message: 'Verification command sent to your other device'
         };

       } catch (error) {
         fastify.log.error({ error: 'Failed to request verification code', details: error });
         return reply.code(500).send(createProblemDetails(
           'Internal Server Error',
           500,
           error instanceof Error ? error.message : 'Failed to request verification code'
         ));
       }
     },
   });

   // ==================== POST /api/devices/:id/verify ====================
   // Проверяет код верификации устройства (децентрализованный флоу)
   // Принимает Argon2id хеш кода, сгенерированный на клиенте
   fastify.post('/devices/:id/verify', {
     preHandler: authPreHandler,
     handler: async (request, reply) => {
       try {
         const userId = (request as any).user.userId;
         const { id } = request.params as { id: string };
         const { codeHash } = request.body as { codeHash?: string };

         if (!codeHash || typeof codeHash !== 'string') {
           return reply.code(400).send(createProblemDetails(
             'Bad Request',
             400,
             'codeHash is required'
           ));
         }

         // Находим устройство по deviceId (UUID)
         const device = await prisma.device.findFirst({
           where: {
             deviceId: id,
             userId,
             isActive: true,
           },
           select: {
             deviceId: true,
             verifiedAt: true,
           },
         });

         if (!device) {
           return reply.code(404).send(createProblemDetails(
             'Not Found',
             404,
             'Device not found'
           ));
         }

         // Проверяем код (передаём хеш)
         const result = await verifyCode(userId, device.deviceId, codeHash);

         if (!result.success) {
           return reply.code(400).send(createProblemDetails(
             'Bad Request',
             400,
             result.message,
             'https://zerochat.app/errors/verification-failed'
           ));
         }

         return {
           success: true,
           verified: result.verified,
           device: {
             id,
             device_uuid: device.deviceId,
             verified_at: result.verified ? new Date().toISOString() : null,
           },
         };
       } catch (error) {
         fastify.log.error({ error: 'Failed to verify device', details: error });

         return reply.code(500).send(createProblemDetails(
           'Internal Server Error',
           500,
           error instanceof Error ? error.message : 'Failed to verify device'
         ));
       }
     },
   });

   // ==================== POST /api/devices/:deviceId/verification-code/confirm ====================
   // Подтверждение хеша кода верификации от верифицированного устройства
   fastify.post('/devices/:deviceId/verification-code/confirm', {
     preHandler: authPreHandler,
     handler: async (request, reply) => {
       try {
         const userId = (request as any).user.userId;
         const { deviceId } = request.params as { deviceId: string };
         const { codeHash, newDeviceId } = request.body as { 
           codeHash: string; 
           newDeviceId: string;
         };

         // Валидация
         if (!codeHash || typeof codeHash !== 'string') {
           return reply.code(400).send(createProblemDetails(
             'Bad Request',
             400,
             'codeHash is required'
           ));
         }

         if (!newDeviceId || typeof newDeviceId !== 'string') {
           return reply.code(400).send(createProblemDetails(
             'Bad Request',
             400,
             'newDeviceId is required'
           ));
         }

         // Проверяем, что устройство, отправляющее хеш, является верифицированным
         const verifyingDevice = await prisma.device.findFirst({
           where: { deviceId, userId, isActive: true },
           select: { id: true, verifiedAt: true }
         });

         if (!verifyingDevice || !verifyingDevice.verifiedAt) {
           return reply.code(403).send(createProblemDetails(
             'Forbidden',
             403,
             'Only verified devices can confirm verification codes'
           ));
         }

         // Находим запись ожидающей верификации для нового устройства
         // Новое устройство уже создано в БД при логине, но не верифицировано
         const newDevice = await prisma.device.findFirst({
           where: { 
             deviceId: newDeviceId, 
             userId, 
             isActive: true 
           },
           select: { 
             id: true, 
             verifiedAt: true 
           }
         });

         if (!newDevice) {
           return reply.code(404).send(createProblemDetails(
             'Not Found',
             404,
             'New device not found'
           ));
         }

         if (newDevice.verifiedAt) {
           return reply.code(400).send(createProblemDetails(
             'Bad Request',
             400,
             'Device is already verified'
           ));
         }

         // Инвалидируем предыдущие коды для этого устройства
         await prisma.deviceVerificationCode.updateMany({
           where: {
             deviceId: newDeviceId,
             usedAt: null,
             expiresAt: { gt: new Date() }
           },
           data: { usedAt: new Date() }
         });

         // Создаём новую запись с хешем
         const expiresAt = new Date(Date.now() + 3 * 60 * 1000); // 3 минуты
         await prisma.deviceVerificationCode.create({
           data: {
             userId,
             deviceId: newDeviceId,
             codeHash,  // Сохраняем хеш, а не открытый код
             expiresAt,
           },
         });

         // Обновляем счётчик запросов (для cooldown) на устройстве, которое запросило код
         await prisma.device.update({
           where: { deviceId: newDeviceId },
           data: {
             lastCodeRequestAt: new Date()
           }
         });

         return { success: true };
       } catch (error) {
         fastify.log.error({ error: 'Failed to confirm verification code', details: error });
         
         return reply.code(500).send(createProblemDetails(
           'Internal Server Error',
           500,
           error instanceof Error ? error.message : 'Failed to confirm verification code'
         ));
       }
     },
   });

   // ==================== GET /api/devices/pending-verifications ====================
   // Получить список устройств, ожидающих верификации
   fastify.get('/devices/pending-verifications', {
    preHandler: authPreHandler,
    handler: async (request, reply) => {
      try {
        const userId = (request as any).user.userId;

        const pendingVerifications = await getPendingVerifications(userId);

        return {
          success: true,
          devices: pendingVerifications.map(v => ({
            id: v.id,
            device_id: v.deviceId,
            device_name: v.device?.name || 'Unknown Device',
            device_type: v.device?.type || 'WEB',
            fingerprint: v.device?.fingerprint || null,
            last_seen_at: v.device?.lastSeen?.toISOString() || null,
            created_at: v.createdAt.toISOString(),
            expires_at: v.expiresAt.toISOString(),
          })),
        };
      } catch (error) {
        fastify.log.error({ error: 'Failed to get pending verifications', details: error });

        return reply.code(500).send(createProblemDetails(
          'Internal Server Error',
          500,
          error instanceof Error ? error.message : 'Failed to get pending verifications'
        ));
      }
    },
  });
};
