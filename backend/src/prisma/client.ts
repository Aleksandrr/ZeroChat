import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPrismaClientWithPgite } from './pglite-adapter';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  __pgliteBooted?: Promise<PrismaClient>;
};

const connectionString = process.env['DATABASE_URL'] || 'postgresql://localhost:5432/zerochat';
const usePglite = process.env['USE_PGLITE'] === 'true' || !connectionString.includes('@');

async function bootPrisma(): Promise<PrismaClient> {
  if (usePglite) {
    // Resolve migrations dir relative to this module file.
    const thisDir = fileURLToPath(new URL('.', import.meta.url));
    const migrationsDir = resolve(thisDir, '../../prisma/migrations');
    const { prisma } = await getPrismaClientWithPgite(migrationsDir);
    console.log('[prisma] Using PGlite (PostgreSQL WASM) — migrations applied');
    return prisma;
  }
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({
    adapter,
    log: ['error', 'warn'],
  });
}

// Synchronous accessor returns either the cached client (if already
// booted) or a placeholder that throws when accessed. The first
// import of `prisma` should be preceded by an `await ensurePrisma()`
// call in the bootstrap path.
let prismaClient: PrismaClient | null = globalForPrisma.prisma ?? null;
let bootPromise: Promise<PrismaClient> | null = null;

if (globalForPrisma.prisma) {
  prismaClient = globalForPrisma.prisma;
} else if (usePglite) {
  // PGlite requires async boot — kick it off and expose a `then`-able
  // proxy on `prisma` so callers can `await prisma` to wait for boot.
  bootPromise = (async () => {
    const client = await bootPrisma();
    prismaClient = client;
    globalForPrisma.prisma = client;
    return client;
  })();
  globalForPrisma.__pgliteBooted = bootPromise;
} else {
  // Synchronous path: real Postgres via PrismaPg
  prismaClient = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
    log: ['error', 'warn'],
  });
  globalForPrisma.prisma = prismaClient;
}

// `prisma` is a Proxy that forwards property access to the underlying
// client once booted, and throws a friendly error before that.
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    if (!prismaClient) {
      throw new Error(
        '[prisma] PGlite boot has not completed yet. Call `await ensurePrisma()` at the top of your bootstrap.',
      );
    }
    return (prismaClient as any)[prop];
  },
});

/**
 * Ensure the PrismaClient is ready before serving requests. Required
 * when USE_PGLITE=true (PGlite needs async init).
 */
export async function ensurePrisma(): Promise<PrismaClient> {
  if (prismaClient) return prismaClient;
  if (bootPromise) return bootPromise;
  // Fallback: synchronously construct
  prismaClient = await bootPrisma();
  globalForPrisma.prisma = prismaClient;
  return prismaClient;
}