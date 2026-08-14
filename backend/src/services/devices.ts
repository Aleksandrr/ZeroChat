/**
 * Device Service - Управление устройствами пользователя
 * 
 * Согласно протоколу Sesame:
 * - Каждое устройство имеет уникальный DeviceID
 * - Устройства могут быть верифицированы (verifiedAt)
 * - При удалении устройства отзываются все refresh токены
 * 
 * @see docs/signal/sesame.md - Sesame protocol specification
 */

import { prisma } from '../prisma/client';

export interface DeviceInfo {
  id: string;
  deviceId: string;
  name: string;
  type: string;
  fingerprint: string | null;
  lastSeen: Date | null;
  verifiedAt: Date | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface DeviceListResult {
  devices: DeviceInfo[];
  currentDeviceId: string;
}

/**
 * Получить все устройства пользователя
 * 
 * @param userId - ID пользователя
 * @param currentDeviceId - ID текущего устройства (для отметки is_current на frontend)
 * @returns Список устройств с current_device_id
 */
export async function getUserDevices(
  userId: string,
  currentDeviceId?: string
): Promise<DeviceListResult> {
  const devices = await prisma.device.findMany({
    where: {
      userId,
      isActive: true,
    },
    orderBy: {
      lastSeen: 'desc',
    },
    select: {
      id: true,
      deviceId: true,
      name: true,
      type: true,
      fingerprint: true,
      lastSeen: true,
      verifiedAt: true,
      isActive: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return {
    devices: devices.map(d => ({
      id: d.id,
      deviceId: d.deviceId,
      name: d.name,
      type: d.type,
      fingerprint: d.fingerprint,
      lastSeen: d.lastSeen,
      verifiedAt: d.verifiedAt,
      isActive: d.isActive,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    })),
    currentDeviceId: currentDeviceId || '',
  };
}

/**
 * Удалить устройство (выход с устройства)
 * 
 * Согласно Sesame: при удалении устройства необходимо:
 * 1. Отозвать все refresh токены устройства
 * 2. Пометить устройство как неактивное
 * 3. Удалить Signal Protocol ключи устройства
 * 
 * SECURITY: All operations wrapped in transaction for data integrity
 * 
 * @param userId - ID пользователя (для проверки владения)
 * @param deviceId - ID устройства (cuid, не device_uuid)
 */
export async function removeDevice(
  userId: string,
  deviceId: string
): Promise<void> {
  // Находим устройство и проверяем владельца
  const device = await prisma.device.findFirst({
    where: {
      id: deviceId,
      userId,
    },
    include: {
      user: {
        include: {
          devices: true,
        },
      },
    },
  });

  if (!device) {
    throw new Error('Device not found or access denied');
  }

  // Нельзя удалить последнее активное устройство
  const activeDevicesCount = device.user.devices.filter(d => d.isActive).length;
  if (activeDevicesCount <= 1) {
    throw new Error('Cannot remove the last active device');
  }

  // Получаем pending-сообщения для этого устройства.
  // FIX: previously used findMany({where:{encrypted:true}}) which fetched
  // ALL encrypted messages in the DB and filtered in JS. Now uses a
  // raw SQL query with JSONB path operator for an indexed lookup.
  const pendingMessages = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM messages
    WHERE metadata->>'pendingDeviceId' = ${device.deviceId}
  `;
  const messagesToDelete = pendingMessages.map(m => m.id);

  // Выполняем все операции в одной транзакции для целостности данных
  await prisma.$transaction(async (tx) => {
    // 1. Отзываем все refresh токены устройства
    await tx.refreshToken.updateMany({
      where: {
        deviceId: device.deviceId,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
      },
    });

    // 2. Удаляем Signal Protocol ключи устройства
    await tx.oneTimePreKey.deleteMany({
      where: {
        deviceKeys: {
          deviceId: device.deviceId,
        },
      },
    });

    await tx.pqOneTimePreKey.deleteMany({
      where: {
        deviceKeys: {
          deviceId: device.deviceId,
        },
      },
    });

    await tx.pqLastResortPreKey.deleteMany({
      where: {
        deviceKeys: {
          deviceId: device.deviceId,
        },
      },
    });

    await tx.deviceKeys.deleteMany({
      where: {
        deviceId: device.deviceId,
      },
    });

    // 3. Удаляем все pending-сообщения для этого устройства
    if (messagesToDelete.length > 0) {
      await tx.message.deleteMany({
        where: {
          id: { in: messagesToDelete },
        },
      });
      console.log(`[removeDevice] Deleted ${messagesToDelete.length} pending messages for device ${device.deviceId}`);
    }

    // 4. Помечаем устройство как неактивное вместо удаления
    // (для сохранения истории и соответствия Sesame stale records)
    await tx.device.update({
      where: { id: deviceId },
      data: {
        isActive: false,
      },
    });
  });
}

/**
 * Обновить время последней активности устройства
 * 
 * @param deviceUuid - UUID устройства (device_uuid/deviceId в схеме)
 */
export async function updateLastSeen(deviceUuid: string): Promise<void> {
  await prisma.device.update({
    where: { deviceId: deviceUuid },
    data: { lastSeen: new Date() },
  });
}

/**
 * Sanitize device name to prevent XSS and injection attacks
 * Only allows alphanumeric characters, spaces, hyphens, and underscores
 * 
 * @param name - Raw device name
 * @returns Sanitized name
 */
function sanitizeDeviceName(name: string): string {
  // Remove any HTML/script tags
  let sanitized = name.replace(/<[^>]*>/g, '');
  // Only allow alphanumeric, spaces, hyphens, underscores, and common punctuation
  sanitized = sanitized.replace(/[^a-zA-Z0-9\s\-_.,!?()]/g, '');
  // Collapse multiple spaces into one
  sanitized = sanitized.replace(/\s+/g, ' ');
  return sanitized;
}

/**
 * Обновить имя устройства
 * 
 * @param userId - ID пользователя (для проверки владения)
 * @param deviceId - ID устройства (cuid)
 * @param name - Новое имя устройства
 */
export async function updateDeviceName(
  userId: string,
  deviceId: string,
  name: string
): Promise<DeviceInfo> {
  // Проверяем владение устройством
  const device = await prisma.device.findFirst({
    where: {
      id: deviceId,
      userId,
      isActive: true,
    },
  });

  if (!device) {
    throw new Error('Device not found or access denied');
  }

  // Валидация и санитизация имени
  const trimmedName = name.trim();
  if (trimmedName.length === 0 || trimmedName.length > 50) {
    throw new Error('Device name must be between 1 and 50 characters');
  }

  // Sanitize to prevent XSS
  const sanitizedName = sanitizeDeviceName(trimmedName);
  if (sanitizedName.length === 0) {
    throw new Error('Device name contains only invalid characters');
  }

  const updated = await prisma.device.update({
    where: { id: deviceId },
    data: { name: sanitizedName },
    select: {
      id: true,
      deviceId: true,
      name: true,
      type: true,
      fingerprint: true,
      lastSeen: true,
      verifiedAt: true,
      isActive: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return updated;
}

/**
 * Получить устройство по UUID
 * 
 * @param deviceUuid - UUID устройства
 * @returns Устройство или null
 */
export async function getDeviceByUuid(deviceUuid: string): Promise<DeviceInfo | null> {
  const device = await prisma.device.findUnique({
    where: { deviceId: deviceUuid },
    select: {
      id: true,
      deviceId: true,
      name: true,
      type: true,
      fingerprint: true,
      lastSeen: true,
      verifiedAt: true,
      isActive: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return device;
}

/**
 * Проверить, принадлежит ли устройство пользователю
 * 
 * @param userId - ID пользователя
 * @param deviceUuid - UUID устройства
 * @returns true если устройство принадлежит пользователю
 */
export async function isDeviceOwnedByUser(
  userId: string,
  deviceUuid: string
): Promise<boolean> {
  const device = await prisma.device.findFirst({
    where: {
      deviceId: deviceUuid,
      userId,
      isActive: true,
    },
    select: { id: true },
  });

  return !!device;
}
