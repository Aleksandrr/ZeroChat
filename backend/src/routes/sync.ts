/**
 * Sync Routes - API для синхронизации между устройствами
 * 
 * Реализует протокол Sesame для мультидевайсной синхронизации
 * с использованием векторных часов.
 * 
 * @see docs/signal/sesame.md - Sesame protocol specification
 * @see backend/src/services/sync.ts - Sync service implementation
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { verifyAccessToken } from '../utils/jwt';
import { sync, pushEvents, pullEvents } from '../services/sync';
import type { SyncRequest, IncomingSyncEvent, VectorClock } from '../services/sync';
import { createProblemDetails } from '../utils/shared';

// Problem Details RFC 7807


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

export const syncRoutes = async (fastify: FastifyInstance) => {
  // ==================== POST /api/sync ====================
  // Синхронизация с использованием векторных часов (push + pull)
  fastify.post('/sync', {
    preHandler: authPreHandler,
    handler: async (request, reply) => {
      try {
        const userId = (request as any).user.userId;
        const deviceId = (request as any).user.deviceId;
        const body = request.body as SyncRequest;

        // Валидация запроса
        if (!body.vectorClock || typeof body.vectorClock !== 'object') {
          return reply.code(400).send(createProblemDetails(
            'Bad Request',
            400,
            'Vector clock is required'
          ));
        }

        // Выполняем синхронизацию
        const result = await sync(userId, deviceId, body);

        return {
          success: true,
          ...result,
        };
      } catch (error) {
        fastify.log.error({ error: 'Failed to sync', details: error });
        return reply.code(500).send(createProblemDetails(
          'Internal Server Error',
          500,
          error instanceof Error ? error.message : 'Failed to sync'
        ));
      }
    },
  });

  // ==================== POST /api/sync/push ====================
  // Отправка изменений (push)
  fastify.post('/sync/push', {
    preHandler: authPreHandler,
    handler: async (request, reply) => {
      try {
        const userId = (request as any).user.userId;
        const deviceId = (request as any).user.deviceId;
        const body = request.body as { events: IncomingSyncEvent[] };

        // Валидация запроса
        if (!body.events || !Array.isArray(body.events)) {
          return reply.code(400).send(createProblemDetails(
            'Bad Request',
            400,
            'Events array is required'
          ));
        }

        if (body.events.length === 0) {
          return reply.code(400).send(createProblemDetails(
            'Bad Request',
            400,
            'Events array cannot be empty'
          ));
        }

        // Выполняем push
        const result = await pushEvents(userId, deviceId, body.events);

        // Возвращаем результат
        return {
          accepted: result.accepted,
          rejected: result.rejected,
        };
      } catch (error) {
        fastify.log.error({ error: 'Failed to push', details: error });
        return reply.code(500).send(createProblemDetails(
          'Internal Server Error',
          500,
          error instanceof Error ? error.message : 'Failed to push'
        ));
      }
    },
  });

  // ==================== POST /api/sync/pull ====================
  // Получение изменений (pull)
  fastify.post('/sync/pull', {
    preHandler: authPreHandler,
    handler: async (request, reply) => {
      try {
        const userId = (request as any).user.userId;
        const deviceId = (request as any).user.deviceId;
        const body = request.body as { vector_clock: VectorClock };

        // Валидация запроса
        if (!body.vector_clock || typeof body.vector_clock !== 'object') {
          return reply.code(400).send(createProblemDetails(
            'Bad Request',
            400,
            'Vector clock is required'
          ));
        }

        // Выполняем pull
        const result = await pullEvents(userId, deviceId, body.vector_clock);

        // Форматируем ответ согласно спецификации
        return {
          events: result.events.map(event => ({
            event_id: event.id,
            user_id: event.userId,
            device_id: event.deviceId,
            seq: event.seq,
            entity: event.entity,
            entity_id: event.entityId,
            op: event.op,
            version: event.version,
            payload: event.payloadCiphertext,
            server_received_at: event.serverReceivedAt.toISOString(),
          })),
          server_vector_clock: result.serverVectorClock,
        };
      } catch (error) {
        fastify.log.error({ error: 'Failed to pull', details: error });
        return reply.code(500).send(createProblemDetails(
          'Internal Server Error',
          500,
          error instanceof Error ? error.message : 'Failed to pull'
        ));
      }
    },
  });
};
