import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

const connectionString = process.env['DATABASE_URL'] || 'postgresql://localhost:5432/zerochat';

// Always use PostgreSQL in production - PGlite removed for production readiness
const adapter = new PrismaPg({ 
  connectionString,
  // Connection pool settings for production
  max: parseInt(process.env['DATABASE_POOL_MAX'] || '10'),
  min: parseInt(process.env['DATABASE_POOL_MIN'] || '2'),
  idleTimeoutMillis: parseInt(process.env['DATABASE_IDLE_TIMEOUT'] || '30000'),
  connectionTimeoutMillis: parseInt(process.env['DATABASE_CONNECTION_TIMEOUT'] || '5000'),
});

let prismaClient: PrismaClient | null = globalForPrisma.prisma ?? null;

if (!globalForPrisma.prisma) {
  // Production-ready PostgreSQL client with proper connection pooling
  prismaClient = new PrismaClient({
    adapter,
    log: process.env['NODE_ENV'] === 'production' 
      ? ['error', 'warn'] 
      : ['error', 'warn', 'info', 'query'],
  });
  globalForPrisma.prisma = prismaClient;
}

export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    if (!prismaClient) {
      throw new Error(
        '[prisma] Prisma client not initialized. Ensure DATABASE_URL is set correctly.',
      );
    }
    return (prismaClient as any)[prop];
  },
});

/**
 * Ensure the PrismaClient is ready before serving requests.
 * Connects to PostgreSQL and validates connection.
 */
export async function ensurePrisma(): Promise<PrismaClient> {
  if (prismaClient) return prismaClient;
  
  prismaClient = new PrismaClient({
    adapter,
    log: process.env['NODE_ENV'] === 'production' 
      ? ['error', 'warn'] 
      : ['error', 'warn', 'info', 'query'],
  });
  
  await prismaClient.$connect();
  globalForPrisma.prisma = prismaClient;
  console.log('[prisma] Connected to PostgreSQL successfully');
  return prismaClient;
}

/**
 * Gracefully disconnect from PostgreSQL on shutdown
 */
export async function disconnectPrisma(): Promise<void> {
  if (prismaClient) {
    await prismaClient.$disconnect();
    prismaClient = null;
    console.log('[prisma] Disconnected from PostgreSQL');
  }
}