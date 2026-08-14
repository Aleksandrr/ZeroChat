import jwt from 'jsonwebtoken';
import { prisma } from '../prisma/client';
import { JWTPayload, TokenPair } from '../types';
import { PrismaClient } from '@prisma/client';
import { hashSecret, verifySecret } from './password';

// NOTE: refresh tokens are hashed via `hashSecret`/`verifySecret` from
// `utils/password.ts`, which uses argon2id (64MB / 3 iterations / 4 lanes,
// OWASP 2023). Previously `argon2.hash()` was called directly with default
// options — routing through `hashSecret` keeps the KDF parameters
// consistent with password hashing and makes it easier to audit.

/**
 * SECURITY: JWT signing/verification secret.
 *
 * In development we keep a fallback so local servers boot without
 * extra env configuration. In production the secret MUST be set
 * (and ≥ 32 chars — enforced by `utils/secrets-check.ts` at process
 * start). Throwing at import-time is the last line of defence — if
 * a production deployment somehow skips `secrets-check.ts`, the
 * process will refuse to start rather than sign tokens with a
 * well-known default.
 */
function resolveJwtSecret(): string {
  const val = process.env['JWT_SECRET'];
  if (val) return val;
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('JWT_SECRET must be set in production');
  }
  return 'your-secret-key-change-in-production';
}

const JWT_SECRET = resolveJwtSecret();
const JWT_EXPIRES_IN = process.env["JWT_EXPIRES_IN"] || '15m'; // Access token: 15 минут
const REFRESH_TOKEN_EXPIRES_IN = process.env["REFRESH_TOKEN_EXPIRES_IN"] || '7d'; // Refresh token: 7 дня

// Type for transaction client
type TransactionClient = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

/**
 * Генерирует access token JWT
 */
export function generateAccessToken(payload: Omit<JWTPayload, 'iat' | 'exp' | 'tokenId'>): string {
  const tokenPayload: JWTPayload = {
    ...payload,
    tokenId: '', // Access token не привязан к refresh токену
  };
  
  return jwt.sign(tokenPayload, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN,
  } as jwt.SignOptions);
}

/**
 * Генерирует refresh token и сохраняет его хеш в БД
 * SECURITY: Token hash stored instead of plain token for security
 */
export async function generateRefreshToken(
  userId: string,
  deviceId?: string,
  familyId?: string
): Promise<{ token: string; tokenId: string; expiresAt: Date; familyId: string }> {
  const tokenId = crypto.randomUUID();
  const tokenFamilyId = familyId || crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 дней
  
  const refreshToken = jwt.sign(
    { userId, deviceId, tokenId, familyId: tokenFamilyId },
    JWT_SECRET,
    { expiresIn: REFRESH_TOKEN_EXPIRES_IN } as jwt.SignOptions
  );

  // Хешируем токен перед сохранением в БД
  const tokenHash = await hashSecret(refreshToken);

  // Сохраняем хеш в БД (токен не сохраняется)
  await prisma.refreshToken.create({
    data: {
      id: tokenId,
      tokenHash,
      userId,
      deviceId: deviceId || null,
      familyId: tokenFamilyId,
      expiresAt,
    },
  });

  return { token: refreshToken, tokenId, expiresAt, familyId: tokenFamilyId };
}

/**
 * Генерирует refresh token внутри существующей транзакции
 * SECURITY: Token hash stored instead of plain token for security
 * 
 * @param tx - Prisma transaction client
 * @param userId - User ID
 * @param deviceId - Device ID (optional)
 * @param familyId - Token family ID for leak detection (optional, auto-generated if not provided)
 */
export async function generateRefreshTokenInTx(
  tx: TransactionClient,
  userId: string,
  deviceId?: string,
  familyId?: string
): Promise<{ token: string; tokenId: string; expiresAt: Date; familyId: string }> {
  const tokenId = crypto.randomUUID();
  const tokenFamilyId = familyId || crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 дней
  
  const refreshToken = jwt.sign(
    { userId, deviceId, tokenId, familyId: tokenFamilyId },
    JWT_SECRET,
    { expiresIn: REFRESH_TOKEN_EXPIRES_IN } as jwt.SignOptions
  );

  // Хешируем токен перед сохранением в БД
  const tokenHash = await hashSecret(refreshToken);

  // Сохраняем хеш в БД через транзакцию
  await tx.refreshToken.create({
    data: {
      id: tokenId,
      tokenHash,
      userId,
      deviceId: deviceId || null,
      familyId: tokenFamilyId,
      expiresAt,
    },
  });

  return { token: refreshToken, tokenId, expiresAt, familyId: tokenFamilyId };
}

