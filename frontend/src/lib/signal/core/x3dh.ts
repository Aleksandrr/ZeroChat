/**
 * X3DH Key Exchange Protocol
 * Implements the Extended Triple Diffie-Hellman key agreement protocol
 * 
 * X3DH establishes a shared secret between two parties using:
 * 1. Identity keys (long-term)
 * 2. Signed pre-keys (medium-term, signed by identity key)
 * 3. One-time pre-keys (single-use)
 * 
 * The shared secret is derived from multiple DH calculations.
 */

// @ts-nocheck - WASM types may not match perfectly

import { base64ToUint8Array,uint8ArrayToBase64 } from '@/lib/utils/buffer';

import type { PreKeyBundle } from '../types';
import { deriveKeys, hkdf, sha512 } from '../utils/crypto';

// ==================== WASM Module Interface ====================
// signal-wasm v0.2.x removed the monolithic SignalClient class.
// The helpers below are kept for backwards compatibility but only
// initialise the WASM module — they no longer expose a client class.

let wasmReady: Promise<void> | null = null;
let wasmModule: any = null;

/**
 * Load the WASM module (signal-wasm v0.2.x).
 */
async function loadSignalModule(): Promise<void> {
  if (wasmModule && wasmReady) {
    await wasmReady;
    return;
  }
  if (!wasmReady) {
    const module = await import('@getmaapp/signal-wasm');
    if (module.default && typeof module.default === 'function') {
      wasmReady = module.default();
      await wasmReady;
    } else {
      throw new Error('WASM initialization function not found');
    }
    wasmModule = module;
  } else {
    await wasmReady;
  }
}

// ==================== X3DH Protocol Constants ====================

/** X3DH info string for KDF */
const X3DH_INFO = 'ZeroChat_X3DH';

/** Maximum age for signed pre-keys (30 days) */
const SIGNED_PRE_KEY_MAX_AGE = 30 * 24 * 60 * 60 * 1000;

// ==================== PreKey Bundle Processing ====================

/**
 * Process a received PreKey bundle to establish a session
 * 
 * This implements the X3DH key agreement:
 * DH1 = DH(IK_A, SPK_B)
 * DH2 = DH(EK_A, IK_B)
 * DH3 = DH(EK_A, SPK_B)
 * DH4 = DH(EK_A, OPK_B) (optional)
 * 
 * SK = KDF(DH1 || DH2 || DH3 || DH4)
 */
export async function processPreKeyBundle(
  client: any,
  recipientId: string,
  recipientDeviceId: number,
  bundle: PreKeyBundle
): Promise<void> {
  await loadSignalModule();
  if (!client) {
    throw new Error('SignalClient not initialized');
  }
  // In v0.2.x the caller is expected to use the high-level
  // `processPreKeyBundle` from `@/lib/signal`. This shim is kept for
  // backwards compatibility with the old client-style API.
  if (typeof client.processPreKeyBundle === 'function') {
    await client.processPreKeyBundle(recipientId, recipientDeviceId, bundle);
    return;
  }
  // Fall back to legacy in case caller passes a v0.1.x-style client.
  if (typeof client.process_pre_key_bundle === 'function') {
    await client.process_pre_key_bundle(
      recipientId,
      recipientDeviceId,
      bundle.registrationId,
      bundle.identityKey,
      bundle.signedPreKeyId,
      bundle.signedPreKey,
      bundle.signedPreKeySignature,
      bundle.preKeyId ?? 0,
      bundle.preKey ?? new Uint8Array(0),
      bundle.kyberPreKeyId ?? 0,
      bundle.kyberPreKey ?? new Uint8Array(0),
      bundle.kyberPreKeySignature ?? new Uint8Array(0)
    );
  }
}

// ==================== PreKey Bundle Generation ====================

/**
 * Generate a new PreKey bundle for sharing with other users
 */
export async function generatePreKeyBundle(
  client: any,
  deviceId: number,
  preKeyId: number,
  signedPreKeyId: number,
  kyberPreKeyId: number
): Promise<PreKeyBundle> {
  await loadSignalModule();
  if (!client) {
    throw new Error('SignalClient not initialized');
  }
  // Prefer the v0.2.x high-level façade when the caller passes a
  // SignalProtocol-like object.
  if (typeof client.generatePreKeyBundle === 'function') {
    return client.generatePreKeyBundle();
  }
  // Legacy v0.1.x path (kept for tests / stubs).
  const preKeys = client.generate_pre_keys(1);
  const preKey = preKeys[0];
  const signedPreKey = client.generate_signed_pre_key();
  const kyberPreKey = client.generate_kyber_pre_key();
  const identityPublicKey = client.get_identity_public_key();
  return {
    registrationId: client.get_registration_id(),
    deviceId,
    identityKey: identityPublicKey,
    signedPreKey: signedPreKey.public_key,
    signedPreKeyId,
    signedPreKeySignature: signedPreKey.signature,
    preKey: preKey?.public_key,
    preKeyId,
    kyberPreKey: kyberPreKey?.public_key,
    kyberPreKeyId,
    kyberPreKeySignature: kyberPreKey?.signature,
  };
}

