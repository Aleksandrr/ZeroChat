/**
 * Tests for lib/utils/buffer.ts — base64 / Uint8Array / ArrayBuffer helpers.
 *
 * Verifies round-trip correctness for every conversion pair and edge cases
 * (empty input, single byte, multi-byte UTF-8, large input).
 */

import { describe, it, expect } from 'vitest';
import {
  arrayBufferToBase64,
  base64ToArrayBuffer,
  uint8ArrayToBase64,
  base64ToUint8Array,
  concatArrayBuffers,
} from '@/lib/utils/buffer';

describe('lib/utils/buffer — base64 ↔ ArrayBuffer', () => {
  it('round-trips an empty buffer', () => {
    const empty = new ArrayBuffer(0);
    const b64 = arrayBufferToBase64(empty);
    expect(b64).toBe('');
    expect(base64ToArrayBuffer(b64).byteLength).toBe(0);
  });

  it('round-trips a single byte', () => {
    const buf = new Uint8Array([42]).buffer;
    const b64 = arrayBufferToBase64(buf);
    const back = base64ToArrayBuffer(b64);
    expect(new Uint8Array(back)).toEqual(new Uint8Array([42]));
  });

  it('round-trips a multi-byte UTF-8 string', () => {
    const text = 'Hello, world! Привет, мир! 🌍';
    const bytes = new TextEncoder().encode(text);
    const b64 = arrayBufferToBase64(bytes.buffer);
    const back = new Uint8Array(base64ToArrayBuffer(b64));
    expect(new TextDecoder().decode(back)).toBe(text);
  });

  it('round-trips a large buffer (1 KB of random bytes)', () => {
    const bytes = new Uint8Array(1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) & 0xff;
    const b64 = arrayBufferToBase64(bytes.buffer);
    const back = new Uint8Array(base64ToArrayBuffer(b64));
    expect(back).toEqual(bytes);
  });

  it('produces standard base64 output (with padding)', () => {
    // 1 byte → "AA==" (one byte 0x00)
    expect(arrayBufferToBase64(new Uint8Array([0]).buffer)).toBe('AA==');
    // 2 bytes → "AAA=" (two bytes 0x00 0x00)
    expect(arrayBufferToBase64(new Uint8Array([0, 0]).buffer)).toBe('AAA=');
    // 3 bytes → "AAAA" (three bytes 0x00 0x00 0x00)
    expect(arrayBufferToBase64(new Uint8Array([0, 0, 0]).buffer)).toBe('AAAA');
  });
});

describe('lib/utils/buffer — base64 ↔ Uint8Array', () => {
  it('round-trips an empty Uint8Array', () => {
    const b64 = uint8ArrayToBase64(new Uint8Array(0));
    expect(b64).toBe('');
    expect(base64ToUint8Array(b64).length).toBe(0);
  });

  it('round-trips a Uint8Array of arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 3, 255, 254, 253, 128, 64, 32]);
    const b64 = uint8ArrayToBase64(bytes);
    const back = base64ToUint8Array(b64);
    expect(back).toEqual(bytes);
  });

  it('round-trips a multi-byte UTF-8 string', () => {
    const text = 'Привет, мир! 🔐';
    const bytes = new TextEncoder().encode(text);
    const b64 = uint8ArrayToBase64(bytes);
    const back = base64ToUint8Array(b64);
    expect(new TextDecoder().decode(back)).toBe(text);
  });

  it('is consistent with the ArrayBuffer variant for the same bytes', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const a = uint8ArrayToBase64(bytes);
    const b = arrayBufferToBase64(bytes.buffer);
    expect(a).toBe(b);
  });

  it('base64ToUint8Array rejects invalid base64', () => {
    // atob throws on strings with characters outside the base64 alphabet
    // (excluding '='). We verify the function propagates the error.
    expect(() => base64ToUint8Array('!@#$%')).toThrow();
  });
});

describe('lib/utils/buffer — concatArrayBuffers', () => {
  it('returns an empty buffer when given no inputs', () => {
    const result = concatArrayBuffers();
    expect(result.byteLength).toBe(0);
  });

  it('returns the input unchanged when given a single buffer', () => {
    const a = new Uint8Array([1, 2, 3]).buffer;
    const result = concatArrayBuffers(a);
    expect(new Uint8Array(result)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('concatenates multiple buffers in order', () => {
    const a = new Uint8Array([1, 2]).buffer;
    const b = new Uint8Array([3]).buffer;
    const c = new Uint8Array([4, 5, 6]).buffer;
    const result = concatArrayBuffers(a, b, c);
    expect(new Uint8Array(result)).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
  });

  it('handles mixing empty and non-empty buffers', () => {
    const empty = new ArrayBuffer(0);
    const a = new Uint8Array([10, 20]).buffer;
    const result = concatArrayBuffers(empty, a, empty);
    expect(new Uint8Array(result)).toEqual(new Uint8Array([10, 20]));
  });

  it('preserves byte order across many small buffers', () => {
    const inputs: ArrayBuffer[] = [];
    const expected: number[] = [];
    for (let i = 0; i < 50; i++) {
      inputs.push(new Uint8Array([i]).buffer);
      expected.push(i);
    }
    const result = concatArrayBuffers(...inputs);
    expect(Array.from(new Uint8Array(result))).toEqual(expected);
  });
});
