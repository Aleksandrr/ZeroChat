import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import { healthRoutes } from './routes/health';
import { authRoutes } from './routes/auth';
import { keysRoutes } from './routes/keys';
import { usersRoutes } from './routes/users';
import { chatRoutes } from './routes/chats';
import { deviceRoutes } from './routes/devices';
import { syncRoutes } from './routes/sync';
import { storageRoutes } from './routes/storage';
import { setupWebSocketRoutes } from './ws';
import { getRedisClient, closeRedis } from './redis/client.js';
import promClient from 'prom-client';
import { checkProductionSecrets } from './utils/secrets-check';

// Fail-fast on missing/weak secrets in production. In dev/test this
// is a no-op so local servers keep using the documented fallbacks.
checkProductionSecrets();

/**
 * SECURITY: Cookie signing secret.
 *
 * In development we keep a fallback so local servers boot without
 * extra env configuration. In production the secret MUST be set
 * (and ≥ 32 chars — `checkProductionSecrets()` enforces this on
 * startup). If we somehow reach this line in production without
 * the env var, we throw rather than signing cookies with a
 * well-known default.
 */
function resolveCookieSecret(): string {
  const val = process.env['COOKIE_SECRET'];
  if (val) return val;
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('COOKIE_SECRET must be set in production');
  }
  return 'your-cookie-secret-change-in-production';
}

const COOKIE_SECRET = resolveCookieSecret();

const fastify = Fastify({
  logger: {
    level: 'info',
    transport: {
      target: 'pino-pretty',
      options: {
        translateTime: 'HH:MM:ss Z',
        ignore: 'pid,hostname',
      },
    },
  },
});