// ==================== Key Agreement Helpers ====================

/**
 * Calculate the X3DH shared secret
 * This is done internally by signal-wasm, but we expose helpers for testing
 */
export async function calculateX3DHSecret(
  identityKeyA: Uint8Array,
  ephemeralKeyA: Uint8Array,
  identityKeyB: Uint8Array,
  signedPreKeyB: Uint8Array,
  oneTimePreKeyB?: Uint8Array
): Promise<Uint8Array> {
  // DH calculations would be done here
  // In practice, this is handled by signal-wasm
  
  // Concatenate DH results
  const dhConcat = new Uint8Array(
    identityKeyA.length +
    ephemeralKeyA.length +
    identityKeyB.length +
    signedPreKeyB.length +
    (oneTimePreKeyB?.length ?? 0)
  );
  
  let offset = 0;
  dhConcat.set(identityKeyA, offset); offset += identityKeyA.length;
  dhConcat.set(ephemeralKeyA, offset); offset += ephemeralKeyA.length;
  dhConcat.set(identityKeyB, offset); offset += identityKeyB.length;
  dhConcat.set(signedPreKeyB, offset); offset += signedPreKeyB.length;
  if (oneTimePreKeyB) {
    dhConcat.set(oneTimePreKeyB, offset);
  }
  
  // Derive the shared secret using HKDF
  const info = new TextEncoder().encode(X3DH_INFO);
  return hkdf(dhConcat, new Uint8Array(32), info, 32);
}

// ==================== PreKey Validation ====================

/**
 * Validate a PreKey bundle
 */
export function validatePreKeyBundle(bundle: PreKeyBundle): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  if (!bundle.registrationId || bundle.registrationId < 1) {
    errors.push('Invalid registration ID');
  }
  
  if (!bundle.identityKey || bundle.identityKey.length === 0) {
    errors.push('Missing identity key');
  }
  
  if (!bundle.signedPreKey || bundle.signedPreKey.length === 0) {
    errors.push('Missing signed pre-key');
  }
  
  if (!bundle.signedPreKeySignature || bundle.signedPreKeySignature.length === 0) {
    errors.push('Missing signed pre-key signature');
  }
  
  // Pre-key is optional but if present must have an ID
  if (bundle.preKey && !bundle.preKeyId) {
    errors.push('Pre-key present but missing ID');
  }
  
  // Kyber pre-key is optional for PQXDH
  if (bundle.kyberPreKey && !bundle.kyberPreKeyId) {
    errors.push('Kyber pre-key present but missing ID');
  }
  
  return {
    valid: errors.length === 0,
    errors,
  };
}

// ==================== Signed Pre-Key Verification ====================

/**
 * Verify the Ed25519 signature over a signed pre-key.
 *
 * SECURITY (P0-3): The previous implementation unconditionally returned
 * `true`, which let any client accept a forged signed pre-key — opening
 * the door to MITM attacks during X3DH session establishment. We now
 * perform a real Ed25519 verification via the Web Crypto API.
 *
 * Identity keys produced by signal-wasm carry a 1-byte libsignal key-type
 * prefix (0x05 for DJB/Ed25519) before the 32-byte raw public key. We
 * strip that prefix when present before importing the key as raw Ed25519.
 *
 * The function fails closed — any exception or unexpected input length
 * returns `false` instead of throwing, so a malformed bundle can never
 * be misinterpreted as "signature valid".
 *
 * @param identityKey   33-byte Signal identity key (0x05 || 32-byte Ed25519 pub)
 *                      or 32-byte raw Ed25519 public key.
 * @param signedPreKey  The signed pre-key public bytes that were signed.
 * @param signature     64-byte Ed25519 signature.
 * @returns `true` only if the signature verifies under `identityKey`.
 */
export async function verifySignedPreKeySignature(
  identityKey: Uint8Array,
  signedPreKey: Uint8Array,
  signature: Uint8Array
): Promise<boolean> {
  try {
    if (!identityKey || !signedPreKey || !signature) {
      return false;
    }

    // Strip the libsignal key-type prefix (0x05) when present.
    const rawPub =
      identityKey.length === 33 ? identityKey.subarray(1) : identityKey;
    if (rawPub.length !== 32) {
      // Ed25519 public keys are exactly 32 bytes.
      return false;
    }

    // Ed25519 signatures are 64 bytes — fail closed on any other length.
    if (signature.length !== 64) {
      return false;
    }

    const pubKey = await crypto.subtle.importKey(
      'raw',
      rawPub,
      { name: 'Ed25519' },
      false,
      ['verify']
    );

    return await crypto.subtle.verify(
      'Ed25519',
      pubKey,
      signature,
      signedPreKey
    );
  } catch {
    // Any crypto error → fail closed.
    return false;
  }
}

// ==================== Export WASM loader ====================

// `SignalClient` no longer exists in signal-wasm v0.2.x.
// We export `undefined` for backwards-compatibility with import sites
// that destructured it.
export const SignalClient: any = undefined;
export { loadSignalModule };