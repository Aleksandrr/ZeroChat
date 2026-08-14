/**
 * Server-side encryption-at-rest for sensitive database columns.
 *
 * Uses AES-256-GCM with a server-wide key derived from the
 * ENCRYPTION_KEY environment variable (or a dev fallback).
 *
 * The key is derived via scrypt(N=16384) so that even if the env
 * var is short, the actual AES key has full 256-bit entropy.
 *
 * Encrypted values are stored as: `enc:v1:<salt-hex>:<iv-hex>:<ciphertext-hex>`
 * The `enc:v1:` prefix lets us detect plaintext values (for migration).
 *
 * SECURITY: The SALT is derived deterministically from the
 * `ENCRYPTION_SALT` environment variable (32 hex chars = 16 bytes).
 * Without this, a process restart would produce a different AES key
 * and every previously-encrypted `signatureKeyPriv` column would
 * become unreadable.
 *
 * In development, when `ENCRYPTION_SALT` is not set, we fall back
 * to a fixed `"zerochat-dev-salt-v1"` (utf-8 bytes) so local DBs
 * keep working across restarts. In production the missing env var
 * is a fatal error — see `utils/secrets-check.ts`.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/**
 * SECURITY: master encryption key for at-rest columns.
 *
 * In development we keep a fallback so local servers boot without
 * extra env configuration. In production the key MUST be set
 * (and ≥ 32 chars — enforced by `utils/secrets-check.ts` at process
 * start). Throwing at import-time is the last line of defence — if
 * a production deployment somehow skips `secrets-check.ts`, the
 * process will refuse to start rather than encrypt private keys
 * with a well-known default.
 */
function resolveEncryptionKey(): string {
  const val = process.env['ENCRYPTION_KEY'];
  if (val) return val;
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('ENCRYPTION_KEY must be set in production');
  }
  return 'dev-encryption-key-change-in-production';
}

const ENCRYPTION_KEY = resolveEncryptionKey();

/**
 * Resolve the scrypt salt deterministically:
 *
 *   1. If `ENCRYPTION_SALT` env var is set, it must be 32 hex chars
 *      (16 bytes). We decode it to a Buffer.
 *   2. Otherwise, in development we use a fixed utf-8 fallback so
 *      local data survives restarts.
 *   3. In production the missing env var is fatal — throwing here
 *      is the last line of defence; `secrets-check.ts` should
 *      already have exited the process before this module loads.
 */
function resolveSalt(): Buffer {
  const envSalt = process.env['ENCRYPTION_SALT'];
  if (envSalt) {
    if (!/^[0-9a-fA-F]{32}$/.test(envSalt)) {
      throw new Error(
        'ENCRYPTION_SALT must be 32 hex chars (16 bytes). ' +
        'Set it to a fresh value from `crypto.randomBytes(16).toString("hex")`.',
      );
    }
    return Buffer.from(envSalt, 'hex');
  }
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error(
      'ENCRYPTION_SALT must be set in production (32 hex chars / 16 bytes).',
    );
  }
  // Dev-only fallback. Never used in production.
  return Buffer.from('zerochat-dev-salt-v1', 'utf8');
}

const SALT = resolveSalt();
const AES_KEY = scryptSync(ENCRYPTION_KEY, SALT, 32, { N: 16384, r: 8, p: 1 });

const PREFIX = 'enc:v1:';

/**
 * Encrypt a plaintext string for storage in the database.
 * Returns `enc:v1:<salt-hex>:<iv-hex>:<ciphertext-hex>`.
 */
export function encryptAtRest(plaintext: string): string {
  if (!plaintext || plaintext.startsWith(PREFIX)) return plaintext; // Already encrypted
  const iv = randomBytes(12); // 96-bit IV for GCM
  const cipher = createCipheriv('aes-256-gcm', AES_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Include auth tag in the stored value (appended to ciphertext)
  const combined = Buffer.concat([encrypted, authTag]);
  return `${PREFIX}${SALT.toString('hex')}:${iv.toString('hex')}:${combined.toString('hex')}`;
}

/**
 * Decrypt a value encrypted by encryptAtRest().
 * If the value doesn't have the `enc:v1:` prefix, returns it as-is
 * (for backward compatibility with pre-encryption data).
 *
 * SECURITY: If the GCM auth tag verification fails (tampering or
 * wrong key), we THROW an Error rather than silently returning the
 * raw ciphertext. Callers may catch the error and decide what to
 * do (e.g. for SenderKeyDistribution we simply ignore the damaged
 * row), but the default behaviour is loud-fail so we never treat
 * a tampered blob as plaintext.
 */
export function decryptAtRest(stored: string): string {
  if (!stored || !stored.startsWith(PREFIX)) return stored;
  const parts = stored.substring(PREFIX.length).split(':');
  if (parts.length !== 3) {
    throw new Error('At-rest decryption failed: malformed ciphertext');
  }
  const [, ivHex, combinedHex] = parts;
  if (!ivHex || !combinedHex) {
    throw new Error('At-rest decryption failed: malformed ciphertext');
  }
  const iv = Buffer.from(ivHex, 'hex');
  const combined = Buffer.from(combinedHex, 'hex');
  // Last 16 bytes are the GCM auth tag
  if (combined.length < 16) {
    throw new Error('At-rest decryption failed: truncated ciphertext');
  }
  const ciphertext = combined.subarray(0, combined.length - 16);
  const authTag = combined.subarray(combined.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', AES_KEY, iv);
  decipher.setAuthTag(authTag);
  let plaintext: string;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // GCM auth tag verification failed — this is either tampering or
    // a wrong key. Either way, do NOT return the raw value.
    throw new Error('At-rest decryption failed: integrity check failed');
  }
  return plaintext;
}

/**
 * Check if a value is encrypted (has the enc:v1: prefix).
 */
export function isEncrypted(value: string): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX);
}
