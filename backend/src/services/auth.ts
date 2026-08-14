import { prisma } from '../prisma/client';
import { hashPassword, verifyPassword, isPasswordStrong } from '../utils/password';
import {
  generateAccessToken,
  generateRefreshTokenInTx,
  revokeRefreshToken,
  refreshTokenRotation,
  getUserSessions
} from '../utils/jwt';
import { AuthResult, TokenPair } from '../types';
import { sendNewLoginNotification } from './system-chat.js';

export interface AuthResultWithTokens extends AuthResult {
  tokens: TokenPair;
  deviceId: string;
  deviceNeedsVerification: boolean;
}

/**
 * Генерирует device ID для нового устройства/сессии
 */
function generateDeviceId(): string {
  return `dev_${crypto.randomUUID()}`;
}

/**
 * Регистрирует нового пользователя и создаёт initial токены
 * SECURITY: All operations wrapped in transaction for data integrity
 */
export async function registerUser(
  username: string,
  password: string,
  displayName?: string
): Promise<AuthResultWithTokens> {
  // Проверяем, существует ли пользователь (только по username)
  const existingUser = await prisma.user.findUnique({
    where: { username },
  });

  if (existingUser) {
    throw new Error('Username already exists');
  }

  // Проверяем сложность пароля
  const passwordValidation = await isPasswordStrong(password);
  if (!passwordValidation.isValid) {
    throw new Error(`Password validation failed: ${passwordValidation.errors.join(', ')}`);
  }

  // Хешируем пароль
  const hashedPassword = await hashPassword(password);

  // Генерируем device ID
  const deviceId = generateDeviceId();

  // Выполняем все операции в транзакции
  const result = await prisma.$transaction(async (tx) => {
    // Создаём пользователя
    const user = await tx.user.create({
      data: {
        username,
        displayName: displayName || username,
        password: hashedPassword,
      },
      select: {
        id: true,
        username: true,
        displayName: true,
        createdAt: true,
      },
    });

    // Создаём refresh token внутри транзакции
    const refreshTokenResult = await generateRefreshTokenInTx(tx, user.id, deviceId);

     // Создаём запись об устройстве (автоматически верифицированное, так как это первое устройство)
     await tx.device.create({
       data: {
         deviceId,
         userId: user.id,
         name: 'This Device',
         type: 'WEB',
         lastSeen: new Date(),
         isActive: true,
         verifiedAt: new Date(),
       },
     });

    // Создаём чат избранного
    await tx.chat.create({
      data: {
        type: 'FAVORITES',
        name: 'Избранное',
        isGroup: false,
        createdById: user.id,
        chatUsers: {
          create: [
            { userId: user.id, role: 'OWNER' },
          ],
        },
      },
    });

    return { user, refreshTokenResult };
  });

  const accessToken = generateAccessToken({
    userId: result.user.id,
    username: result.user.username,
    deviceId,
  });

  const expiresIn = 15 * 60; // 15 минут в секундах

  return {
    user: {
      id: result.user.id,
      username: result.user.username,
      displayName: result.user.displayName ?? '',
      createdAt: result.user.createdAt.toISOString(),
    },
    tokens: {
      accessToken,
      refreshToken: result.refreshTokenResult.token,
      expiresIn,
      tokenId: result.refreshTokenResult.tokenId,
    },
    deviceId,
    deviceNeedsVerification: false, // First device is auto-verified
  };
}

/**
 * Аутентифицирует пользователя и создаёт токены.
 *
 * DEVICE VERIFICATION FLOW (security-critical):
 *
 *   1. If the supplied `deviceId` (client-generated UUID stored in
 *      localStorage) is already known AND verified → reuse it,
 *      return `deviceNeedsVerification: false`. User logged in from
 *      the same device.
 *
 *   2. If the supplied `deviceId` is unknown AND the user has NO
 *      verified devices yet (first login after registration, or all
 *      devices were lost) → create a new device auto-verified
 *      (`verifiedAt: now`). User passed password auth and has no
 *      other device to verify through.
 *
 *   3. If the supplied `deviceId` is unknown AND the user HAS at
 *      least one verified device → create a new device with
 *      `verifiedAt: null` and return `deviceNeedsVerification: true`.
 *      The user must complete verification through an existing
 *      verified device via `/devices/:id/verify` (device verification
 *      code flow). This is the "login from a new device" case that
 *      MUST NOT be auto-verified.
 *
 *   4. If the supplied `deviceId` is already known but NOT verified
 *      (e.g. user retried login before completing verification) →
 *      reuse it, return `deviceNeedsVerification: true`. Do not
 *      re-issue a verification code on every retry (the existing
 *      code is still valid within its 3-minute window).
 *
 * SECURITY: The previous implementation always created a new device
 * with `verifiedAt: null` via `upsert`, which deadlocked single-
 * device users (they could never publish keys or connect WS). The
 * new logic preserves verified status across logins from the same
 * device and only requires verification for genuinely new devices.
 */
