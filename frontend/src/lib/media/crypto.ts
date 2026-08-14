/**
 * Media Crypto Utilities
 * Cryptographic helpers for file processing and deduplication
 * 
 * Stage 5.3.4: File hash and ID generation
 */

import { sha256 } from '@/lib/signal/utils/crypto';

/**
 * Convert Uint8Array hash to hex string
 */
function bufferToHex(buffer: Uint8Array): string {
  return Array.from(buffer)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * SHA-256 hash for file content deduplication
 * 
 * @param data - Binary file data
 * @returns Hex-encoded SHA-256 hash string
 */
export async function hashFileContent(data: Uint8Array): Promise<string> {
  const hashBuffer = await sha256(data);
  return bufferToHex(hashBuffer);
}

/**
 * Generate unique attachment ID
 * Uses crypto.randomUUID when available, falls back to timestamp + random
 * 
 * @returns Unique attachment identifier
 */
export function generateAttachmentId(): string {
  // Use native crypto.randomUUID if available
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  
  // Fallback implementation
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 15);
  const random2 = Math.random().toString(36).substring(2, 15);
  return `${timestamp}-${random}-${random2}`;
}

/**
 * Generate a hash from multiple parts (for composite content hashing)
 * 
 * @param parts - Array of Uint8Arrays to hash together
 * @returns Hex-encoded SHA-256 hash string
 */
export async function hashMultipleParts(parts: Uint8Array[]): Promise<string> {
  // Concatenate all parts
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const combined = new Uint8Array(totalLength);
  
  let offset = 0;
  for (const part of parts) {
    combined.set(part, offset);
    offset += part.length;
  }
  
  return hashFileContent(combined);
}

/**
 * Quick hash for metadata (not cryptographically secure, but fast)
 * Uses simple string hashing for non-sensitive data
 * 
 * @param str - String to hash
 * @returns Number hash code
 */
export function quickHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash;
}
