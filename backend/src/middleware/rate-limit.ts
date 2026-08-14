import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { RateLimiterRedis } from 'rate-limiter-flexible';
import Redis from 'ioredis';

interface RateLimitOptions {
  maxRequests?: number;
  timeWindow?: number;
  keyPrefix?: string;
  skipSuccessfulRequests?: boolean;
  skipFailedRequests?: boolean;
}

export interface RateLimitContext {
  userId?: string;
  ip: string;
  userAgent?: string;
}

/**
 * Creates a rate limiter using Redis for distributed rate limiting
 * Compatible with Prisma 7.x and PostgreSQL
 */
export function createRateLimiter(options: RateLimitOptions = {}) {
  const {
    maxRequests = parseInt(process.env['RATE_LIMIT_MAX_REQUESTS'] || '100'),
    timeWindow = parseInt(process.env['RATE_LIMIT_TIME_WINDOW'] || '60000'),
    keyPrefix = 'rl',
  } = options;

  const redisClient = new Redis(process.env['REDIS_URL'] || 'redis://localhost:6379');

  const limiter = new RateLimiterRedis({
    storeClient: redisClient,
    keyPrefix,
    points: maxRequests,
    duration: Math.floor(timeWindow / 1000), // Convert ms to seconds
  });

  return { limiter, redisClient };
}

/**
 * Extract client identification for rate limiting
 * Prioritizes: userId > IP address
 */
export function getClientIdentifier(request: FastifyRequest): RateLimitContext {
  const userId = (request as any).user?.userId;
  const ip = request.ip || request.headers['x-forwarded-for'] as string || 'unknown';
  const userAgent = request.headers['user-agent'] as string;

  return { userId, ip, userAgent };
}

/**
 * Fastify plugin for rate limiting
 * Usage: fastify.register(rateLimitPlugin, { maxRequests: 100, timeWindow: 60000 })
 */
export async function rateLimitPlugin(fastify: FastifyInstance, options: RateLimitOptions) {
  const { limiter, redisClient } = createRateLimiter(options);

  // Graceful shutdown
  fastify.addHook('onClose', async () => {
    await redisClient.quit();
  });

  // Pre-handler hook to apply rate limiting
  fastify.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    // Skip rate limiting for health checks
    if (request.url === '/health' || request.url === '/ready') {
      return;
    }

    // Skip rate limiting for static assets
    if (request.url.startsWith('/static/')) {
      return;
    }

    const context = getClientIdentifier(request);
    const key = context.userId ? `user:${context.userId}` : `ip:${context.ip}`;

    try {
      await limiter.consume(key);
    } catch (rejRes: any) {
      const retryAfter = Math.ceil(rejRes.msBeforeNext / 1000);
      
      reply.header('X-RateLimit-Limit', limiter.points);
      reply.header('X-RateLimit-Remaining', Math.max(0, limiter.points - rejRes.consumedPoints));
      reply.header('X-RateLimit-Reset', new Date(Date.now() + rejRes.msBeforeNext).toISOString());
      reply.header('Retry-After', retryAfter);

      return reply.status(429).send({
        error: 'Too Many Requests',
        message: 'Rate limit exceeded. Please try again later.',
        retryAfter,
      });
    }
  });
}

/**
 * Route-specific rate limiting decorator
 */
export function routeRateLimit(options: RateLimitOptions = {}) {
  return async function (_fastify: FastifyInstance, request: FastifyRequest, reply: FastifyReply) {
    const { limiter } = createRateLimiter(options);
    const context = getClientIdentifier(request);
    const key = `route:${request.method}:${request.url}:${context.userId || context.ip}`;

    try {
      await limiter.consume(key);
    } catch (rejRes: any) {
      const retryAfter = Math.ceil(rejRes.msBeforeNext / 1000);
      
      reply.header('Retry-After', retryAfter);
      return reply.status(429).send({
        error: 'Too Many Requests',
        message: 'Rate limit exceeded for this endpoint.',
        retryAfter,
      });
    }
  };
}

/**
 * Specialized rate limiters for different use cases
 */
export const rateLimiters = {
  // Authentication endpoints (strict limits)
  auth: createRateLimiter({
    maxRequests: 5,
    timeWindow: 60000, // 5 attempts per minute
    keyPrefix: 'rl:auth',
  }),

  // Password reset (very strict)
  passwordReset: createRateLimiter({
    maxRequests: 3,
    timeWindow: 3600000, // 3 attempts per hour
    keyPrefix: 'rl:pwd-reset',
  }),

  // Message sending (moderate limits)
  messaging: createRateLimiter({
    maxRequests: 60,
    timeWindow: 60000, // 60 messages per minute
    keyPrefix: 'rl:msg',
  }),

  // File uploads (strict limits)
  fileUpload: createRateLimiter({
    maxRequests: 10,
    timeWindow: 60000, // 10 uploads per minute
    keyPrefix: 'rl:upload',
  }),

  // API general (default limits)
  api: createRateLimiter({
    maxRequests: 100,
    timeWindow: 60000, // 100 requests per minute
    keyPrefix: 'rl:api',
  }),
};

/**
 * Apply authentication rate limiting to a route
 */
export async function applyAuthRateLimit(request: FastifyRequest, reply: FastifyReply) {
  const { limiter } = rateLimiters.auth;
  const context = getClientIdentifier(request);
  const key = `auth:${context.ip}`;

  try {
    await limiter.consume(key);
  } catch (rejRes: any) {
    const retryAfter = Math.ceil(rejRes.msBeforeNext / 1000);
    
    reply.header('Retry-After', retryAfter);
    throw reply.code(429).send({
      error: 'Too Many Requests',
      message: 'Too many authentication attempts. Please try again later.',
      retryAfter,
    });
  }
}
