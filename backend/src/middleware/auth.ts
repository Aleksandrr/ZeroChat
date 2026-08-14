/**
 * Authentication Middleware
 * 
 * Единый preHandler для проверки JWT токена во всех маршрутах.
 * Используется во всех защищённых эндпоинтах.
 */

import { FastifyRequest, FastifyReply, preHandlerHookHandler } from 'fastify';
import { verifyAccessToken } from '../utils/jwt';
import { JWTPayload } from '../types';

/**
 * Стандартизированный ответ об ошибке аутентификации
 */
interface AuthErrorResponse {
  success: false;
  message: string;
}

/**
 * PreHandler для проверки JWT токена
 * 
 * Извлекает токен из заголовка Authorization: Bearer <token>
 * и добавляет декодированные данные пользователя в request.user
 * 
 * @param request - Fastify request
 * @param reply - Fastify reply
 * @returns void или отправляет 401 ответ
 */
export const authenticate: preHandlerHookHandler = async (
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> => {
  const authHeader = request.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    reply.code(401).send({
      success: false,
      message: 'No token provided',
    } as AuthErrorResponse);
    return;
  }

  const token = authHeader.substring(7);

  try {
    const decoded = verifyAccessToken(token) as JWTPayload;
    request.user = decoded;
  } catch (error) {
    reply.code(401).send({
      success: false,
      message: 'Invalid token',
    } as AuthErrorResponse);
    return;
  }
};

/**
 * Опциональная аутентификация
 * 
 * Проверяет токен если он есть, но не требует его наличия.
 * Полезно для эндпоинтов, которые работают и для анонимных пользователей.
 */
export const authenticateOptional: preHandlerHookHandler = async (
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> => {
  void reply; // Подавляем warning - reply может понадобиться в будущем
  
  const authHeader = request.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return; // Не требуем токен
  }

  const token = authHeader.substring(7);

  try {
    const decoded = verifyAccessToken(token) as JWTPayload;
    request.user = decoded;
  } catch (error) {
    // При ошибке просто не устанавливаем пользователя
    // Не отправляем ошибку, так как аутентификация опциональна
  }
};

/**
 * Проверка прав администратора
 *
 * Должен использоваться после authenticate middleware.
 * Проверяет поле `role` в JWT payload — если оно равно 'ADMIN',
 * доступ разрешён; иначе 403.
 */
export const requireAdmin: preHandlerHookHandler = async (
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> => {
  if (!request.user) {
    reply.code(401).send({
      success: false,
      message: 'Authentication required',
    });
    return;
  }

  // Check the role field in the JWT payload.
  // Currently no user has ADMIN role (the field is optional in JWTPayload).
  // When admin functionality is needed, set role: 'ADMIN' in the user's
  // JWT during login.
  const role = (request.user as any).role;
  if (role !== 'ADMIN') {
    reply.code(403).send({
      success: false,
      message: 'Admin access required',
    });
    return;
  }
};
