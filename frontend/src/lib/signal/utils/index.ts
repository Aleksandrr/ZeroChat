/**
 * Signal Protocol Utilities Module
 * Re-exports utility functions
 */

// Re-export buffer utilities from shared location
export {
  arrayBufferToBase64,
  base64ToArrayBuffer,
  base64ToUint8Array,
  concatArrayBuffers,
  uint8ArrayToBase64,
} from '@/lib/utils/buffer';

// Crypto utilities
export {
  aesDecrypt,
  aesEncrypt,
  bytesToUuid,
  deriveKeys,
  deriveSharedSecret,
  generateKeyPair,
  generateRandomBytes,
  generateRandomInt,
  hkdf,
  hmacSha256,
  sha256,
  sha512,
  signData,
  verifyHmacSha256,
  verifySignature,
} from './crypto';