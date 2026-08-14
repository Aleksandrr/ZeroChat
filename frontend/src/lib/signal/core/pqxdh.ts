/**
 * PQXDH (Post-Quantum Extended Diffie-Hellman) Key Exchange
 * Combines X3DH with ML-KEM-1024 (Kyber-1024) for post-quantum security.
 *
 * SECURITY (P0-2): Previous versions of this file declared Kyber-768
 * sizes (1184 / 1088). signal-wasm 0.2.x actually ships Kyber-1024
 * (256-bit PQ security level), so all length checks below now use the
 * FIPS 203 ML-KEM-1024 sizes (1568 / 1568). Public-key validation also
 * accepts the 1569-byte libsignal wire form (1 prefix byte + 1568 raw).
 *
 * PQXDH provides:
 * 1. Classical security via X25519
 * 2. Post-quantum security via ML-KEM-1024 (Kyber-1024, 256-bit PQ)
 * 3. Hybrid key derivation combining both
 *
 * This ensures security even against quantum computers.
 */

// @ts-nocheck - WASM types may not match perfectly

import { base64ToUint8Array,uint8ArrayToBase64 } from '@/lib/utils/buffer';

import type { PreKeyBundle } from '../types';
import { hkdf,sha512 } from '../utils/crypto';

// ==================== Constants ====================

/** PQXDH info string for KDF */
const PQXDH_INFO = 'ZeroChat_PQXDH';

/** ML-KEM-1024 (Kyber-1024) public key size, raw FIPS 203 form. */
const KYBER_PUBLIC_KEY_SIZE = 1568;

/** ML-KEM-1024 (Kyber-1024) public key size, libsignal wire form
 *  (1-byte 0x08 prefix + 1568 raw bytes = 1569 total). signal-wasm's
 *  `generateKyberPreKey` returns this prefixed form. */
const KYBER_PUBLIC_KEY_WIRE_SIZE = 1569;

/** ML-KEM-1024 (Kyber-1024) ciphertext size. */
const KYBER_CIPHERTEXT_SIZE = 1568;

/** ML-KEM-1024 (Kyber-1024) shared secret size. */
const KYBER_SHARED_SECRET_SIZE = 32;

// ==================== Kyber Key Operations ====================

/**
 * Generate ML-KEM-1024 (Kyber-1024) key pair.
 * Note: Actual generation is done by signal-wasm.
 */
export async function generateKyberKeyPair(): Promise<{ publicKey: Uint8Array; privateKey: Uint8Array }> {
  // This is a placeholder - actual Kyber key generation is done by signal-wasm.
  // The placeholder uses the libsignal wire-form length (prefix + raw) so that
  // any code that touches this stub before WASM is loaded still produces a
  // buffer of the right size.
  return {
    publicKey: new Uint8Array(KYBER_PUBLIC_KEY_WIRE_SIZE),
    privateKey: new Uint8Array(0), // Private key stays in WASM
  };
}

/**
 * Kyber encapsulation (encrypt to public key)
 * Returns ciphertext and shared secret
 */
export async function kyberEncapsulate(publicKey: Uint8Array): Promise<{ ciphertext: Uint8Array; sharedSecret: Uint8Array }> {
  // This is handled by signal-wasm
  return {
    ciphertext: new Uint8Array(KYBER_CIPHERTEXT_SIZE),
    sharedSecret: new Uint8Array(KYBER_SHARED_SECRET_SIZE),
  };
}

/**
 * Kyber decapsulation (decrypt with private key)
 * Returns shared secret
 */
