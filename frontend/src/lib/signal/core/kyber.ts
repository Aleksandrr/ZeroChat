/**
 * ML-KEM-1024 (Kyber-1024) Operations
 * Module-MLWE-Based Key Encapsulation Mechanism (KEM)
 *
 * SECURITY (P0-2): The previous version of this file incorrectly declared
 * Kyber-768 constants (KYBER_K=3, public key 1184 bytes). The actual
 * signal-wasm 0.2.0 build ships Kyber-1024 (ML-KEM-1024 / 256-bit PQ
 * security level — see the README: "Post-Quantum Ready — Kyber1024 (PQXDH)").
 * Calling Kyber-768 "Kyber-768" while shipping 1024 was both a code-comment
 * lie and a parameter-size mismatch that caused `validatePublicKey()` to
 * reject every real pre-key (signal-wasm returns a 1-byte-prefixed 1568-
 * byte raw key, not 1184 bytes).
 *
 * Constants now follow FIPS 203 (ML-KEM-1024):
 *   - K  = 4
 *   - N  = 256
 *   - Q  = 3329
 *   - public key   = 12*K*N/8 + 32  = 1568 bytes (raw)
 *   - secret key   = 24*K*N/8 + 3*32 = 3168 bytes (raw)
 *   - ciphertext   = du*K*N/8 + dv*N/8 with du=11, dv=5 = 1568 bytes
 *   - shared secret = 32 bytes
 *
 * Note: signal-wasm's serialized Kyber public key has a 1-byte libsignal
 * key-type prefix (0x08 for Kyber1024) prepended, so the on-the-wire size
 * is 1569 bytes. `validatePublicKey()` accepts both the raw (1568) and
 * prefixed (1569) forms.
 *
 * Actual cryptographic operations are delegated to signal-wasm.
 */

// ==================== ML-KEM-1024 (FIPS 203) Constants ====================

/** ML-KEM-1024 polynomial degree (n) */
export const KYBER_N = 256;

/** ML-KEM-1024 modulus (q) */
export const KYBER_Q = 3329;

/** ML-KEM-1024 number of polynomials in vectors (k) */
export const KYBER_K = 4;

/** Size of a single compressed polynomial (used for ciphertext component v) */
export const KYBER_POLY_COMPRESSED_BYTES = 32;

/** Size of a polynomial vector when byte-encoded at 12 bits/coefficient.
 *  12 * K * N / 8 = 12 * 4 * 256 / 8 = 1536 bytes. */
export const KYBER_POLYVECBYTES = (12 * KYBER_K * KYBER_N) / 8;

/** Size of an IND-CCA public key (raw, FIPS 203): 12*K*N/8 + 32 = 1568. */
export const KYBER_PUBLICKEYBYTES = (12 * KYBER_K * KYBER_N) / 8 + 32;

/** Size of an IND-CCA secret key (raw, FIPS 203): 24*K*N/8 + 3*32 = 3168. */
export const KYBER_SECRETKEYBYTES = (24 * KYBER_K * KYBER_N) / 8 + 3 * 32;

/** Size of an IND-CCA ciphertext (raw, FIPS 203): du*K*N/8 + dv*N/8 = 1568
 *  for ML-KEM-1024 (du=11, dv=5). */
export const KYBER_CIPHERTEXTBYTES = (11 * KYBER_K * KYBER_N) / 8 + (5 * KYBER_N) / 8;

/** Size of the shared secret */
export const KYBER_SSBYTES = 32;

/** Size of the symmetric key used for derived keys */
export const KYBER_SYMBYTES = 32;

/** libsignal wire-format prefix byte for Kyber-1024 public keys. */
export const KYBER_PUBLIC_KEY_PREFIX = 0x08;

/** On-the-wire length of a signal-wasm Kyber-1024 public key (prefix + raw). */
export const KYBER_PUBLICKEY_WIRE_BYTES = KYBER_PUBLICKEYBYTES + 1;

// ==================== Kyber API (Delegated to WASM) ====================

/**
 * Generate an ML-KEM-1024 (Kyber-1024) key pair.
 * Actual implementation is in signal-wasm.
 */
export interface KyberKeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

/**
 * Kyber encapsulation result
 */
export interface KyberEncapsulation {
  ciphertext: Uint8Array;
  sharedSecret: Uint8Array;
}

/**
 * Kyber operations interface (delegated to WASM)
 */
export interface KyberOperations {
  /**
   * Generate a new Kyber key pair
   */
  generateKeyPair(): Promise<KyberKeyPair>;
  
  /**
   * Encapsulate to a public key
   * Returns ciphertext and shared secret
   */
  encapsulate(publicKey: Uint8Array): Promise<KyberEncapsulation>;
  