export async function loginUser(
  username: string,
  password: string,
  deviceId?: string,
  ip?: string
): Promise<AuthResultWithTokens> {
  // Ищем пользователя по username
  const user = await prisma.user.findUnique({
    where: { username },
  });

  if (!user) {
    throw new Error('Invalid credentials');
  }

  // Проверяем пароль
  const isPasswordValid = await verifyPassword(password, user.password);
  if (!isPasswordValid) {
    throw new Error('Invalid credentials');
  }

  // Определяем device ID — клиент генерирует UUID и хранит в localStorage.
  // Если не передан (старый клиент), генерируем сервер-side. В этом случае
  // устройство всегда считается "новым" и проходит verification flow.
  const actualDeviceId = deviceId || generateDeviceId();

  // Найти все активные устройства пользователя, отсортированные по
  // lastSeen DESC (самое свежее — первым). Это позволяет нам решить,
  // является ли текущий deviceId известным/верифицированным.
  const existingDevices = await prisma.device.findMany({
    where: { userId: user.id, isActive: true },
    orderBy: { lastSeen: 'desc' },
  });

  // Проверяем, известен ли этот deviceUuid пользователю
  const knownDevice = existingDevices.find(d => d.deviceId === actualDeviceId);

  let finalDevice: { deviceId: string; verifiedAt: Date | null; name: string };
  let deviceNeedsVerification: boolean;

  if (knownDevice) {
    // Сценарий 1 или 4: тот же deviceUuid, что и раньше.
    // Переиспользуем существующую запись, сохраняем verifiedAt, обновляем lastSeen.
    const updated = await prisma.device.update({
      where: { deviceId: actualDeviceId },
      data: {
        lastSeen: new Date(),
        isActive: true,
      },
    });
    finalDevice = {
      deviceId: updated.deviceId,
      verifiedAt: updated.verifiedAt,
      name: updated.name,
    };
    deviceNeedsVerification = updated.verifiedAt === null;
  } else {
    // Новый deviceUuid. Проверяем, есть ли у пользователя уже
    // верифицированные устройства.
    const hasVerifiedDevices = existingDevices.some(d => d.verifiedAt !== null);

    if (!hasVerifiedDevices) {
      // Сценарий 2: верифицированных устройств нет (первый логин после
      // регистрации, либо все устройства потеряны). Пользователь прошёл
      // password auth — нет другого устройства для verification flow.
      // Создаём новое устройство сразу verified.
      const created = await prisma.device.create({
        data: {
          deviceId: actualDeviceId,
          userId: user.id,
          name: 'This Device',
          type: 'WEB',
          lastSeen: new Date(),
          isActive: true,
          verifiedAt: new Date(),
        },
      });
      finalDevice = {
        deviceId: created.deviceId,
        verifiedAt: created.verifiedAt,
        name: created.name,
      };
      deviceNeedsVerification = false;
    } else {
      // Сценарий 3: у пользователя ЕСТЬ верифицированные устройства, но
      // текущий deviceUuid новый. Это "логин с нового устройства" —
      // ТРЕБУЕТСЯ верификация через существующее устройство.
      // НЕ auto-verify. Пользователь должен получить device verification
      // code и подтвердить его через `/devices/:id/verify`.
      //
      // DEV SHORTCUT: when SKIP_DEVICE_VERIFICATION=true is set in the
      // environment (e.g. for local E2E tests), we skip the verification
      // flow and auto-verify the new device. This is intentional —
      // browser test contexts can't receive verification codes on
      // other devices.
      const skipVerify = process.env['SKIP_DEVICE_VERIFICATION'] === 'true';
      const created = await prisma.device.create({
        data: {
          deviceId: actualDeviceId,
          userId: user.id,
          name: 'This Device',
          type: 'WEB',
          lastSeen: new Date(),
          isActive: true,
          verifiedAt: skipVerify ? new Date() : null,
        },
      });
      finalDevice = {
        deviceId: created.deviceId,
        verifiedAt: created.verifiedAt,
        name: created.name,
      };
      deviceNeedsVerification = !skipVerify;
    }
  }

  // Создаём refresh token. Используем prisma напрямую — generateRefreshTokenInTx
  // принимает TransactionClient-совместимый объект (Omit<$transaction|$connect|...>),
  // а PrismaClient ему удовлетворяет.
  const refreshTokenResult = await generateRefreshTokenInTx(
    prisma as unknown as Parameters<typeof generateRefreshTokenInTx>[0],
    user.id,
    actualDeviceId,
  );

  // Обновляем статус пользователя на ONLINE
  await prisma.user.update({
    where: { id: user.id },
    data: { status: 'ONLINE' },
  });

  const accessToken = generateAccessToken({
    userId: user.id,
    username: user.username,
    deviceId: actualDeviceId,
  });

  const expiresIn = 15 * 60; // 15 минут в секундах

  // Отправляем уведомление о новом входе для неподтверждённых устройств.
  // sendNewLoginNotification также запускает генерацию device verification code,
  // который доставляется на существующие верифицированные устройства.
  if (deviceNeedsVerification) {
    await sendNewLoginNotification(user.id, actualDeviceId, finalDevice.name, ip);
  }

  return {
    user: {
      id: user.id,
      username: user.username,
      displayName: user.displayName ?? '',
      createdAt: user.createdAt.toISOString(),
    },
    tokens: {
      accessToken,
      refreshToken: refreshTokenResult.token,
      expiresIn,
      tokenId: refreshTokenResult.tokenId,
    },
    deviceId: actualDeviceId,
    deviceNeedsVerification,
  };
}

