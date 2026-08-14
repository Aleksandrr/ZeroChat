import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  registerUser,
  loginUser,
  logoutUser,
  refreshTokens,
  getUserActiveSessions,
  unregisterDevice as backendUnregisterDevice
} from '../services/auth';
import { validateRegisterInput, validateLoginInput } from '../middleware/validation';
import { verifyAccessToken } from '../utils/jwt';
import { prisma } from '../prisma/client';
import { revokeRefreshToken } from '../utils/jwt';

// Pre-handler wrappers for validation
const registerValidationHandler = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
  const result = validateRegisterInput(request as FastifyRequest<{ Body: { username: string; password: string; displayName?: string } }>);
  if (!result.valid) {
    // SECURITY: never log the password (or any field that might
    // contain one). We strip `password` from the body before
    // logging the validation failure — logs are often shipped to
    // long-term storage with broader read access than the API.
    const { password: _pw, ...safeBody } = (request.body as { password?: string } | undefined) ?? {};
    request.server.log.warn({
      event: 'validation_failed',
      endpoint: '/api/auth/register',
      errors: result.errors,
      body: safeBody,
    }, 'Registration validation failed');
    reply.code(400).send({
      success: false,
      message: 'Validation failed',
      errors: result.errors,
    });
  }
};

const loginValidationHandler = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
  const result = validateLoginInput(request as FastifyRequest<{ Body: { username: string; password: string } }>);
  if (!result.valid) {
    // SECURITY: same as above — never log the password.
    const { password: _pw, ...safeBody } = (request.body as { password?: string } | undefined) ?? {};
    request.server.log.warn({
      event: 'validation_failed',
      endpoint: '/api/auth/login',
      errors: result.errors,
      body: safeBody,
    }, 'Login validation failed');
    reply.code(400).send({
      success: false,
      message: 'Validation failed',
      errors: result.errors,
    });
  }
};

