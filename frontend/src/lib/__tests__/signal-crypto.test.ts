/**
 * Tests for signal/utils/crypto.ts — pure WebCrypto wrappers.
 *
 * Verifies that every utility function:
 *   - Returns the documented type/shape
 *   - Round-trips correctly (encrypt → decrypt, sign → verify)
 *   - Produces deterministic results where expected (hashes, HKDF with
 *     the same inputs)
 *   - Produces different outputs when inputs differ (random generation,
 *     different keys)
 *
 * Uses the global WebCrypto API (Node 18+ provides it).
 */

import { describe, it, expect } from 'vitest';
import {
  bytesToUuid,
  generateRandomBytes,
  generateRandomInt,
  hmacSha256,
  verifyHmacSha256,
  sha256,
  sha512,
  hkdf,
  deriveKeys,
  aesEncrypt,
  aesDecrypt,
  generateKeyPair,
  deriveSharedSecret,
  signData,
  verifySignature,
} from '@/lib/signal/utils/crypto';

const encoder = new TextEncoder();

describe('signal/utils/crypto — bytesToUuid', () => {
  it('converts 16 bytes to a UUID v4 string', () => {
    // 16 bytes: a known UUIDv4 — a3 4d 6f 7c 8e 9a 4f 5b 9c 6d 7e 8f 0a 1b 2c 3d
    const bytes = new Uint8Array([
      0xa3, 0x4d, 0x6f, 0x7c, 0x8e, 0x9a, 0x4f, 0x5b,
      0x9c, 0x6d, 0x7e, 0x8f, 0x0a, 0x1b, 0x2c, 0x3d,
    ]);
    const uuid = bytesToUuid(bytes);
    // Format: 8-4-4-4-12 hex chars
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('forces the version nibble to 4 and the variant to a (UUIDv4 layout)', () => {
    // All zeros → should still produce 00000000-0000-4000-a000-000000000000
    const bytes = new Uint8Array(16);
    const uuid = bytesToUuid(bytes);
    expect(uuid).toBe('00000000-0000-4000-a000-000000000000');
  });
});

describe('signal/utils/crypto — random generation', () => {
  it('generateRandomBytes returns the requested length', () => {
    for (const len of [1, 8, 16, 32, 100, 1024]) {
      const buf = generateRandomBytes(len);
      expect(buf).toBeInstanceOf(Uint8Array);
      expect(buf.length).toBe(len);
    }
  });

  it('generateRandomBytes produces different outputs (probabilistic)', () => {
    const a = generateRandomBytes(32);
    const b = generateRandomBytes(32);
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it('generateRandomInt returns values within [min, max] inclusive', () => {
    for (let i = 0; i < 100; i++) {
      const n = generateRandomInt(5, 10);
      expect(n).toBeGreaterThanOrEqual(5);
      expect(n).toBeLessThanOrEqual(10);
    }
  });

  it('generateRandomInt(min, min) returns min', () => {
    for (let i = 0; i < 10; i++) {
      expect(generateRandomInt(7, 7)).toBe(7);
    }
  });
});

describe('signal/utils/crypto — HMAC', () => {
  it('hmacSha256 returns 32 bytes', async () => {
    const key = generateRandomBytes(32);
    const data = encoder.encode('hello');
    const mac = await hmacSha256(key, data);
    expect(mac.length).toBe(32);
  });

  it('hmacSha256 is deterministic for the same (key, data)', async () => {
    const key = encoder.encode('secret-key');
    const data = encoder.encode('hello world');
    const a = await hmacSha256(key, data);
    const b = await hmacSha256(key, data);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('hmacSha256 differs for different keys', async () => {
    const data = encoder.encode('hello world');
    const a = await hmacSha256(encoder.encode('key1'), data);
    const b = await hmacSha256(encoder.encode('key2'), data);
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it('verifyHmacSha256 returns true for a genuine signature', async () => {
    const key = encoder.encode('secret-key');
    const data = encoder.encode('hello world');
    const sig = await hmacSha256(key, data);
    const ok = await verifyHmacSha256(key, data, sig);
    expect(ok).toBe(true);
  });

  it('verifyHmacSha256 returns false for a tampered signature', async () => {
    const key = encoder.encode('secret-key');
    const data = encoder.encode('hello world');
    const sig = await hmacSha256(key, data);
    // Flip one bit in the signature.
    const tampered = new Uint8Array(sig);
    tampered[0] ^= 0x01;
    const ok = await verifyHmacSha256(key, data, tampered);
    expect(ok).toBe(false);
  });

  it('verifyHmacSha256 returns false for a different key', async () => {
    const key1 = encoder.encode('key1');
    const key2 = encoder.encode('key2');
    const data = encoder.encode('hello world');
    const sig = await hmacSha256(key1, data);
    const ok = await verifyHmacSha256(key2, data, sig);
    expect(ok).toBe(false);
  });
});

describe('signal/utils/crypto — SHA hashes', () => {
  it('sha256 returns 32 bytes', async () => {
    const h = await sha256(encoder.encode('hello'));
    expect(h.length).toBe(32);
  });

  it('sha512 returns 64 bytes', async () => {
    const h = await sha512(encoder.encode('hello'));
    expect(h.length).toBe(64);
  });

  it('sha256 of empty string matches the known constant', async () => {
    const h = await sha256(new Uint8Array(0));
    // e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    const hex = Array.from(h).map(b => b.toString(16).padStart(2, '0')).join('');
    expect(hex).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('sha256 of "abc" matches the NIST FIPS-180-2 test vector', async () => {
    const h = await sha256(encoder.encode('abc'));
    const hex = Array.from(h).map(b => b.toString(16).padStart(2, '0')).join('');
    expect(hex).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('sha256 differs for different inputs', async () => {
    const a = await sha256(encoder.encode('hello'));
    const b = await sha256(encoder.encode('world'));
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });
});

describe('signal/utils/crypto — HKDF', () => {
  it('hkdf returns the requested length', async () => {
    const ikm = generateRandomBytes(32);
    const salt = generateRandomBytes(16);
    const info = encoder.encode('test-info');
    const out = await hkdf(ikm, salt, info, 64);
    expect(out.length).toBe(64);
  });

  it('hkdf is deterministic for the same inputs', async () => {
    const ikm = encoder.encode('input-key-material');
    const salt = encoder.encode('salt');
    const info = encoder.encode('info');
    const a = await hkdf(ikm, salt, info, 32);
    const b = await hkdf(ikm, salt, info, 32);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('hkdf differs when ikm differs', async () => {
    const salt = encoder.encode('salt');
    const info = encoder.encode('info');
    const a = await hkdf(encoder.encode('ikm1'), salt, info, 32);
    const b = await hkdf(encoder.encode('ikm2'), salt, info, 32);
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it('hkdf differs when info differs', async () => {
    const ikm = encoder.encode('input-key-material');
    const salt = encoder.encode('salt');
    const a = await hkdf(ikm, salt, encoder.encode('info1'), 32);
    const b = await hkdf(ikm, salt, encoder.encode('info2'), 32);
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it('deriveKeys returns 32-byte encryption + 32-byte mac keys', async () => {
    const { encryptionKey, macKey } = await deriveKeys(
      generateRandomBytes(32),
      'test-info',
    );
    expect(encryptionKey.length).toBe(32);
    expect(macKey.length).toBe(32);
  });

  it('deriveKeys produces different keys for different info strings', async () => {
    const secret = generateRandomBytes(32);
    const a = await deriveKeys(secret, 'info-a');
    const b = await deriveKeys(secret, 'info-b');
    expect(Array.from(a.encryptionKey)).not.toEqual(Array.from(b.encryptionKey));
    expect(Array.from(a.macKey)).not.toEqual(Array.from(b.macKey));
  });
});

describe('signal/utils/crypto — AES-CBC', () => {
  it('aesEncrypt → aesDecrypt round-trips to the original plaintext', async () => {
    const key = generateRandomBytes(32);
    const plaintext = encoder.encode('Hello, AES-CBC! 🔐');
    const { ciphertext, iv } = await aesEncrypt(key, plaintext);
    expect(iv.length).toBe(16);
    expect(ciphertext.length).toBeGreaterThan(0);
    // AES-CBC pads to 16-byte boundary, so ciphertext is a multiple of 16.
    expect(ciphertext.length % 16).toBe(0);

    const decrypted = await aesDecrypt(key, ciphertext, iv);
    expect(new TextDecoder().decode(decrypted)).toBe('Hello, AES-CBC! 🔐');
  });

  it('aesEncrypt with explicit IV uses that IV', async () => {
    const key = generateRandomBytes(32);
    const iv = generateRandomBytes(16);
    const { iv: returnedIv } = await aesEncrypt(key, encoder.encode('test'), iv);
    expect(Array.from(returnedIv)).toEqual(Array.from(iv));
  });

  it('aesEncrypt produces different ciphertexts for the same plaintext (random IV)', async () => {
    const key = generateRandomBytes(32);
    const pt = encoder.encode('same plaintext');
    const a = await aesEncrypt(key, pt);
    const b = await aesEncrypt(key, pt);
    expect(Array.from(a.iv)).not.toEqual(Array.from(b.iv));
    expect(Array.from(a.ciphertext)).not.toEqual(Array.from(b.ciphertext));
  });

  it('aesDecrypt fails (throws) for a tampered ciphertext', async () => {
    const key = generateRandomBytes(32);
    const pt = encoder.encode('original message');
    const { ciphertext, iv } = await aesEncrypt(key, pt);
    const tampered = new Uint8Array(ciphertext);
    tampered[0] ^= 0xff;
    await expect(aesDecrypt(key, tampered, iv)).rejects.toThrow();
  });
});

describe('signal/utils/crypto — X25519 key agreement', () => {
  it('two parties derive the same shared secret via X25519', async () => {
    const alice = await generateKeyPair();
    const bob = await generateKeyPair();

    const aliceShared = await deriveSharedSecret(alice.privateKey, bob.publicKey);
    const bobShared = await deriveSharedSecret(bob.privateKey, alice.publicKey);

    expect(Array.from(aliceShared)).toEqual(Array.from(bobShared));
    expect(aliceShared.length).toBe(32);
  });

  it('different key pairs derive different shared secrets', async () => {
    const alice = await generateKeyPair();
    const bob1 = await generateKeyPair();
    const bob2 = await generateKeyPair();

    const s1 = await deriveSharedSecret(alice.privateKey, bob1.publicKey);
    const s2 = await deriveSharedSecret(alice.privateKey, bob2.publicKey);
    expect(Array.from(s1)).not.toEqual(Array.from(s2));
  });
});

describe('signal/utils/crypto — Ed25519 signatures', () => {
  it('sign → verify round-trips to true', async () => {
    const kp = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    const data = encoder.encode('hello world');
    const sig = await signData(kp.privateKey, data);
    expect(sig.length).toBe(64); // Ed25519 signatures are 64 bytes

    const ok = await verifySignature(kp.publicKey, data, sig);
    expect(ok).toBe(true);
  });

  it('verify returns false for tampered data', async () => {
    const kp = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    const sig = await signData(kp.privateKey, encoder.encode('original'));
    const ok = await verifySignature(kp.publicKey, encoder.encode('tampered'), sig);
    expect(ok).toBe(false);
  });

  it('verify returns false for tampered signature', async () => {
    const kp = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    const data = encoder.encode('original');
    const sig = await signData(kp.privateKey, data);
    const tampered = new Uint8Array(sig);
    tampered[0] ^= 0x01;
    const ok = await verifySignature(kp.publicKey, data, tampered);
    expect(ok).toBe(false);
  });

  it('verify returns false when using a different public key', async () => {
    const kp1 = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    const kp2 = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    const data = encoder.encode('original');
    const sig = await signData(kp1.privateKey, data);
    const ok = await verifySignature(kp2.publicKey, data, sig);
    expect(ok).toBe(false);
  });
});
