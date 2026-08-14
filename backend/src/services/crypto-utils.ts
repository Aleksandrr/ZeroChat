/**
 * Crypto Utilities - Utility functions for cryptographic operations
 * 
 * Provides HMAC signing, Base64 encoding/decoding, and key type detection.
 * These utilities are used for request signing (non-Signal authentication).
 */

import * as crypto from 'crypto';

/**
 * SECURITY: HMAC secret — must match frontend's HMAC_SECRET.
 *
 * In development we keep a fallback so local servers boot without
 * extra env configuration. In production the secret MUST be set
 * (and ≥ 32 chars — enforced by `utils/secrets-check.ts` at process
 * start). Throwing at import-time is the last line of defence — if
 * a production deployment somehow skips `secrets-check.ts`, the
 * process will refuse to start rather than sign requests with a
 * well-known default.
 */
function resolveHmacSecret(): string {
  const val = process.env['HMAC_SECRET'];
  if (val) return val;
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('HMAC_SECRET must be set in production');
  }
  return 'zerochat-hmac-secret-change-in-production';
}

const HMAC_SECRET = resolveHmacSecret();

/**
 * Создает HMAC-SHA256 подпись данных
 */
export function createHmac(data: string): string {
  return crypto.createHmac('sha256', HMAC_SECRET).update(data).digest('base64');
}

/**
 * Проверяет HMAC-SHA256 подпись
 */
export function verifyHmac(data: string, signature: string, secret: string = HMAC_SECRET): boolean {
  try {
    const expectedSig = crypto.createHmac('sha256', secret).update(data).digest('base64');
    return crypto.timingSafeEqual(Buffer.from(signature, 'base64'), Buffer.from(expectedSig, 'base64'));
  } catch {
    return false;
  }
}

/**
 * Декодирует Base64 строку в Buffer
 */
export function decodeBase64(base64: string): Buffer {
  return Buffer.from(base64, 'base64');
}

/**
 * Кодирует Buffer в Base64 строку
 */
export function encodeBase64(buffer: Buffer): string {
  return buffer.toString('base64');
}

/**
 * Определяет тип ключа по его длине
 */
export function detectKeyType(pubKey: string): 'x25519' | 'ed25519' | 'ecdsa' | 'unknown' {
  try {
    const decoded = decodeBase64(pubKey);
    if (decoded.length === 33 && decoded[0] === 0x05) {
      return 'x25519'; // X25519 raw format
    }
    if (decoded.length === 32) {
      return 'ed25519'; // Ed25519 raw format
    }
    return 'ecdsa'; // DER or other format
  } catch {
    return 'unknown';
  }
}

/**
 * Проверяет что pubkey является корректным публичным ключом
 */
export function isValidPublicKey(pubKey: string): boolean {
  try {
    const decoded = decodeBase64(pubKey);
    // Принимаем X25519 (33 байта), Ed25519 (32 байта), или DER-encoded
    const keyType = detectKeyType(pubKey);
    return keyType !== 'unknown' && decoded.length > 0;
  } catch {
    return false;
  }
}

/**
 * Проверяет что ключ является Ed25519 ключом (32 байта)
 */
export function isEd25519Key(pubKey: string): boolean {
  try {
    const decoded = decodeBase64(pubKey);
    return decoded.length === 32;
  } catch {
    return false;
  }
}

/**
 * Проверяет что ключ является X25519 ключом (33 байта)
 */
export function isX25519Key(pubKey: string): boolean {
  try {
    const decoded = decodeBase64(pubKey);
    return decoded.length === 33 && decoded[0] === 0x05;
  } catch {
    return false;
  }
}

/**
 * Проверяет что ключ является ECDSA P-256 ключом (65 байт несжатый)
 */
export function isEcdsaP256Key(pubKey: string): boolean {
  try {
    const decoded = decodeBase64(pubKey);
    return decoded.length === 65;
  } catch {
    return false;
  }
}
