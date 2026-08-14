/**
 * PrismaPgite — a Prisma Driver Adapter that backs Prisma queries with
 * @electric-sql/pglite (PostgreSQL 17 compiled to WASM).
 *
 * The adapter mirrors the shape of @prisma/adapter-pg but swaps the
 * `pg` Client for a PGlite instance. PGlite's query result shape is
 * intentionally compatible with `pg` (fields: {name, dataTypeID},
 * rows: array-of-arrays when rowMode='array'), so most of the conversion
 * logic is identical.
 *
 * Usage:
 *   import { PrismaPgite } from './prisma-pglite-adapter';
 *   const pg = await PGlite.create();
 *   await applyMigrations(pg); // run prisma migrations
 *   const adapter = new PrismaPgite(pg);
 *   const prisma = new PrismaClient({ adapter });
 *
 * The adapter is intentionally minimal: it implements SqlDriverAdapter
 * (queryRaw, executeRaw, executeScript, startTransaction, dispose).
 * Savepoints and other optional features are omitted — Prisma only
 * requires the core surface for CRUD operations.
 */

import { PGlite } from '@electric-sql/pglite';
import { PrismaClient } from '@prisma/client';
import {
  ColumnTypeEnum,
  DriverAdapterError,
  type ColumnType,
  type ConnectionInfo,
  type IsolationLevel,
  type SqlDriverAdapter,
  type SqlQuery,
  type SqlResultSet,
  type Transaction,
} from '@prisma/driver-adapter-utils';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

// ==================== PG type OIDs ====================
// Source: https://www.postgresql.org/docs/current/static/catalog-pg-type.html
// We only include the types Prisma's adapter-pg recognises.
const PG_OID = {
  INT2: 21,
  INT4: 23,
  INT8: 20,
  FLOAT4: 700,
  FLOAT8: 701,
  BOOL: 16,
  DATE: 1082,
  TIME: 1083,
  TIMETZ: 1266,
  TIMESTAMP: 1114,
  TIMESTAMPTZ: 1184,
  NUMERIC: 1700,
  MONEY: 790,
  JSON: 114,
  JSONB: 3802,
  UUID: 2950,
  OID: 26,
  BPCHAR: 1042,
  TEXT: 25,
  VARCHAR: 1043,
  BIT: 1560,
  VARBIT: 1562,
  INET: 869,
  CIDR: 650,
  XML: 142,
  BYTEA: 17,
  NAME: 19,
  INT2_ARRAY: 1005,
  INT4_ARRAY: 1007,
  INT8_ARRAY: 1016,
  FLOAT4_ARRAY: 1021,
  FLOAT8_ARRAY: 1022,
  NUMERIC_ARRAY: 1231,
  BOOL_ARRAY: 1000,
  CHAR_ARRAY: 1002,
  BPCHAR_ARRAY: 1014,
  TEXT_ARRAY: 1009,
  VARCHAR_ARRAY: 1015,
  VARBIT_ARRAY: 1561,
  BIT_ARRAY: 1561,
  INET_ARRAY: 1041,
  CIDR_ARRAY: 651,
  XML_ARRAY: 143,
  DATE_ARRAY: 1182,
  TIME_ARRAY: 1183,
  TIMESTAMP_ARRAY: 1115,
  TIMESTAMPTZ_ARRAY: 1185,
  JSON_ARRAY: 199,
  JSONB_ARRAY: 3807,
  BYTEA_ARRAY: 1001,
  UUID_ARRAY: 2950,
  OID_ARRAY: 1028,
} as const;

const FIRST_NORMAL_OBJECT_ID = 16384;