/**
 * Выполняет logout - отзывает refresh токен
 */
export async function logoutUser(tokenId: string): Promise<void> {
  if (tokenId) {
    await revokeRefreshToken(tokenId);
  }
}

/**
 * Выполняет refresh token rotation
 */
export async function refreshTokens(
  oldRefreshToken: string
): Promise<TokenPair & { deviceId?: string; deviceNeedsVerification?: boolean }> {
  return refreshTokenRotation(oldRefreshToken);
}

/**
 * Получает информацию о пользователе по ID
 */
export async function getUserById(id: string) {
  return prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      username: true,
      displayName: true,
      avatar: true,
      status: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

/**
 * Обновляет статус пользователя
 */
export async function updateUserStatus(userId: string, status: string) {
  return prisma.user.update({
    where: { id: userId },
    data: { status: status as any },
  });
}

/**
 * Получает все активные сессии пользователя
 */
export async function getUserActiveSessions(userId: string) {
  return getUserSessions(userId);
}

/**
 * Дерегистрирует устройство - удаляет Signal ключи пользователя с сервера
 * Используется при полном logout с устройства
 */
export async function unregisterDevice(userId: string, deviceId?: string): Promise<void> {
  try {
    // Находим DeviceKeys для пользователя
    const deviceKeys = await prisma.deviceKeys.findMany({
      where: { userId },
    });
    
    for (const dk of deviceKeys) {
      // Если указан deviceId, удаляем только соответствующие ключи
      if (deviceId && dk.deviceId !== deviceId) {
        continue;
      }
      
      // Удаляем one-time prekeys
      await prisma.oneTimePreKey.deleteMany({
        where: { deviceKeysId: dk.id },
      });
      
      // Удаляем PQ one-time prekeys
      await prisma.pqOneTimePreKey.deleteMany({
        where: { deviceKeysId: dk.id },
      });
      
      // Удаляем PQ last resort prekey
      await prisma.pqLastResortPreKey.deleteMany({
        where: { deviceKeysId: dk.id },
      });
      
      // Удаляем DeviceKeys
      await prisma.deviceKeys.delete({
        where: { id: dk.id },
      });
    }
    
    // Удаляем Sender Keys для пользователя
    await prisma.senderKeyDistribution.deleteMany({
      where: { senderUserId: userId },
    });
  } catch (error) {
    console.error('[AUTH] Failed to unregister device:', error);
    throw error;
  }
}
