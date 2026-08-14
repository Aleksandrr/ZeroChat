import { FastifyInstance } from 'fastify';
import packageJson from '../../package.json';
import { checkRedisHealth } from '../redis/client.js';
import { prisma } from '../prisma/client.js';

/**
 * Redis is an OPTIONAL dependency. When `REDIS_URL` is not set we
 * treat Redis as "not_configured" and do NOT degrade the overall
 * health status — the API can still serve requests using in-process
 * state. Only when Redis is explicitly configured AND unreachable do
 * we report a degraded status (so the load balancer can drain the
 * instance).
 */
function isRedisConfigured(): boolean {
  return !!process.env['REDIS_URL'];
}

export const healthRoutes = async (fastify: FastifyInstance) => {
  // Health check endpoint
  fastify.get('/health', async (_request, reply) => {
    try {
      // Check database connection with timeout
      const dbPromise = prisma.$queryRaw`SELECT 1`;
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Database connection timeout')), 5000)
      );
      
      const [dbResult, redisHealthResult] = await Promise.allSettled([
        Promise.race([dbPromise, timeoutPromise]),
        checkRedisHealth()
      ]);
      
      const dbStatus = dbResult.status === 'fulfilled' ? 'healthy' : 'unhealthy';
      const redisConfigured = isRedisConfigured();
      const redisHealth = redisHealthResult.status === 'fulfilled'
        ? redisHealthResult.value
        : { status: 'unhealthy' as const };

      // Redis only degrades health when it is CONFIGURED but UNHEALTHY.
      // If REDIS_URL is not set, Redis is treated as optional and the
      // health endpoint returns 200/ok as long as the DB is healthy.
      const redisDegraded = redisConfigured && redisHealth.status === 'unhealthy';
      const isHealthy = dbStatus === 'healthy' && !redisDegraded;
      
      if (!isHealthy) {
        reply.code(503);
      }
      
      return {
        status: isHealthy ? 'ok' : 'degraded',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        environment: process.env['NODE_ENV'] || 'development',
        version: process.env['npm_package_version'] || '1.0.0',
        services: {
          database: dbStatus,
          redis: redisConfigured ? redisHealth : { status: 'not_configured' },
        },
      };
    } catch (error) {
      fastify.log.error({ error: 'Health check failed', details: error });
      reply.code(500).send({
        status: 'error',
        message: 'Health check failed',
      });
      return;
    }
  });

  // Detailed health check endpoint
  fastify.get('/health/detailed', async (_request, reply) => {
    try {
      // Check database
      const dbStart = Date.now();
      try {
        await prisma.$queryRaw`SELECT 1`;
      } catch (dbErr) {
        // Database is down — degrade regardless of Redis state.
        const redisConfigured = isRedisConfigured();
        const redisHealth = await checkRedisHealth().catch(() => ({ status: 'unhealthy' as const }));
        reply.code(503);
        return {
          status: 'degraded',
          timestamp: new Date().toISOString(),
          uptime: process.uptime(),
          environment: process.env['NODE_ENV'] || 'development',
          version: process.env['npm_package_version'] || '1.0.0',
          services: {
            database: {
              status: 'unhealthy',
              latency: Date.now() - dbStart,
              error: dbErr instanceof Error ? dbErr.message : 'unknown',
            },
            redis: redisConfigured ? redisHealth : { status: 'not_configured' },
          },
          memory: {
            used: process.memoryUsage().heapUsed,
            total: process.memoryUsage().heapTotal,
            external: process.memoryUsage().external,
            rss: process.memoryUsage().rss,
          },
          cpu: process.cpuUsage(),
        };
      }
      const dbLatency = Date.now() - dbStart;
      
      // Check Redis
      const redisConfigured = isRedisConfigured();
      const redisHealth = await checkRedisHealth();

      // Redis is optional — only degrade when configured AND unhealthy.
      const redisDegraded = redisConfigured && redisHealth.status === 'unhealthy';
      const isHealthy = !redisDegraded;
      
      if (!isHealthy) {
        reply.code(503);
      }
      
      return {
        status: isHealthy ? 'ok' : 'degraded',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        environment: process.env['NODE_ENV'] || 'development',
        version: process.env['npm_package_version'] || '1.0.0',
        services: {
          database: {
            status: 'healthy',
            latency: dbLatency,
          },
          redis: redisConfigured ? redisHealth : { status: 'not_configured' },
        },
        memory: {
          used: process.memoryUsage().heapUsed,
          total: process.memoryUsage().heapTotal,
          external: process.memoryUsage().external,
          rss: process.memoryUsage().rss,
        },
        cpu: process.cpuUsage(),
      };
    } catch (error) {
      fastify.log.error({ error: 'Detailed health check failed', details: error });
      reply.code(500).send({
        status: 'error',
        message: 'Health check failed',
        services: {
          database: 'unhealthy',
          redis: 'unknown',
        },
      });
      return;
    }
  });

  // Version endpoint - информация о версии приложения
  fastify.get('/version', async (_request, reply) => {
    try {
      return {
        version: packageJson.version,
        name: packageJson.name,
        environment: process.env['NODE_ENV'] || 'development',
        timestamp: new Date().toISOString(),
        dependencies: {
          fastify: packageJson.dependencies.fastify,
          '@prisma/client': packageJson.dependencies['@prisma/client']
        },
      };
    } catch (error) {
      fastify.log.error({ error: 'Version endpoint failed', details: error });
      reply.code(500).send({
        error: 'Failed to get version info',
      });
      return;
    }
  });
};