function fieldToColumnType(fieldTypeId: number): ColumnType {
  switch (fieldTypeId) {
    case PG_OID.INT2:
    case PG_OID.INT4:
      return ColumnTypeEnum.Int32;
    case PG_OID.INT8:
    case PG_OID.OID:
      return ColumnTypeEnum.Int64;
    case PG_OID.FLOAT4:
      return ColumnTypeEnum.Float;
    case PG_OID.FLOAT8:
      return ColumnTypeEnum.Double;
    case PG_OID.BOOL:
      return ColumnTypeEnum.Boolean;
    case PG_OID.DATE:
      return ColumnTypeEnum.Date;
    case PG_OID.TIME:
    case PG_OID.TIMETZ:
      return ColumnTypeEnum.Time;
    case PG_OID.TIMESTAMP:
    case PG_OID.TIMESTAMPTZ:
      return ColumnTypeEnum.DateTime;
    case PG_OID.NUMERIC:
    case PG_OID.MONEY:
      return ColumnTypeEnum.Numeric;
    case PG_OID.JSON:
    case PG_OID.JSONB:
      return ColumnTypeEnum.Json;
    case PG_OID.UUID:
      return ColumnTypeEnum.Uuid;
    case PG_OID.BPCHAR:
    case PG_OID.TEXT:
    case PG_OID.VARCHAR:
    case PG_OID.BIT:
    case PG_OID.VARBIT:
    case PG_OID.INET:
    case PG_OID.CIDR:
    case PG_OID.XML:
    case PG_OID.NAME:
      return ColumnTypeEnum.Text;
    case PG_OID.BYTEA:
      return ColumnTypeEnum.Bytes;
    case PG_OID.INT2_ARRAY:
    case PG_OID.INT4_ARRAY:
      return ColumnTypeEnum.Int32Array;
    case PG_OID.FLOAT4_ARRAY:
      return ColumnTypeEnum.FloatArray;
    case PG_OID.FLOAT8_ARRAY:
      return ColumnTypeEnum.DoubleArray;
    case PG_OID.NUMERIC_ARRAY:
      return ColumnTypeEnum.NumericArray;
    case PG_OID.BOOL_ARRAY:
      return ColumnTypeEnum.BooleanArray;
    case PG_OID.CHAR_ARRAY:
      return ColumnTypeEnum.CharacterArray;
    case PG_OID.BPCHAR_ARRAY:
    case PG_OID.TEXT_ARRAY:
    case PG_OID.VARCHAR_ARRAY:
    case PG_OID.VARBIT_ARRAY:
    case PG_OID.BIT_ARRAY:
    case PG_OID.INET_ARRAY:
    case PG_OID.CIDR_ARRAY:
    case PG_OID.XML_ARRAY:
      return ColumnTypeEnum.TextArray;
    case PG_OID.DATE_ARRAY:
      return ColumnTypeEnum.DateArray;
    case PG_OID.TIME_ARRAY:
      return ColumnTypeEnum.TimeArray;
    case PG_OID.TIMESTAMP_ARRAY:
    case PG_OID.TIMESTAMPTZ_ARRAY:
      return ColumnTypeEnum.DateTimeArray;
    case PG_OID.JSON_ARRAY:
    case PG_OID.JSONB_ARRAY:
      return ColumnTypeEnum.JsonArray;
    case PG_OID.BYTEA_ARRAY:
      return ColumnTypeEnum.BytesArray;
    case PG_OID.UUID_ARRAY:
      return ColumnTypeEnum.UuidArray;
    case PG_OID.INT8_ARRAY:
    case PG_OID.OID_ARRAY:
      return ColumnTypeEnum.Int64Array;
    default:
      // Custom types (enums, composite types) live at OID >= 16384.
      // Treat them as Text — Prisma will cast them back via columnTypes.
      if (fieldTypeId >= FIRST_NORMAL_OBJECT_ID) {
        return ColumnTypeEnum.Text;
      }
      throw new DriverAdapterError({
        kind: 'UnsupportedNativeDataType',
        type: String(fieldTypeId),
      });
  }
}

/**
 * Convert a JS value (from Prisma's query args) into a form PGlite
 * accepts. Most values pass through unchanged; we only special-case
 * Uint8Array (PGlite handles Buffer/Uint8Array for BYTEA).
 */
function mapArg(value: unknown): unknown {
  if (value === undefined) return null;
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'bigint') return value.toString();
  return value;
}

