/**
 * Buffer Utilities for ZeroChat-TS
 * 
 * Provides functions for converting between ArrayBuffer, Uint8Array, and Base64 strings.
 * Used throughout the application for cryptographic operations and data serialization.
 * 
 * @module buffer
 */

/**
 * Converts an ArrayBuffer to a Base64-encoded string.
 * 
 * @param buffer - The ArrayBuffer to convert
 * @returns Base64-encoded string representation of the buffer
 * 
 * @example
 * ```typescript
 * const buffer = new TextEncoder().encode('Hello').buffer;
 * const base64 = arrayBufferToBase64(buffer);
 * // Returns: "SGVsbG8="
 * ```
 */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    if (byte !== undefined) {
      binary += String.fromCharCode(byte);
    }
  }
  return btoa(binary);
}

/**
 * Converts a Base64-encoded string to an ArrayBuffer.
 * 
 * @param base64 - The Base64-encoded string to convert
 * @returns ArrayBuffer containing the decoded bytes
 * 
 * @example
 * ```typescript
 * const base64 = 'SGVsbG8=';
 * const buffer = base64ToArrayBuffer(base64);
 * const text = new TextDecoder().decode(buffer);
 * // Returns: "Hello"
 * ```
 */
export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Converts a Uint8Array to a Base64-encoded string.
 * 
 * @param array - The Uint8Array to convert
 * @returns Base64-encoded string representation of the array
 * 
 * @example
 * ```typescript
 * const array = new Uint8Array([72, 101, 108, 108, 111]);
 * const base64 = uint8ArrayToBase64(array);
 * // Returns: "SGVsbG8="
 * ```
 */
export function uint8ArrayToBase64(array: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < array.length; i++) {
    const byte = array[i];
    if (byte !== undefined) {
      binary += String.fromCharCode(byte);
    }
  }
  return btoa(binary);
}

/**
 * Converts a Base64-encoded string to a Uint8Array.
 * 
 * @param base64 - The Base64-encoded string to convert
 * @returns Uint8Array containing the decoded bytes
 * 
 * @example
 * ```typescript
 * const base64 = 'SGVsbG8=';
 * const array = base64ToUint8Array(base64);
 * // Returns: Uint8Array [72, 101, 108, 108, 111]
 * ```
 */
export function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/**
 * Concatenates multiple ArrayBuffers into a single ArrayBuffer.
 * 
 * @param buffers - Array of ArrayBuffers to concatenate
 * @returns A new ArrayBuffer containing all input buffers in order
 * 
 * @example
 * ```typescript
 * const buffer1 = new TextEncoder().encode('Hello').buffer;
 * const buffer2 = new TextEncoder().encode('World').buffer;
 * const combined = concatArrayBuffers(buffer1, buffer2);
 * // combined contains "HelloWorld" as bytes
 * ```
 */
export function concatArrayBuffers(...buffers: ArrayBuffer[]): ArrayBuffer {
  const totalLength = buffers.reduce((sum, buf) => sum + buf.byteLength, 0);
  const result = new Uint8Array(totalLength);
  
  let offset = 0;
  for (const buffer of buffers) {
    result.set(new Uint8Array(buffer), offset);
    offset += buffer.byteLength;
  }
  
  return result.buffer;
}