export async function kyberDecapsulate(privateKey: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> {
  // This is handled by signal-wasm
  
  return new Uint8Array(KYBER_SHARED_SECRET_SIZE);
}

// ==================== PQXDH Key Exchange ====================

/**
 * Process PQXDH PreKey bundle
 * Combines X3DH with Kyber for hybrid security
 */
export async function processPQXDHBundle(
  client: any,
  recipientId: string,
  recipientDeviceId: number,
  bundle: PreKeyBundle
): Promise<void> {
  if (!client) {
    throw new Error('SignalClient not initialized');
  }
  
  // Validate Kyber components if present
  if (bundle.kyberPreKey) {
    if (!bundle.kyberPreKeyId) {
      throw new Error('Kyber pre-key missing ID');
    }
    
    if (!bundle.kyberPreKeySignature) {
      throw new Error('Kyber pre-key missing signature');
    }
  }
  
  // Process through WASM (handles both X3DH and PQXDH)
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

// ==================== Hybrid Key Derivation ====================

/**
 * Derive hybrid shared secret from classical and post-quantum components
 * SK = KDF(DH_Secret || Kyber_Secret)
 */
export async function deriveHybridSecret(
  classicalSecret: Uint8Array,
  kyberSecret: Uint8Array
): Promise<Uint8Array> {
  // Concatenate both secrets
  const combined = new Uint8Array(classicalSecret.length + kyberSecret.length);
  combined.set(classicalSecret, 0);
  combined.set(kyberSecret, classicalSecret.length);
  
  // Derive final secret using HKDF
  const info = new TextEncoder().encode(PQXDH_INFO);
  return hkdf(combined, new Uint8Array(32), info, 32);
}

/**
 * Derive the PQXDH shared secret
 * Combines X3DH output with Kyber output
 */
export async function derivePQXDHSecret(
  x3dhSecret: Uint8Array,
  kyberCiphertext: Uint8Array,
  kyberSecret: Uint8Array
): Promise<Uint8Array> {
  // Hash all components together
  const input = new Uint8Array(
    x3dhSecret.length + 
    kyberCiphertext.length + 
    kyberSecret.length
  );
  
  input.set(x3dhSecret, 0);
  input.set(kyberCiphertext, x3dhSecret.length);
  input.set(kyberSecret, x3dhSecret.length + kyberCiphertext.length);
  
  return sha512(input).slice(0, 32);
}

// ==================== Kyber Pre-Key Operations ====================

/**
 * Generate Kyber pre-key for bundle
 */
export async function generateKyberPreKey(client: any): Promise<{
  id: number;
  publicKey: Uint8Array;
  signature: Uint8Array;
  record: Uint8Array;
}> {
  if (!client) {
    throw new Error('SignalClient not initialized');
  }
  
  const kyberPreKey = client.generate_kyber_pre_key();
  
  return {
    id: kyberPreKey.id,
    publicKey: kyberPreKey.public_key,
    signature: kyberPreKey.signature,
    record: kyberPreKey.record,
  };
}

/**
 * Export Kyber pre-key for server upload
 */
export async function exportKyberPreKey(client: any, keyId: number): Promise<Uint8Array | null> {
  if (!client || !client.export_kyber_pre_key) {
    return null;
  }
  
  return client.export_kyber_pre_key(keyId);
}

/**
 * Import Kyber pre-key into WASM
 */
export async function importKyberPreKey(
  client: any,
  keyId: number,
  record: Uint8Array
): Promise<void> {
  if (!client || !client.import_kyber_pre_key) {
    throw new Error('Kyber pre-key import not supported');
  }
  
  await client.import_kyber_pre_key(keyId, record);
}

// ==================== Validation ====================

/**
 * Validate Kyber pre-key (ML-KEM-1024).
 * Accepts both raw (1568-byte) and libsignal wire-form (1569-byte) public keys.
 */
export function validateKyberPreKey(
  publicKey: Uint8Array,
  signature: Uint8Array
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  const len = publicKey.length;
  if (len !== KYBER_PUBLIC_KEY_SIZE && len !== KYBER_PUBLIC_KEY_WIRE_SIZE) {
    errors.push(
      `Invalid Kyber public key size: expected ${KYBER_PUBLIC_KEY_SIZE} (raw) ` +
      `or ${KYBER_PUBLIC_KEY_WIRE_SIZE} (prefixed), got ${len}`,
    );
  }

  if (!signature || signature.length === 0) {
    errors.push('Missing Kyber signature');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate Kyber ciphertext (ML-KEM-1024, 1568 bytes raw).
 */
export function validateKyberCiphertext(ciphertext: Uint8Array): boolean {
  return ciphertext.length === KYBER_CIPHERTEXT_SIZE;
}

// ==================== Constants Export ====================

export const KYBER_CONSTANTS = {
  PUBLIC_KEY_SIZE: KYBER_PUBLIC_KEY_SIZE,
  PUBLIC_KEY_WIRE_SIZE: KYBER_PUBLIC_KEY_WIRE_SIZE,
  CIPHERTEXT_SIZE: KYBER_CIPHERTEXT_SIZE,
  SHARED_SECRET_SIZE: KYBER_SHARED_SECRET_SIZE,
};