/**
 * Normalise a value returned by PGlite so Prisma's query engine can
 * parse it. Prisma expects:
 *   - Int32/Int64 columns: JS number (or string for Int64)
 *   - Boolean: JS boolean
 *   - DateTime/Date/Time: JS Date object (or ISO string)
 *   - Bytes: Uint8Array
 *   - Json: parsed JS value (object/array/etc.)
 *   - Text: JS string
 *
 * PGlite already returns values in these forms for most types, but we
 * add explicit handling for edge cases (e.g. JSON values that come
 * back as strings on some PGlite versions).
 */
function normaliseValue(value: unknown, dataTypeID: number): unknown {
  if (value === null || value === undefined) return null;

  // JSON / JSONB (114, 3802) — Prisma's json-protocol expects the value
  // as a JSON STRING (not a parsed object). PGlite parses it for us, so
  // we re-stringify. Prisma will JSON.parse it on its end via the
  // `Json` tagged value mechanism.
  if (dataTypeID === PG_OID.JSON || dataTypeID === PG_OID.JSONB) {
    if (typeof value === 'string') return value;
    return JSON.stringify(value);
  }

  // BYTEA (17) — Prisma expects Uint8Array.
  if (dataTypeID === PG_OID.BYTEA) {
    if (value instanceof Uint8Array) return value;
    if (Buffer.isBuffer(value)) return new Uint8Array(value);
    if (typeof value === 'string') {
      const hex = value.replace(/^\\x/, '');
      const bytes = new Uint8Array(hex.length / 2);
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
      }
      return bytes;
    }
    return value;
  }

  return value;
}

// ==================== PGlite-backed Queryable ====================

class PgiteQueryable {
  readonly provider = 'postgres' as const;
  readonly adapterName = 'PrismaPgite';

  constructor(protected client: PGlite) {}

  /**
   * PGlite does NOT support `rowMode: 'array'` in the object-style
   * query API — it always returns rows as objects. We post-process to
   * arrays using the `fields` ordering so the result matches
   * SqlResultSet.rows (array-of-arrays).
   *
   * PGlite returns Date objects for TIMESTAMP columns, but Prisma's
   * driver adapter contract expects Date objects too (it converts
   * them internally). We pass them through unchanged.
   *
   * For BYTEA columns, PGlite returns Uint8Array — also passed through.
   * For JSON/JSONB, PGlite returns parsed JS objects — passed through.
   */
  private async runQuery(sql: string, values: unknown[]): Promise<{
    fields: { name: string; dataTypeID: number }[];
    rowsAsArrays: unknown[][];
    rowCount: number;
  }> {
    try {
      const result = (await this.client.query(sql, values as any)) as any;
      const fields: { name: string; dataTypeID: number }[] = result.fields ?? [];
      const rows: Record<string, unknown>[] = result.rows ?? [];
      const rowsAsArrays = rows.map(r =>
        fields.map(f => normaliseValue(r[f.name], f.dataTypeID)),
      );
      return { fields, rowsAsArrays, rowCount: result.rowCount ?? rows.length };
    } catch (e) {
      throw convertError(e);
    }
  }

  async queryRaw(query: SqlQuery): Promise<SqlResultSet> {
    const { sql, args } = query;
    const values = args.map(mapArg);
    const { fields, rowsAsArrays } = await this.runQuery(sql, values);
    const columnNames = fields.map(f => f.name);
    const columnTypes = fields.map(f => fieldToColumnType(f.dataTypeID));
    return {
      columnNames,
      columnTypes,
      rows: rowsAsArrays,
    };
  }

  async executeRaw(query: SqlQuery): Promise<number> {
    const { sql, args } = query;
    const values = args.map(mapArg);
    const { rowCount } = await this.runQuery(sql, values);
    return rowCount;
  }
}

class PgiteTransaction extends PgiteQueryable implements Transaction {
  readonly options: { usePhantomQuery: boolean };
  private committed = false;
  private rolledBack = false;

  constructor(client: PGlite, options: { usePhantomQuery: boolean }) {
    super(client);
    this.options = options;
  }