async function buildServer() {
  // Register CORS plugin
  // ВАЖНО: По умолчанию @fastify/cors разрешает только GET, HEAD, POST
  // DELETE, PATCH, PUT должны быть указаны явно в methods
  // В development режиме разрешаем запросы с любого origin (для локальной сети)
  const isDev = process.env['NODE_ENV'] !== 'production';
  const corsOrigin = isDev 
    ? true // В dev режиме разрешаем любой origin
    : (process.env['FRONTEND_URL'] || 'http://localhost:5173');
  
  await fastify.register(cors, {
    origin: corsOrigin,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Timestamp', 'X-Device-Id', 'X-HMAC-Signature', 'X-Signature'],
  });

  // Register Cookie plugin
  await fastify.register(cookie, {
    secret: COOKIE_SECRET,
  });

  // Register WebSocket plugin
  // C8: enforce an explicit `maxPayload` so a single malicious client
  // cannot OOM the server with a multi-GB WS frame. The ws library's
  // default is 100 MB, which is close to our application-level
  // payload cap (FILE_RATE_LIMITS.maxPayloadSize = 100 MB), but base64
  // inflation means legitimate 100 MB binary payloads arrive as
  // ~140 MB on the wire. We cap at 150 MB — anything bigger is
  // rejected at the TCP layer before our JSON parser touches it.
  await fastify.register(websocket, {
    options: {
      maxPayload: 150 * 1024 * 1024, // 150 MB
    },
  });

  // Register Multipart plugin with security limits
  // Prevents DoS via large file uploads
  await fastify.register(multipart, {
    limits: {
      fileSize: 10 * 1024 * 1024, // 10 MB max file size
      files: 5,                    // Max 5 files per request
      fieldSize: 1024 * 1024,      // 1 MB max field size
      fields: 10,                  // Max 10 non-file fields
      headerPairs: 20,             // Max 20 header pairs
    },
  });

  // Register Security Headers (Helmet)
  // C9: enable a strict Content Security Policy. CSP applies only to
  // backend-served HTML; the WebSocket gateway and JSON APIs are not
  // affected. The directives below allow:
  //   - WebSocket + fetch via `connect-src 'self' wss: ws:`
  //   - signal-wasm via `script-src 'self' 'wasm-unsafe-eval'`
  //   - avatar/image attachments via `img-src 'self' data: blob:`
  //   - voice/video messages via `media-src 'self' blob:`
  //   - Tailwind/shadcn inline styles via `style-src 'self' 'unsafe-inline'`
  //   - clickjacking protection via `frame-ancestors 'none'`
  // If the frontend is served by nginx, the same CSP should be
  // duplicated there — but enabling it on the backend is correct
  // for dev (where the backend serves the frontend) and for any
  // backend-rendered error pages.
  await fastify.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        connectSrc: ["'self'", 'wss:', 'ws:'],      // WebSocket + fetch
        scriptSrc: ["'self'", "'wasm-unsafe-eval'"], // signal-wasm
        imgSrc: ["'self'", 'data:', 'blob:'],        // avatars, image attachments
        mediaSrc: ["'self'", 'blob:'],               // voice/video messages
        styleSrc: ["'self'", "'unsafe-inline'"],     // Tailwind + shadcn
        fontSrc: ["'self'", 'data:'],
        frameAncestors: ["'none'"],                  // clickjacking protection
        baseUri: ["'self'"],
        formAction: ["'self'"],
        objectSrc: ["'none'"],                       // no Flash/Java
      },
    },
    crossOriginEmbedderPolicy: false, // может ломать embeds — оставить false
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
  });

  // Register Rate Limiting (global)
  // Use Redis for distributed rate limiting if configured
  const redisClient = getRedisClient();
  await fastify.register(rateLimit, {
    global: true,
    max: 100,
    timeWindow: '1 minute',
    keyGenerator: (request) => {
      // Для /api/auth/* использовать IP + endpoint для более строгого ограничения
      if (request.url.startsWith('/api/auth/')) {
        return `${request.ip}:${request.url}`;
      }
      return request.ip || 'unknown';
    },
    skipOnError: true, // Continue if Redis is unavailable
    redis: redisClient || undefined, // Use Redis if available
    nameSpace: 'zerochat:ratelimit:',
    addHeadersOnExceeding: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
    },
  });

  // CSRF Protection - Origin validation for state-changing methods
  // Additional protection beyond SameSite cookies
  // В development режиме отключаем строгую проверку origin
  fastify.addHook('preHandler', async (request, reply) => {
    // Skip CSRF check in development mode
    if (isDev) {
      return;
    }
    
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(request.method)) {
      const origin = request.headers.origin;
      const allowedOrigin = process.env['FRONTEND_URL'] || 'http://localhost:5173';
      
      // Allow requests without Origin header (e.g., from mobile apps, curl)
      // But if Origin is present, it must match
      if (origin && origin !== allowedOrigin) {
        // Also allow same-origin requests (Origin might be missing or same as host)
        const host = request.headers.host;
        const requestOrigin = origin.replace(/^https?:\/\//, '');
        if (requestOrigin !== host) {
          return reply.code(403).send({
            success: false,
            message: 'CSRF origin mismatch',
          });
        }
      }
    }
  });

  // WebSocket handler with proper authentication
  // MUST be called BEFORE other routes to ensure wsManager is available on root instance
  await setupWebSocketRoutes(fastify);

  // Register routes
  await fastify.register(healthRoutes, { prefix: '/api' });
  await fastify.register(authRoutes, { prefix: '/api/auth' });
  await fastify.register(keysRoutes, { prefix: '/api' });
  await fastify.register(usersRoutes, { prefix: '/api' });
  await fastify.register(chatRoutes, { prefix: '/api' });
  await fastify.register(deviceRoutes, { prefix: '/api' });
  await fastify.register(syncRoutes, { prefix: '/api' });
  await fastify.register(storageRoutes, { prefix: '/api' });

  // Prometheus metrics endpoint — protected by METRICS_TOKEN or Bearer JWT
  if (process.env['ENABLE_METRICS'] === 'true') {
    fastify.get('/metrics', async (request, reply) => {
      // Auth: either METRICS_TOKEN env var or a valid JWT access token
      const metricsToken = process.env['METRICS_TOKEN'];
      if (metricsToken) {
        const authHeader = request.headers.authorization;
        if (authHeader !== `Bearer ${metricsToken}`) {
          return reply.code(401).send({ error: 'Unauthorized' });
        }
      } else {
        // Fall back to JWT auth
        const authHeader = request.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) {
          return reply.code(401).send({ error: 'Unauthorized' });
        }
        try {
          const { verifyAccessToken } = await import('./utils/jwt');
          verifyAccessToken(authHeader.substring(7));
        } catch {
          return reply.code(401).send({ error: 'Invalid token' });
        }
      }
      try {
        reply.header('Content-Type', promClient.register.contentType);
        return await promClient.register.metrics();
      } catch (err) {
        request.log.error(err);
        return reply.code(500).send({ error: 'Failed to generate metrics' });
      }
    });
  }

  // Error handling
  fastify.setErrorHandler((error: unknown, _request, reply) => {
    fastify.log.error(error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    reply.code(500).send({
      error: 'Internal Server Error',
      message: errorMessage,
    });
  });

  // 404 handler
  fastify.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      error: 'Not Found',
      message: `Route ${request.url} not found`,
    });
  });

  return fastify;
}

async function start() {
  try {
    const server = await buildServer();

    // When USE_PGLITE=true (or no DATABASE_URL), the Prisma client must
    // be booted asynchronously before we accept requests.
    const { ensurePrisma } = await import('./prisma/client');
    await ensurePrisma();

    const port = parseInt(process.env['PORT'] || '3001', 10);
    const host = process.env['HOST'] || '0.0.0.0';

    await server.listen({ port, host });
    console.log(`Server listening on http://${host}:${port}`);
    
    // Initialize Redis connection if configured
    const redisClient = getRedisClient();
    if (redisClient) {
      console.log('[Server] Redis client initialized');
    }
    
    // Graceful shutdown
    const gracefulShutdown = async (signal: string) => {
      console.log(`Received ${signal}, shutting down gracefully...`);
      await closeRedis();
      await server.close();
      process.exit(0);
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

    // Catch uncaught errors — these were silently killing the process
    // in sandboxed dev runs (signal-wasm / argon2 native module crashes).
    // Log them so we can diagnose, but keep the server alive.
    process.on('uncaughtException', (err) => {
      console.error('[FATAL] uncaughtException:', err.message);
      console.error(err.stack);
    });
    process.on('unhandledRejection', (reason) => {
      console.error('[FATAL] unhandledRejection:', reason instanceof Error ? reason.message : reason);
      if (reason instanceof Error) console.error(reason.stack);
    });
    
  } catch (err) {
    console.error('Error starting server:', err);
    process.exit(1);
  }
}

start();