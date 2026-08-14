/**
 * Device Verification Service - Сервис верификации новых устройств
 *
 * Реализует протокол верификации устройств 6-значным кодом согласно Задаче 3.2.
 * 
 * Ограничения:
 * - Время жизни кода: 3 минуты
 * - Cooldown между запросами: 1 минута
 * - Максимум генераций кода для устройства: 3
 * - Максимум попыток ввода: 3
 * - Блокировка после исчерпания генераций: 15 минут
 *
 * @see plans/этап-3-мультидевайс-и-синхронизация.md - Задача 3.2
 */

import { prisma } from '../prisma/client';
import { timingSafeEqual } from 'node:crypto';

// Configuration constants
const MAX_VERIFICATION_ATTEMPTS = 3;
const MAX_GENERATIONS = 3;
const LOCKOUT_MS = 15 * 60 * 1000;

/**
 * Constant-time string comparison to prevent timing attacks.
 * Returns true if a === b, false otherwise. Both strings must be
 * the same encoding (UTF-8). Uses crypto.timingSafeEqual internally.
 */
function constantTimeCompare(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf-8');
  const bufB = Buffer.from(b, 'utf-8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export interface PendingVerification {
  id: string;
  userId: string;
  deviceId: string;
  createdAt: Date;
  expiresAt: Date;
  attempts: number;
  device?: {
    name: string;
    type: string;
    fingerprint: string | null;
    lastSeen: Date | null;
  };
}

export interface VerificationResult {
  success: boolean;
  verified: boolean;
  message?: string;
  attemptsRemaining?: number;
  lockedUntil?: number; // секунды до разблокировки
}


/**
 * Проверяет код верификации (децентрализованный флоу)
 * Вызывается на новом устройстве при попытке верификации
 * Принимает Argon2id хеш кода (сгенерированный на клиенте) и сравнивает напрямую
 *
 * Ограничения:
 * - Максимум 3 попытки ввода
 * - После исчерпания попыток - блокировка на 15 минут
 *
 * @param userId - ID пользователя
 * @param deviceId - UUID устройства
 * @param codeHash - Argon2id хеш введённого кода (hex string)
 * @returns Результат верификации
 */
export async function verifyCode(
  userId: string,
  deviceId: string,
  codeHash: string
): Promise<VerificationResult> {
  // Проверяем блокировку устройства
  const device = await prisma.device.findUnique({
    where: { deviceId },
    select: {
      lockedUntil: true,
      verifiedAt: true
    }
  });

  if (device?.lockedUntil && new Date(device.lockedUntil) > new Date()) {
    const retryAfter = Math.ceil((new Date(device.lockedUntil).getTime() - Date.now()) / 1000);
    return {
      success: false,
      verified: false,
      message: `Device is locked. Try again in ${retryAfter} seconds`,
      lockedUntil: retryAfter
    };
  }

  // Находим активный код верификации
  const verification = await prisma.deviceVerificationCode.findFirst({
    where: {
      userId,
      deviceId,
      expiresAt: { gt: new Date() },
      usedAt: null,
    },
  });

  if (!verification) {
    return {
      success: false,
      verified: false,
      message: 'Verification code not found or expired',
    };
  }

  // Проверяем количество попыток
  if (verification.attempts >= MAX_VERIFICATION_ATTEMPTS) {
    return {
      success: false,
      verified: false,
      message: 'Too many failed attempts',
      attemptsRemaining: 0,
    };
  }

  // SECURITY: Use constant-time comparison to prevent timing attacks.
  // The client sends the hash of the code (not the plaintext code),
  // and we compare it to the stored hash using timingSafeEqual.
  const isValid = constantTimeCompare(codeHash, verification.codeHash);

  if (isValid) {
    // Код верный - верифицируем устройство
    await Promise.all([
      // Помечаем устройство как верифицированное и сбрасываем счётчики
      prisma.device.update({
        where: { deviceId },
        data: { 
          verifiedAt: new Date(),
          // Сбрасываем счётчики после успешной верификации
          lastCodeRequestAt: null,
          lockedUntil: null,
          generationCount: 0,
          failedAttempts: 0
        },
      }),
      // Удаляем все коды верификации для этого устройства
      prisma.deviceVerificationCode.deleteMany({
        where: { deviceId },
      }),
    ]);

    return {
      success: true,
      verified: true,
      message: 'Device verified successfully',
    };
  } else {
    // Код неверный - увеличиваем счетчик попыток
    const newAttempts = verification.attempts + 1;
    const attemptsRemaining = Math.max(0, MAX_VERIFICATION_ATTEMPTS - newAttempts);

    await prisma.deviceVerificationCode.update({
      where: { id: verification.id },
      data: { attempts: newAttempts },
    });

    // Если исчерпаны попытки - устанавливаем блокировку
    if (newAttempts >= MAX_VERIFICATION_ATTEMPTS) {
      // Проверяем общее количество генераций
      const deviceInfo = await prisma.device.findUnique({
        where: { deviceId },
        select: { generationCount: true }
      });

      // Если было больше MAX_GENERATIONS попыток генерации - блокируем
      if (deviceInfo && deviceInfo.generationCount >= MAX_GENERATIONS) {
        const lockedUntil = new Date(Date.now() + LOCKOUT_MS);
        await prisma.device.update({
          where: { deviceId },
          data: { lockedUntil }
        });

        return {
          success: false,
          verified: false,
          message: 'Maximum attempts exceeded. Device locked for 15 minutes.',
          attemptsRemaining: 0,
          lockedUntil: Math.ceil(LOCKOUT_MS / 1000)
        };
      }
    }

    return {
      success: false,
      verified: false,
      message: 'Invalid verification code',
      attemptsRemaining,
    };
  }
}

/**
 * Получить список pending верификаций для пользователя
 * Используется для отображения уведомлений о новых устройствах
 *
 * @param userId - ID пользователя
 * @returns Список ожидающих верификации устройств
 */
export async function getPendingVerifications(
  userId: string
): Promise<PendingVerification[]> {
  const verifications = await prisma.deviceVerificationCode.findMany({
    where: {
      userId,
      expiresAt: { gt: new Date() },
      usedAt: null,
    },
    select: {
      id: true,
      userId: true,
      deviceId: true,
      createdAt: true,
      expiresAt: true,
      attempts: true,
      device: {
        select: {
          name: true,
          type: true,
          fingerprint: true,
          lastSeen: true,
        },
      },
    },
    orderBy: {
      createdAt: 'desc',
    },
  });

  return verifications.map(v => ({
    id: v.id,
    userId: v.userId,
    deviceId: v.deviceId,
    createdAt: v.createdAt,
    expiresAt: v.expiresAt,
    attempts: v.attempts,
    device: v.device,
  }));
}

/**
 * Проверяет, требуется ли верификация для устройства
 * Используется при логине - если у пользователя есть verified устройства,
 * то новое устройство требует верификации
 *
 * @param userId - ID пользователя
 * @param deviceId - UUID устройства
 * @returns true если верификация требуется
 */
export async function requiresVerification(
  userId: string,
  deviceId: string
): Promise<boolean> {
  // Проверяем, есть ли уже верифицированные устройства у пользователя
  const verifiedDevicesCount = await prisma.device.count({
    where: {
      userId,
      verifiedAt: { not: null },
      isActive: true,
    },
  });

  // Если нет верифицированных устройств - автоматически верифицируем первое
  if (verifiedDevicesCount === 0) {
    await prisma.device.update({
      where: { deviceId },
      data: { verifiedAt: new Date() },
    });
    return false;
  }

  // Проверяем, уже ли верифицировано это устройство
  const device = await prisma.device.findUnique({
    where: { deviceId },
    select: { verifiedAt: true },
  });

  return !device?.verifiedAt;
}

/**
 * Очищает истекшие коды верификации
 * Должно вызываться периодически (например, cron job)
 */
export async function cleanupExpiredCodes(): Promise<void> {
  await prisma.deviceVerificationCode.deleteMany({
    where: {
      expiresAt: { lt: new Date() },
    },
  });
}
