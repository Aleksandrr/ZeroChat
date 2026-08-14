/**
 * Cryptographic Utilities for Signal Protocol
 * Provides HMAC, hashing, and key derivation helpers
 */

// @ts-nocheck - Web Crypto API types may vary

// ==================== UUID Generation ====================

/**
 * Convert Uint8Array from WASM generate_uuid() to UUID string format
 * @param bytes - 16 bytes from generate_uuid()
 * @returns UUID string in format xxxxxxxx-xxxx-4xxx-axxx-xxxxxxxxxxxx
 */
export function bytesToUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

// ==================== Random Generation ====================

/**
 * Generate random bytes
 */
export function generateRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/**
 * Generate random integer in range
 */
export function generateRandomInt(min: number, max: number): number {
  const range = max - min + 1;
  const randomBytes = new Uint32Array(1);
  crypto.getRandomValues(randomBytes);
  return min + (randomBytes[0] % range);
}

// ==================== HMAC Operations ====================

/**
 * Calculate HMAC-SHA256
 */
export async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, data);
  return new Uint8Array(signature);
}

/**
 * Verify HMAC-SHA256
 */
export async function verifyHmacSha256(
  key: Uint8Array,
  data: Uint8Array,
  signature: Uint8Array
): Promise<boolean> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
  
  return crypto.subtle.verify('HMAC', cryptoKey, signature, data);
}

// ==================== Hash Operations ====================

/**
 * Calculate SHA-256 hash
 */
export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return new Uint8Array(hashBuffer);
}

/**
 * Calculate SHA-512 hash
 */
export async function sha512(data: Uint8Array): Promise<Uint8Array> {
  const hashBuffer = await crypto.subtle.digest('SHA-512', data);
  return new Uint8Array(hashBuffer);
}

// ==================== Key Derivation ====================

/**
 * Derive key using HKDF (HMAC-based Key Derivation Function)
 */
export async function hkdf(
  inputKeyMaterial: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number
): Promise<Uint8Array> {
  // Extract phase
  const prk = await hmacSha256(salt, inputKeyMaterial);
  
  // Expand phase
  const output = new Uint8Array(length);
  let t = new Uint8Array(0);
  let counter = 1;
  let offset = 0;
  
  while (offset < length) {
    const input = new Uint8Array(t.length + info.length + 1);
    input.set(t, 0);
    input.set(info, t.length);
    input[t.length + info.length] = counter;
    
    t = await hmacSha256(prk, input);
    const copyLength = Math.min(t.length, length - offset);
    output.set(t.slice(0, copyLength), offset);
    
    offset += copyLength;
    counter++;
  }
  
  return output;
}

/**
 * Derive keys using HKDF with info string
 */
export async function deriveKeys(
  sharedSecret: Uint8Array,
  info: string
): Promise<{ encryptionKey: Uint8Array; macKey: Uint8Array }> {
  const infoBytes = new TextEncoder().encode(info);
  const derived = await hkdf(sharedSecret, new Uint8Array(32), infoBytes, 64);
  
  return {
    encryptionKey: derived.slice(0, 32),
    macKey: derived.slice(32, 64),
  };
}

// ==================== AES Operations ====================

/**
 * Encrypt with AES-256-CBC
 */
export async function aesEncrypt(
  key: Uint8Array,
  plaintext: Uint8Array,
  iv?: Uint8Array
): Promise<{ ciphertext: Uint8Array; iv: Uint8Array }> {
  const actualIv = iv || generateRandomBytes(16);
  
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'AES-CBC' },
    false,
    ['encrypt']
  );
  
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-CBC', iv: actualIv },
    cryptoKey,
    plaintext
  );
  
  return {
    ciphertext: new Uint8Array(ciphertext),
    iv: actualIv,
  };
}

/**
 * Decrypt with AES-256-CBC
 */
export async function aesDecrypt(
  key: Uint8Array,
  ciphertext: Uint8Array,
  iv: Uint8Array
): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'AES-CBC' },
    false,
    ['decrypt']
  );
  
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-CBC', iv },
    cryptoKey,
    ciphertext
  );
  
  return new Uint8Array(plaintext);
}

// ==================== Curve25519 Operations ====================

/**
 * Generate X25519 key pair
 */
export async function generateKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: 'X25519' },
    true,
    ['deriveBits']
  );
}

/**
 * Perform X25519 key agreement
 */
export async function deriveSharedSecret(
  privateKey: CryptoKey,
  publicKey: CryptoKey
): Promise<Uint8Array> {
  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'X25519', public: publicKey },
    privateKey,
    256
  );
  
  return new Uint8Array(sharedBits);
}

// ==================== Signature Operations ====================

/**
 * Sign data with Ed25519
 */
export async function signData(
  privateKey: CryptoKey,
  data: Uint8Array
): Promise<Uint8Array> {
  const signature = await crypto.subtle.sign(
    { name: 'Ed25519' },
    privateKey,
    data
  );
  
  return new Uint8Array(signature);
}

/**
 * Verify Ed25519 signature
 */
export async function verifySignature(
  publicKey: CryptoKey,
  data: Uint8Array,
  signature: Uint8Array
): Promise<boolean> {
  return crypto.subtle.verify(
    { name: 'Ed25519' },
    publicKey,
    signature,
    data
  );
}