/**
 * Верифицирует access token
 */
export function verifyAccessToken(token: string): JWTPayload {
  try {
    return jwt.verify(token, JWT_SECRET) as JWTPayload;
  } catch (error) {
    throw new Error('Invalid access token');
  }
}

/**
 * Верифицирует refresh token и проверяет его хеш в БД
 * SECURITY: Compares token hash instead of plain token
 */
export async function verifyRefreshToken(
  refreshToken: string
): Promise<{ tokenId: string; userId: string; deviceId?: string; familyId: string }> {
  try {
    const decoded = jwt.verify(refreshToken, JWT_SECRET) as JWTPayload & { tokenId: string; familyId?: string };
    
    // Проверяем что токен существует в БД и не отозван
    const storedToken = await prisma.refreshToken.findUnique({
      where: { id: decoded.tokenId },
    });

    if (!storedToken) {
      throw new Error('Refresh token not found');
    }

    if (storedToken.revokedAt) {
      throw new Error('Refresh token has been revoked');
    }

    if (storedToken.expiresAt < new Date()) {
      throw new Error('Refresh token has expired');
    }

    // Проверяем хеш токена (предпочтительно) или plain token для обратной совместимости
    if (storedToken.tokenHash) {
      const isValid = await verifySecret(storedToken.tokenHash, refreshToken);
      if (!isValid) {
        throw new Error('Invalid refresh token');
      }
    } else if (storedToken.token !== refreshToken) {
      // Fallback для старых токенов без хеша
      throw new Error('Invalid refresh token');
    }

    return {
      tokenId: decoded.tokenId,
      userId: decoded.userId,
      deviceId: decoded.deviceId ?? '',
      familyId: storedToken.familyId,
    };
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error('Invalid refresh token');
  }
}

/**
 * Отзывает refresh token (добавляет revokedAt)
 */
export async function revokeRefreshToken(tokenId: string): Promise<void> {
  await prisma.refreshToken.update({
    where: { id: tokenId },
    data: { revokedAt: new Date() },
  });
}

/**
 * Отзывает все токены пользователя
 */