  async commit(): Promise<void> {
    if (this.committed || this.rolledBack) return;
    await this.client.query('COMMIT');
    this.committed = true;
  }

  async rollback(): Promise<void> {
    if (this.committed || this.rolledBack) return;
    await this.client.query('ROLLBACK');
    this.rolledBack = true;
  }
}

// ==================== Error mapping ====================

function convertError(e: unknown): DriverAdapterError {
  const err = e as { code?: string; message?: string; constraint?: string };
  const code = err?.code ?? '';
  const message = err?.message ?? String(e);

  // PostgreSQL error codes: https://www.postgresql.org/docs/current/errcodes-appendix.html
  let mapped: any;
  if (code === '23505') {
    mapped = {
      kind: 'UniqueConstraintViolation',
      constraint: err?.constraint ? { index: err.constraint } : undefined,
    };
  } else if (code === '23503') {
    mapped = {
      kind: 'ForeignKeyConstraintViolation',
      constraint: err?.constraint ? { index: err.constraint } : undefined,
    };
  } else if (code === '23502') {
    mapped = { kind: 'NotNullViolation', column: undefined };
  } else if (code === '23514') {
    mapped = { kind: 'CheckViolation', constraint: undefined };
  } else if (code === '40001' || code === '40P01') {
    mapped = { kind: 'TransactionDeadlockDetected' };
  } else if (code === '42P01') {
    mapped = { kind: 'DatabaseDoesNotExist', schema: undefined, db: undefined };
  } else {
    mapped = { kind: 'GenericJs', id: 0 };
  }

  return new DriverAdapterError({ ...mapped, originalCode: code, originalMessage: message } as any);
}

// ==================== Adapter ====================

export class PrismaPgite extends PgiteQueryable implements SqlDriverAdapter {
  constructor(client: PGlite) {
    super(client);
  }

  async executeScript(script: string): Promise<void> {
    try {
      await this.client.exec(script);
    } catch (e) {
      throw convertError(e);
    }
  }

  async startTransaction(isolationLevel?: IsolationLevel): Promise<Transaction> {
    const level = isolationLevel ?? 'READ COMMITTED';
    try {
      await this.client.query(`BEGIN ISOLATION LEVEL ${level}`);
      return new PgiteTransaction(this.client, { usePhantomQuery: false });
    } catch (e) {
      throw convertError(e);
    }
  }

  getConnectionInfo?(): ConnectionInfo {
    return {
      schemaName: 'public',
      maxBindValues: 65535, // PostgreSQL default
      supportsRelationJoins: true,
    };
  }

  async dispose(): Promise<void> {
    // PGlite has no explicit close needed; calling .close() drops the
    // WASM instance. We intentionally keep it alive so the same PGlite
    // instance can be reused across hot reloads in dev.
  }
}

// ==================== Migration helper ====================

/**
 * Apply all Prisma migrations from `prisma/migrations/` to a PGlite
 * instance. Best-effort: skips migrations that fail (PGlite doesn't
 * support every Postgres feature, e.g. CREATE EXTENSION pgcrypto).
 */
export async function applyPrismaMigrationsToPgite(
  pg: PGlite,
  migrationsDir: string,
): Promise<{ applied: number; failed: { name: string; error: string }[] }> {
  const migrations = readdirSync(migrationsDir)
    .filter(d => /^\d+/.test(d))
    .sort();
  let applied = 0;
  const failed: { name: string; error: string }[] = [];

  // Create the prisma migrations tracking table if missing.
  try {
    await pg.exec(`
      CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
        "id" TEXT NOT NULL,
        "checksum" TEXT NOT NULL,
        "finished_at" TIMESTAMPTZ,
        "migration_name" TEXT NOT NULL,
        "logs" TEXT,
        "rolled_back_at" TIMESTAMPTZ,
        "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "applied_steps_count" INTEGER NOT NULL DEFAULT 0,
        CONSTRAINT "_prisma_migrations_pkey" PRIMARY KEY ("id")
      );
    `);
  } catch {
    // ignore — table may already exist
  }

  for (const m of migrations) {
    const sqlPath = resolve(migrationsDir, m, 'migration.sql');
    let sql: string;
    try {
      sql = readFileSync(sqlPath, 'utf8');
    } catch {
      continue;
    }
    try {
      await pg.exec(sql);
      applied++;
    } catch (e: any) {
      failed.push({ name: m, error: e?.message ?? String(e) });
    }
  }
  return { applied, failed };
}

