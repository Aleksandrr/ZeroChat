/**
 * HMAC Signing Module
 *
 * Provides HMAC-SHA256 helpers built on top of the Web Crypto API.
 *
 * SECURITY (P0-1): The legacy `HMAC_MASTER_SECRET` constant that read
 * `import.meta.env['VITE_HMAC_SECRET']` has been removed. That value was
 * embedded into the production bundle and could be recovered from DevTools,
 * which would let an attacker forge `X-Signature` headers for
 * `/keys/pqxdh/publish` on behalf of any user. Key-publication requests
 * now rely solely on the JWT in `Authorization: Bearer` (see
 * `services/auth/api.ts::publishSignalKeys`); the server is responsible
 * for any server-side HMAC it needs.
 *
 * The helpers below are retained for unrelated callers (e.g. device
 * verification flows) but they now REQUIRE an explicit `key` argument —
 * there is no master-secret fallback.
 *
 * @module auth/hmac
 */

import { arrayBufferToBase64 } from '@/lib/utils/buffer';

// ==================== HMAC Functions ====================

/**
 * Generate an HMAC-SHA256 signature.
 *
 * SECURITY (P0-1): `key` is MANDATORY — there is no master-secret default.
 * Callers must pass a per-call secret (e.g. derived from a session-scoped
 * nonce) and must never hard-code or read secrets from `import.meta.env`.
 *
 * @param data - Data string to sign
 * @param key  - Secret key (UTF-8) for HMAC. Required.
 * @returns Base64-encoded HMAC-SHA256 signature
 */
export async function generateHmac(data: string, key: string): Promise<string> {
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error(
      'generateHmac: a non-empty `key` argument is required (P0-1: master-secret default removed).',
    );
  }
  const encoder = new TextEncoder();
  const keyData = encoder.encode(key);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data));
  return arrayBufferToBase64(signature);
}

/**
 * Verify an HMAC-SHA256 signature in constant-time-ish fashion.
 *
 * SECURITY (P0-1): `key` is MANDATORY.
 *
 * @param signature - Base64-encoded signature to verify
 * @param data      - Original data that was signed
 * @param key       - Secret key (UTF-8) for HMAC. Required.
 * @returns `true` if the signature matches
 */
export async function verifyHmac(signature: string, data: string, key: string): Promise<boolean> {
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error(
      'verifyHmac: a non-empty `key` argument is required (P0-1: master-secret default removed).',
    );
  }
  const expectedSignature = await generateHmac(data, key);

  // Constant-time-ish comparison to avoid timing side-channels.
  if (signature.length !== expectedSignature.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < signature.length; i++) {
    diff |= signature.charCodeAt(i) ^ expectedSignature.charCodeAt(i);
  }
  return diff === 0;
}

// ==================== Key Publication Signing ====================
//
// SECURITY (P0-1): `createHmacSignature`, `buildKeyPublicationPayload`,
// and `signKeyPublication` were removed because they relied on the
// client-side `HMAC_MASTER_SECRET` derived from `VITE_HMAC_SECRET`.
// `/keys/pqxdh/publish` now authenticates exclusively through the JWT
// in `Authorization: Bearer` (see `services/auth/api.ts::publishSignalKeys`).
//
// We re-export lightweight stubs that throw a descriptive error so that
// any stale import sites fail loudly instead of silently shipping an
// insecure request.

/** @deprecated P0-1: removed — server now authenticates via JWT only. */
export async function createHmacSignature(
  _timestamp: string,
  _userId: string,
  _deviceId: string,
  _payload: string,
): Promise<string> {
  throw new Error(
    'createHmacSignature removed (P0-1): /keys/pqxdh/publish now uses JWT-only authentication.',
  );
}

/** @deprecated P0-1: removed — server now authenticates via JWT only. */
export function buildKeyPublicationPayload(
  _keys: unknown,
): Record<string, unknown> {
  throw new Error(
    'buildKeyPublicationPayload removed (P0-1): use services/auth/api.ts::publishSignalKeys instead.',
  );
}

/** @deprecated P0-1: removed — server now authenticates via JWT only. */
export async function signKeyPublication(_keys: unknown): Promise<{
  payload: string;
  timestamp: string;
  signature: string;
}> {
  throw new Error(
    'signKeyPublication removed (P0-1): /keys/pqxdh/publish now uses JWT-only authentication.',
  );
}
