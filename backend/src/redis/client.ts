import Redis from 'ioredis';

let redisClient: Redis | null = null;

/**
 * Get or create Redis client instance
 */
export function getRedisClient(): Redis | null {
  if (!redisClient && process.env['REDIS_URL']) {
    redisClient = new Redis(process.env['REDIS_URL'], {
      maxRetriesPerRequest: 3,
      retryStrategy: (times: number) => {
        if (times > 3) {
          console.error('[Redis] Connection failed after 3 retries');
          return null; // Stop retrying
        }
        return Math.min(times * 100, 3000); // Exponential backoff
      },
      reconnectOnError: (err: Error) => {
        const targetErrors = ['READONLY', 'ECONNRESET', 'ECONNREFUSED'];
        if (targetErrors.some(e => err.message.includes(e))) {
          return true; // Reconnect on these errors
        }
        return false;
      },
    });

    redisClient.on('connect', () => {
      console.log('[Redis] Connected to', process.env['REDIS_URL']);
    });

    redisClient.on('error', (err: Error) => {
      console.error('[Redis] Error:', err.message);
    });

    redisClient.on('close', () => {
      console.log('[Redis] Connection closed');
    });
  }
  return redisClient;
}

/**
 * Close Redis connection gracefully
 */
export async function closeRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
    console.log('[Redis] Connection closed gracefully');
  }
}

/**
 * Check Redis health
 */
export async function checkRedisHealth(): Promise<{
  status: 'healthy' | 'unhealthy' | 'not_configured';
  latency?: number;
  error?: string;
}> {
  const client = getRedisClient();
  
  if (!client) {
    return { status: 'not_configured' };
  }

  try {
    const start = Date.now();
    await client.ping();
    const latency = Date.now() - start;
    return { status: 'healthy', latency };
  } catch (error) {
    return { 
      status: 'unhealthy', 
      error: error instanceof Error ? error.message : 'Unknown error' 
    };
  }
}

/**
 * Cache wrapper with TTL support
 */
export const cache = {
  /**
   * Get value from cache
   */
  async get<T>(key: string): Promise<T | null> {
    const client = getRedisClient();
    if (!client) return null;

    try {
      const value = await client.get(key);
      if (!value) return null;
      return JSON.parse(value) as T;
    } catch (error) {
      console.error('[Redis] Cache get error:', error);
      return null;
    }
  },

  /**
   * Set value in cache with TTL (seconds)
   */
  async set<T>(key: string, value: T, ttl?: number): Promise<boolean> {
    const client = getRedisClient();
    if (!client) return false;

    try {
      const serialized = JSON.stringify(value);
      if (ttl) {
        await client.set(key, serialized, 'EX', ttl);
      } else {
        await client.set(key, serialized);
      }
      return true;
    } catch (error) {
      console.error('[Redis] Cache set error:', error);
      return false;
    }
  },

  /**
   * Delete key from cache
   */
  async del(key: string): Promise<boolean> {
    const client = getRedisClient();
    if (!client) return false;

    try {
      await client.del(key);
      return true;
    } catch (error) {
      console.error('[Redis] Cache del error:', error);
      return false;
    }
  },

  /**
   * Check if key exists
   */
  async exists(key: string): Promise<boolean> {
    const client = getRedisClient();
    if (!client) return false;

    try {
      const result = await client.exists(key);
      return result === 1;
    } catch (error) {
      console.error('[Redis] Cache exists error:', error);
      return false;
    }
  },

  /**
   * Set key expiration
   */
  async expire(key: string, seconds: number): Promise<boolean> {
    const client = getRedisClient();
    if (!client) return false;

    try {
      await client.expire(key, seconds);
      return true;
    } catch (error) {
      console.error('[Redis] Cache expire error:', error);
      return false;
    }
  },
};

/**
 * Session storage for WebSocket connections
 */
export const sessionStore = {
  /**
   * Store user session
   */
  async setUserSession(userId: string, deviceId: string, data: object, ttl = 3600): Promise<boolean> {
    const key = `session:${userId}:${deviceId}`;
    return cache.set(key, data, ttl);
  },

  /**
   * Get user session
   */
  async getUserSession<T>(userId: string, deviceId: string): Promise<T | null> {
    const key = `session:${userId}:${deviceId}`;
    return cache.get<T>(key);
  },

  /**
   * Remove user session
   */
  async removeUserSession(userId: string, deviceId: string): Promise<boolean> {
    const key = `session:${userId}:${deviceId}`;
    return cache.del(key);
  },

  /**
   * Get all active sessions for user
   */
  async getUserSessions(userId: string): Promise<string[]> {
    const client = getRedisClient();
    if (!client) return [];

    try {
      const pattern = `session:${userId}:*`;
      const keys = await client.keys(pattern);
      return keys.map(k => k.split(':')[2]!).filter((k): k is string => typeof k === 'string');
    } catch (error) {
      console.error('[Redis] getUserSessions error:', error);
      return [];
    }
  },
};

/**
 * Rate limiter storage
 */
export const rateLimitStore = {
  /**
   * Increment counter and get current value
   */
  async incr(key: string, windowMs: number): Promise<number> {
    const client = getRedisClient();
    if (!client) return 0;

    try {
      const current = await client.incr(key);
      // Set expiration on first increment
      if (current === 1) {
        await client.pexpire(key, windowMs);
      }
      return current;
    } catch (error) {
      console.error('[Redis] Rate limit incr error:', error);
      return 0;
    }
  },

  /**
   * Get current counter value
   */
  async get(key: string): Promise<number> {
    const client = getRedisClient();
    if (!client) return 0;

    try {
      const value = await client.get(key);
      return value ? parseInt(value, 10) : 0;
    } catch (error) {
      console.error('[Redis] Rate limit get error:', error);
      return 0;
    }
  },

  /**
   * Reset counter
   */
  async reset(key: string): Promise<void> {
    const client = getRedisClient();
    if (!client) return;

    try {
      await client.del(key);
    } catch (error) {
      console.error('[Redis] Rate limit reset error:', error);
    }
  },
};

export default {
  getRedisClient,
  closeRedis,
  checkRedisHealth,
  cache,
  sessionStore,
  rateLimitStore,
};