export const authRoutes = async (fastify: FastifyInstance) => {
  // Rate limit configuration for auth endpoints
  const authRateLimitOptions = {
    timeWindow: '1 hour',
    max: 5,
    keyGenerator: (request: any) => `${request.ip}:${request.url}`,
  };

  const loginRateLimitOptions = {
    timeWindow: '1 hour',
    max: 10,
    keyGenerator: (request: any) => `${request.ip}:${request.url}`,
  };

  // ==================== REGISTER ====================
  fastify.post('/register', {
    preHandler: registerValidationHandler,
    config: {
      rateLimit: authRateLimitOptions,
    },
    handler: async (request, reply) => {
      try {
        const { username, password, displayName } = request.body as {
          username: string;
          password: string;
          displayName?: string;
        };

        const result = await registerUser(username, password, displayName);
        
        // Устанавливаем refresh token в HTTP-only cookie
        // В production: SameSite=None; Secure=true для работы с HTTPS
        // В development: SameSite=Lax; Secure=false для работы с HTTP proxy
        const isProduction = process.env['NODE_ENV'] === 'production';
        reply.setCookie('refreshToken', result.tokens.refreshToken, {
          httpOnly: true,
          secure: isProduction, // true только в production (HTTPS)
          sameSite: isProduction ? 'none' : 'lax', // none для production, lax для dev
          maxAge: 7 * 24 * 60 * 60, // 7 дней
          path: '/',
        });

        return {
          success: true,
          message: 'User registered successfully',
          user: result.user,
          data: {
            accessToken: result.tokens.accessToken,
            expiresIn: result.tokens.expiresIn,
            deviceId: result.deviceId,
          },
        };
      } catch (error) {
        // Differentiate "username already exists" (an expected user-facing
        // condition, not a server fault) from genuine registration failures.
        // Logging it at ERROR level with a stack trace polluted production
        // logs and triggered false-positive alerts. Demote to WARN.
        const errMsg = error instanceof Error ? error.message : String(error);
        const requestedUsername = (request.body as { username?: string } | undefined)?.username;
        const isExistingUser =
          errMsg.toLowerCase().includes('username already exists') ||
          errMsg.toLowerCase().includes('user already exists');

        if (isExistingUser) {
          fastify.log.warn(
            { username: requestedUsername, event: 'registration_duplicate_username' },
            'Registration attempt with existing username',
          );
        } else {
          fastify.log.error(
            { error: errMsg, event: 'registration_failed' },
            'Registration failed',
          );
        }

        return reply.code(400).send({
          success: false,
          message: isExistingUser ? 'Username already exists' : 'Registration failed',
          error: errMsg,
        });
      }
    },
  });

  // ==================== LOGIN ====================
  fastify.post('/login', {
    preHandler: loginValidationHandler,
    config: {
      rateLimit: loginRateLimitOptions,
    },
    handler: async (request, reply) => {
      try {
        const { username, password, deviceId } = request.body as {
          username: string;
          password: string;
          deviceId?: string;
        };

        const ip = request.ip;
        const result = await loginUser(username, password, deviceId, ip);

        // Устанавливаем refresh token в HTTP-only cookie
        const isProduction = process.env['NODE_ENV'] === 'production';
        reply.setCookie('refreshToken', result.tokens.refreshToken, {
          httpOnly: true,
          secure: isProduction,
          sameSite: isProduction ? 'none' : 'lax',
          maxAge: 7 * 24 * 60 * 60,
          path: '/',
        });

        // API consistency: lift `deviceNeedsVerification` (and the
        // other top-level fields clients actually read) out of `data`.
        // The nested `data` block is preserved for backward compat
        // with clients that still read `response.data.deviceNeedsVerification`.
        return {
          success: true,
          message: 'Login successful',
          user: result.user,
          accessToken: result.tokens.accessToken,
          refreshToken: result.tokens.refreshToken,
          expiresIn: result.tokens.expiresIn,
          deviceId: result.deviceId,
          deviceNeedsVerification: result.deviceNeedsVerification, // top-level for client convenience
          data: {
            user: result.user,
            accessToken: result.tokens.accessToken,
            refreshToken: result.tokens.refreshToken,
            expiresIn: result.tokens.expiresIn,
            deviceId: result.deviceId,
            deviceNeedsVerification: result.deviceNeedsVerification,
          },
        };
      } catch (error) {
        fastify.log.error({ error: 'Login failed', details: error });
        return reply.code(401).send({
          success: false,
          message: 'Login failed',
          error: error instanceof Error ? error.message : 'Invalid credentials',
        });
      }
    },
  });

  // ==================== LOGOUT ====================
  fastify.post('/logout', {
    preHandler: async (request, reply) => {
      try {
        const refreshTokenCookie = request.cookies['refreshToken'];
        
        if (refreshTokenCookie) {
          // Получаем tokenId из refresh token
          const { verifyRefreshToken } = await import('../utils/jwt');
          const decoded = await verifyRefreshToken(refreshTokenCookie);
          
          // Отзываем токен
          await logoutUser(decoded.tokenId);
        }

        // Очищаем cookie
        reply.clearCookie('refreshToken', { path: '/' });

        return { success: true, message: 'Logout successful' };
      } catch (error) {
        // Даже при ошибке очищаем cookie
        reply.clearCookie('refreshToken', { path: '/' });
        return { success: true, message: 'Logout successful' };
      }
    },
    handler: async () => {
      return { success: true, message: 'Logout successful' };
    },
  });

  // ==================== REFRESH TOKEN ====================
  fastify.post('/refresh', {
    handler: async (request, reply) => {
      try {
        // Try to get refresh token from cookie first, then from Authorization header
        let refreshToken = request.cookies['refreshToken'];
        
        if (!refreshToken) {
          // Also try Authorization header (Bearer token)
          const authHeader = request.headers.authorization;
          if (authHeader && authHeader.startsWith('Bearer ')) {
            refreshToken = authHeader.substring(7);
          }
        }
        
        if (!refreshToken) {
          fastify.log.warn('No refresh token provided in cookie or header');
          return reply.code(401).send({
            success: false,
            message: 'No refresh token provided',
          });
        }

        // Выполняем ротацию токенов
        const newTokens = await refreshTokens(refreshToken);

        // Устанавливаем новый refresh token в cookie
        // В production: SameSite=None; Secure=true для работы с HTTPS
        // В development: SameSite=Lax; Secure=false для работы с HTTP proxy
        const isProduction = process.env['NODE_ENV'] === 'production';
        reply.setCookie('refreshToken', newTokens.refreshToken, {
          httpOnly: true,
          secure: isProduction, // true только в production (HTTPS)
          sameSite: isProduction ? 'none' : 'lax', // none для production, lax для dev
          maxAge: 7 * 24 * 60 * 60,
          path: '/',
        });

        // Возвращаем новый access token (refresh token уже в httpOnly cookie)
        return {
          success: true,
          data: {
            accessToken: newTokens.accessToken,
            expiresIn: newTokens.expiresIn,
            tokenId: newTokens.tokenId,
          },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Invalid refresh token';
        fastify.log.error({
          event: 'token_refresh_failed',
          error: errorMessage,
          details: error,
          // Avoid logging the token itself for security
          tokenId: error instanceof Error && (error as any).tokenId ? (error as any).tokenId : undefined,
        });
        
        // Проверяем, является ли это security alert (token leak detected)
        const isSecurityAlert = error instanceof Error && error.message.includes('SECURITY_ALERT');
        
        if (isSecurityAlert) {
          // Очищаем cookie при security alert
          reply.clearCookie('refreshToken', { path: '/' });
          
          return reply.code(401).send({
            success: false,
            message: 'Security alert: Token leak detected. All sessions revoked.',
            error: 'SECURITY_ALERT',
            securityAlert: true,
          });
        }
        
        // Return specific error messages for better client handling
        let clientMessage = 'Token refresh failed';
        if (errorMessage.includes('not found')) {
          clientMessage = 'Refresh token not found';
        } else if (errorMessage.includes('expired')) {
          clientMessage = 'Refresh token has expired';
        } else if (errorMessage.includes('revoked')) {
          clientMessage = 'Refresh token has been revoked';
        } else if (errorMessage.includes('Invalid')) {
          clientMessage = 'Invalid refresh token';
        }
        
        return reply.code(401).send({
          success: false,
          message: clientMessage,
          error: errorMessage,
        });
      }
    },
  });

  // ==================== GET CURRENT USER ====================
  fastify.get('/me', {
    preHandler: async (request, reply) => {
      try {
        const authHeader = request.headers.authorization;
        
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          return reply.code(401).send({
            success: false,
            message: 'No token provided',
          });
        }

        const token = authHeader.substring(7);
        const decoded = verifyAccessToken(token);
        
        // Добавляем decoded в request для использования в handler
        request.user = decoded as any;
      } catch (error) {
        fastify.log.error({ error: 'Token validation failed', details: error });
        return reply.code(401).send({
          success: false,
          message: 'Invalid token',
        });
      }
    },
    handler: async (request, reply) => {
      try {
        const { getUserById } = await import('../services/auth');
        const user = await getUserById((request as any).user.userId);
        
        if (!user) {
          return reply.code(404).send({
            success: false,
            message: 'User not found',
          });
        }

        return {
          success: true,
          user,
        };
      } catch (error) {
        fastify.log.error({ error: 'Failed to get user', details: error });
        return reply.code(500).send({
          success: false,
          message: 'Failed to get user',
        });
      }
    },
  });

  // ==================== GET USER SESSIONS ====================
  fastify.get('/sessions', {
    preHandler: async (request, reply) => {
      try {
        const authHeader = request.headers.authorization;
        
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          return reply.code(401).send({
            success: false,
            message: 'No token provided',
          });
        }

        const token = authHeader.substring(7);
        const decoded = verifyAccessToken(token);
        (request as any).user = decoded;
      } catch (error) {
        return reply.code(401).send({
          success: false,
          message: 'Invalid token',
        });
      }
    },
    handler: async (request, reply) => {
      try {
        const userId = (request as any).user.userId;
        const sessions = await getUserActiveSessions(userId);
        
        return {
          success: true,
          sessions: sessions.map(session => ({
            id: session.id,
            deviceId: session.deviceId,
            createdAt: session.createdAt,
            expiresAt: session.expiresAt,
          })),
        };
      } catch (error) {
        fastify.log.error({ error: 'Failed to get sessions', details: error });
        return reply.code(500).send({
          success: false,
          message: 'Failed to get sessions',
        });
      }
    },
  });

  // ==================== REVOKE SESSION ====================
  fastify.delete('/sessions/:sessionId', {
    preHandler: async (request, reply) => {
      try {
        const authHeader = request.headers.authorization;
        
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          return reply.code(401).send({
            success: false,
            message: 'No token provided',
          });
        }

        const token = authHeader.substring(7);
        const decoded = verifyAccessToken(token);
        (request as any).user = decoded;
      } catch (error) {
        return reply.code(401).send({
          success: false,
          message: 'Invalid token',
        });
      }
    },
    handler: async (request, reply) => {
      try {
        const { sessionId } = request.params as { sessionId: string };
        const userId = (request as any).user.userId;

        // SECURITY: IDOR fix — verify the session belongs to the
        // authenticated user before revoking it. Without this check,
        // any authenticated user could revoke any other user's
        // session by guessing/enumerating session IDs. We return
        // 404 (not 403) for non-owned sessions to avoid leaking
        // whether the session exists.
        const session = await prisma.refreshToken.findUnique({
          where: { id: sessionId },
          select: { userId: true },
        });
        if (!session || session.userId !== userId) {
          return reply.code(404).send({
            success: false,
            message: 'Session not found',
          });
        }

        await revokeRefreshToken(sessionId);

        return {
          success: true,
          message: 'Session revoked successfully',
        };
      } catch (error) {
        fastify.log.error({ error: 'Failed to revoke session', details: error });
        return reply.code(500).send({
          success: false,
          message: 'Failed to revoke session',
        });
      }
    },
  });

  // ==================== REVOKE ALL SESSIONS ====================
  fastify.delete('/sessions', {
    preHandler: async (request, reply) => {
      try {
        const authHeader = request.headers.authorization;
        
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          return reply.code(401).send({
            success: false,
            message: 'No token provided',
          });
        }

        const token = authHeader.substring(7);
        const decoded = verifyAccessToken(token);
        (request as any).user = decoded;
      } catch (error) {
        return reply.code(401).send({
          success: false,
          message: 'Invalid token',
        });
      }
    },
    handler: async (request, reply) => {
      try {
        const userId = (request as any).user.userId;
        const { revokeAllUserTokens } = await import('../utils/jwt');
        await revokeAllUserTokens(userId);
        
        // Очищаем текущую сессию cookie
        reply.clearCookie('refreshToken', { path: '/' });
        
        return {
          success: true,
          message: 'All sessions revoked successfully',
        };
      } catch (error) {
        fastify.log.error({ error: 'Failed to revoke all sessions', details: error });
        return reply.code(500).send({
          success: false,
          message: 'Failed to revoke all sessions',
        });
      }
    },
  });

  // ==================== UNREGISTER DEVICE ====================
  // Полная дерегистрация устройства (удаление Signal ключей с сервера)
  fastify.delete('/unregister', {
    preHandler: async (request, reply) => {
      try {
        const authHeader = request.headers.authorization;
        
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          return reply.code(401).send({
            success: false,
            message: 'No token provided',
          });
        }

        const token = authHeader.substring(7);
        const decoded = verifyAccessToken(token);
        (request as any).user = decoded;
      } catch (error) {
        return reply.code(401).send({
          success: false,
          message: 'Invalid token',
        });
      }
    },
    handler: async (request, reply) => {
      try {
        const userId = (request as any).user.userId;
        // SECURITY: deviceId is REQUIRED for unregister — without
        // it we can't tell which device to wipe. Previously the
        // endpoint silently accepted a missing deviceId and passed
        // `undefined` to the service, which could wipe unexpected
        // state. We also accept an optional `password` field for
        // future destructive-operation re-auth.
        const { deviceId, password: _password } = request.body as { deviceId?: string; password?: string };

        if (!deviceId) {
          return reply.code(400).send({
            success: false,
            message: 'deviceId is required',
          });
        }

        await backendUnregisterDevice(userId, deviceId);

        return {
          success: true,
          message: 'Device unregistered successfully',
        };
      } catch (error) {
        fastify.log.error({ error: 'Failed to unregister device', details: error });
        return reply.code(500).send({
          success: false,
          message: 'Failed to unregister device',
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    },
  });

  // ==================== REFRESH DEVICE TOKEN ====================
  // Get a new JWT with a different deviceId (multi-device scenario)
  fastify.post('/refresh-device', {
    preHandler: async (request, reply) => {
      try {
        const authHeader = request.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          return reply.code(401).send({ success: false, message: 'No token provided' });
        }
        const token = authHeader.substring(7);
        const decoded = verifyAccessToken(token);
        (request as any).user = decoded;
      } catch (error) {
        return reply.code(401).send({ success: false, message: 'Invalid token' });
      }
    },
    handler: async (request, reply) => {
      try {
        const userId = (request as any).user.userId;
        const userUsername = (request as any).user.username || '';
        const { newDeviceId } = request.body as { newDeviceId: string };
        
        if (!newDeviceId) {
          return reply.code(400).send({
            success: false,
            message: 'newDeviceId is required',
          });
        }
        
        // Import prisma and JWT utilities
        const { prisma } = await import('../prisma/client');
        const { generateAccessToken, generateRefreshToken } = await import('../utils/jwt');
        
        // Verify the device belongs to this user
        const device = await prisma.device.findFirst({
          where: { userId, deviceId: newDeviceId, isActive: true },
        });
        
        if (!device) {
          return reply.code(403).send({
            success: false,
            message: 'Device not found or not authorized',
          });
        }
        
        // Check if device needs verification
        const needsVerification = device.verifiedAt === null;
        
        // Generate new tokens with the new deviceId
        const accessToken = generateAccessToken({ userId, username: userUsername, deviceId: newDeviceId });
        const refreshToken = await generateRefreshToken(userId, newDeviceId);
        
        fastify.log.info({ userId, newDeviceId }, '[Auth] Device token refreshed');
        
        return {
          success: true,
          accessToken,
          refreshToken: refreshToken.token,
          deviceId: newDeviceId,
          deviceNeedsVerification: needsVerification,
        };
      } catch (error) {
        fastify.log.error({ error: 'Failed to refresh device token', details: error });
        return reply.code(500).send({
          success: false,
          message: 'Failed to refresh device token',
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    },
  });
};