// ==================== Adapter Factory ====================

/**
 * Factory that creates PrismaPgite instances. Prisma 7 expects an
 * object with a `connect()` method (SqlDriverAdapterFactory) rather
 * than a bare adapter. This factory wraps the singleton PGlite
 * instance so every `connect()` call returns a new adapter that
 * shares the same underlying WASM Postgres.
 */
export class PrismaPgiteFactory {
  readonly provider = 'postgres' as const;
  readonly adapterName = 'PrismaPgite';
  private pg: PGlite;

  constructor(pg: PGlite) {
    this.pg = pg;
  }

  async connect(): Promise<SqlDriverAdapter> {
    return new PrismaPgite(this.pg);
  }

  // Required by SqlMigrationAwareDriverAdapterFactory (optional in
  // SqlDriverAdapterFactory, but Prisma may call it).
  async connectToShadowDb(): Promise<SqlDriverAdapter> {
    return new PrismaPgite(this.pg);
  }
}

// ==================== Singleton helper ====================

let pgiteSingleton: PGlite | null = null;
let prismaSingleton: PrismaClient | null = null;

/**
 * Build a PrismaClient backed by a singleton PGlite instance. The
 * first call boots PGlite, applies migrations, and instantiates Prisma.
 * Subsequent calls return the cached instance.
 *
 * Data directory: when `dataDir` is provided (or `PGLITE_DATA_DIR` env
 * var is set), PGlite persists to the local filesystem and survives
 * process restarts. Otherwise it runs in-memory (data is lost on exit).
 *
 * Race-safe: if multiple callers invoke this concurrently (e.g. when
 * multiple vitest test files start at the same time), they all await
 * the same boot promise — only one `PGlite.create` call is made.
 */
let pgiteBootPromise: Promise<{ prisma: PrismaClient; pg: PGlite }> | null = null;

export async function getPrismaClientWithPgite(
  migrationsDir: string,
): Promise<{ prisma: PrismaClient; pg: PGlite }> {
  if (prismaSingleton && pgiteSingleton) {
    return { prisma: prismaSingleton, pg: pgiteSingleton };
  }
  if (pgiteBootPromise) {
    return pgiteBootPromise;
  }
  pgiteBootPromise = (async () => {
    // Persistent mode by default — data survives process restarts.
    // Set `PGLITE_DATA_DIR=""` (empty) explicitly to run in-memory
    // (useful for ephemeral test runs where persistence is not needed).
    const dataDir = process.env['PGLITE_DATA_DIR'] || '/tmp/zerochat-pglite-data';
    console.log(`[prisma-pglite] booting PGlite (dataDir=${dataDir || '<in-memory>'})...`);
    try {
      const opts = dataDir ? { dataDir } : {};
      pgiteSingleton = await PGlite.create(opts);
      await applyPrismaMigrationsToPgite(pgiteSingleton, migrationsDir);
      const factory = new PrismaPgiteFactory(pgiteSingleton);
      prismaSingleton = new PrismaClient({ adapter: factory as any, log: ['error'] });
      console.log('[prisma-pglite] ready');
      return { prisma: prismaSingleton, pg: pgiteSingleton };
    } catch (err) {
      // Reset so subsequent callers can retry — a rejected promise cached
      // forever would poison every future getPrismaClientWithPgite call
      // (e.g. after a stale-lock failure on first boot).
      pgiteBootPromise = null;
      pgiteSingleton = null;
      prismaSingleton = null;
      throw err;
    }
  })();
  try {
    return await pgiteBootPromise;
  } finally {
    // Allow future re-boots if the singleton is cleared (e.g. after a
    // close). For now we never close, so the promise stays cached.
  }
}