  /**
   * Decapsulate a ciphertext
   * Returns shared secret
   */
  decapsulate(privateKey: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array>;
}

// ==================== Validation Functions ====================

/**
 * Validate a Kyber-1024 public key.
 *
 * Accepts both the raw FIPS-203 form (1568 bytes) and the libsignal
 * wire form (1 prefix byte + 1568 bytes = 1569 bytes), which is what
 * signal-wasm returns from `generateKyberPreKey`.
 */
export function validatePublicKey(publicKey: Uint8Array): { valid: boolean; error?: string } {
  if (!publicKey) {
    return { valid: false, error: 'Public key is null or undefined' };
  }

  const len = publicKey.length;
  if (len !== KYBER_PUBLICKEYBYTES && len !== KYBER_PUBLICKEY_WIRE_BYTES) {
    return {
      valid: false,
      error:
        `Invalid public key size: expected ${KYBER_PUBLICKEYBYTES} (raw) ` +
        `or ${KYBER_PUBLICKEY_WIRE_BYTES} (prefixed), got ${len}`,
    };
  }

  return { valid: true };
}

/**
 * Validate a Kyber secret key
 */
export function validateSecretKey(secretKey: Uint8Array): { valid: boolean; error?: string } {
  if (!secretKey) {
    return { valid: false, error: 'Secret key is null or undefined' };
  }
  
  if (secretKey.length !== KYBER_SECRETKEYBYTES) {
    return {
      valid: false,
      error: `Invalid secret key size: expected ${KYBER_SECRETKEYBYTES}, got ${secretKey.length}`,
    };
  }
  
  return { valid: true };
}

/**
 * Validate a Kyber ciphertext
 */
export function validateCiphertext(ciphertext: Uint8Array): { valid: boolean; error?: string } {
  if (!ciphertext) {
    return { valid: false, error: 'Ciphertext is null or undefined' };
  }
  
  if (ciphertext.length !== KYBER_CIPHERTEXTBYTES) {
    return {
      valid: false,
      error: `Invalid ciphertext size: expected ${KYBER_CIPHERTEXTBYTES}, got ${ciphertext.length}`,
    };
  }
  
  return { valid: true };
}

/**
 * Validate a shared secret
 */
export function validateSharedSecret(sharedSecret: Uint8Array): { valid: boolean; error?: string } {
  if (!sharedSecret) {
    return { valid: false, error: 'Shared secret is null or undefined' };
  }
  
  if (sharedSecret.length !== KYBER_SSBYTES) {
    return {
      valid: false,
      error: `Invalid shared secret size: expected ${KYBER_SSBYTES}, got ${sharedSecret.length}`,
    };
  }
  
  return { valid: true };
}

// ==================== Helper Functions ====================

/**
 * Compare two Kyber public keys
 */
export function publicKeysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Check if a buffer has a correct Kyber-1024 public key size (raw or prefixed).
 */
export function isKyberPublicKey(buffer: Uint8Array): boolean {
  return !!buffer && (buffer.length === KYBER_PUBLICKEYBYTES || buffer.length === KYBER_PUBLICKEY_WIRE_BYTES);
}

/**
 * Check if a buffer has correct Kyber ciphertext size
 */
export function isKyberCiphertext(buffer: Uint8Array): boolean {
  return buffer && buffer.length === KYBER_CIPHERTEXTBYTES;
}

// ==================== WASM Integration ====================

let wasmKyber: any = null;

/**
 * Initialize Kyber WASM module (kept for backwards compatibility —
 * signal-wasm 0.2.x uses ML-KEM-1024 / Kyber-1024 internally and does
 * not expose a variant selector).
 */
export async function initKyberWasm(wasmModule: any): Promise<void> {
  wasmKyber = wasmModule;
}

/**
 * Check if Kyber WASM is available
 */
export function isKyberWasmAvailable(): boolean {
  return wasmKyber !== null;
}

/**
 * Get Kyber operations from WASM
 */
export function getKyberOperations(): KyberOperations | null {
  if (!wasmKyber) {
    return null;
  }
  
  return {
    async generateKeyPair(): Promise<KyberKeyPair> {
      // Actual implementation is in signal-wasm
      throw new Error('Use signal-wasm for key generation');
    },
    
    async encapsulate(publicKey: Uint8Array): Promise<KyberEncapsulation> {
      const validation = validatePublicKey(publicKey);
      if (!validation.valid) {
        throw new Error(validation.error);
      }
      // Actual implementation is in signal-wasm
      throw new Error('Use signal-wasm for encapsulation');
    },
    
    async decapsulate(privateKey: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> {
      const skValidation = validateSecretKey(privateKey);
      if (!skValidation.valid) {
        throw new Error(skValidation.error);
      }
      const ctValidation = validateCiphertext(ciphertext);
      if (!ctValidation.valid) {
        throw new Error(ctValidation.error);
      }
      // Actual implementation is in signal-wasm
      throw new Error('Use signal-wasm for decapsulation');
    },
  };
}

// ==================== Debug Utilities ====================

/**
 * Get key sizes for debugging
 */
export function getKeySizes(): {
  publicKey: number;
  secretKey: number;
  ciphertext: number;
  sharedSecret: number;
} {
  return {
    publicKey: KYBER_PUBLICKEYBYTES,
    secretKey: KYBER_SECRETKEYBYTES,
    ciphertext: KYBER_CIPHERTEXTBYTES,
    sharedSecret: KYBER_SSBYTES,
  };
}

/**
 * Log key information for debugging
 */
export function logKeyInfo(publicKey: Uint8Array, label = 'Key'): void {
  // Debug utility - no output in production
}

/**
 * Log ciphertext information for debugging
 */
export function logCiphertextInfo(ciphertext: Uint8Array, label = 'Ciphertext'): void {
  // Debug utility - no output in production
}