export async function revokeAllUserTokens(userId: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/**
 * Отзывает токены конкретного устройства
 */
export async function revokeDeviceTokens(userId: string, deviceId: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { userId, deviceId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/**
 * Выполняет refresh token rotation:
 * 1. Декодирует токен и проверяет подпись JWT
 * 2. Проверяет token leak detection (если токен уже отозван и есть активный в семье)
 * 3. Если токен валиден - создаёт НОВЫЕ access + refresh токены и отзывает старый
 * 4. Если токен отозван и есть активный в семье - SECURITY ALERT
 * 
 * SECURITY: Stores token hash instead of plain token
 * SECURITY: Token leak detection - отзывает все токены пользователя при обнаружении утечки
 */
export async function refreshTokenRotation(
  oldRefreshToken: string
): Promise<TokenPair & { deviceId?: string; securityAlert?: boolean }> {
  // 1. Декодируем и проверяем подпись JWT (без проверки в БД)
  let decoded: { tokenId: string; userId: string; deviceId?: string; familyId: string };
  try {
    const jwtDecoded = jwt.verify(oldRefreshToken, JWT_SECRET) as JWTPayload & { tokenId: string; familyId?: string };
    decoded = {
      tokenId: jwtDecoded.tokenId,
      userId: jwtDecoded.userId,
      deviceId: jwtDecoded.deviceId ?? '',
      familyId: '', // Will be set from DB
    };
  } catch {
    throw new Error('Invalid refresh token');
  }

  const { tokenId, userId, deviceId } = decoded;

  // 2. Создаём новую пару токенов в транзакции
  const result = await prisma.$transaction(async (tx: TransactionClient) => {
    // Получаем токен из БД
    const storedToken = await tx.refreshToken.findUnique({
      where: { id: tokenId },
    });

    if (!storedToken) {
      throw new Error('Refresh token not found');
    }

    if (storedToken.expiresAt < new Date()) {
      throw new Error('Refresh token has expired');
    }

    // Проверяем хеш токена
    if (storedToken.tokenHash) {
      const isValid = await verifySecret(storedToken.tokenHash, oldRefreshToken);
      if (!isValid) {
        throw new Error('Invalid refresh token');
      }
    }

    const familyId = storedToken.familyId;

    // Проверяем token leak detection
    // Если токен уже отозван и в семье есть активный токен - это утечка
    if (storedToken.revokedAt) {
      const activeInFamily = await tx.refreshToken.findFirst({
        where: {
          familyId,
          revokedAt: null,
          id: { not: tokenId },
        },
      });

      if (activeInFamily) {
        // SECURITY: Token leak detected! Отзываем ВСЕ токены пользователя
        console.warn(`[SECURITY] Token leak detected for user ${userId}, family ${familyId}. Revoking all tokens.`);
        
        await tx.refreshToken.updateMany({
          where: { userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        
        throw new Error('SECURITY_ALERT: Token leak detected. All tokens revoked.');
      }

      // Токен отозван, но нет активного в семье - просто истёкшая сессия
      throw new Error('Refresh token has been revoked');
    }

    // Отзываем старый refresh token
    await tx.refreshToken.update({
      where: { id: tokenId },
      data: { revokedAt: new Date() },
    });

    // Создаём новый refresh token с ТЕМ ЖЕ familyId
    const newTokenId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const newRefreshToken = jwt.sign(
      { userId, deviceId, tokenId: newTokenId, familyId },
      JWT_SECRET,
      { expiresIn: REFRESH_TOKEN_EXPIRES_IN } as jwt.SignOptions
    );

    // Хешируем новый токен перед сохранением
    const tokenHash = await hashSecret(newRefreshToken);

    await tx.refreshToken.create({
      data: {
        id: newTokenId,
        tokenHash,
        userId,
        deviceId: deviceId || null,
        familyId, // Сохраняем тот же familyId
        expiresAt,
      },
    });

    // Fetch username for access token payload
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { username: true },
    });
    const username = user?.username ?? '';

    // Создаём access token с deviceId и username
    const newAccessToken = generateAccessToken({ userId, username, deviceId: deviceId as string });

     return { newAccessToken, newRefreshToken, newTokenId };
   });

   // Return expiresIn as number of seconds (consistent with login response)
   const expiresInSeconds = 15 * 60; // 15 minutes

   return {
     accessToken: result.newAccessToken,
     refreshToken: result.newRefreshToken,
     expiresIn: expiresInSeconds,
     tokenId: result.newTokenId,
     deviceId: deviceId as string,
   };
}

/**
 * Проверяет валидность refresh token без отзыва
 */
export async function validateRefreshToken(tokenId: string, userId: string): Promise<boolean> {
  try {
    const storedToken = await prisma.refreshToken.findUnique({
      where: { id: tokenId },
    });

    if (!storedToken) {
      return false;
    }

    if (storedToken.revokedAt) {
      return false;
    }

    if (storedToken.expiresAt < new Date()) {
      return false;
    }

    return storedToken.userId === userId;
  } catch {
    return false;
  }
}

/**
 * Проверяет истечение токена без верификации
 */
export function isTokenExpired(token: string): boolean {
  try {
    const decoded = jwt.decode(token) as jwt.JwtPayload;
    if (!decoded || !decoded.exp) {
      return true;
    }
    return decoded.exp < Date.now() / 1000;
  } catch {
    return true;
  }
}

/**
 * Получает информацию о refresh token из БД
 */
export async function getRefreshTokenInfo(tokenId: string) {
  return prisma.refreshToken.findUnique({
    where: { id: tokenId },
    include: { user: { select: { id: true, username: true, displayName: true } } },
  });
}

/**
 * Получает все активные сессии пользователя
 */
export async function getUserSessions(userId: string) {
  return prisma.refreshToken.findMany({
    where: { userId, revokedAt: null },
    select: {
      id: true,
      deviceId: true,
      createdAt: true,
      expiresAt: true,
    },
    orderBy: { createdAt: 'desc' },
  });
}
