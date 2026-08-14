/**
 * Unit tests for the transparent AES-GCM wrapping key manager
 * (`lib/signal/storage/keystore.ts`).
 *
 * Covers:
 *   1. `wrapSecret(x)` → non-empty string, different from `x`.
 *   2. `unwrapSecret(wrapSecret(x))` === `x` (round-trip).
 *   3. `unwrapSecret(legacyPlaintext)` === `legacyPlaintext` (backward
 *      compat — values written before wrapping was enabled still read).
 *   4. Concurrent `getKEK()` calls return the same CryptoKey (boot
 *      promise deduplication).
 *   5. KEK persists across `clearKEKCache()` — same wrapping key is
 *      re-loaded from IndexedDB so previously-wrapped secrets can
 *      still be unwrapped after a soft logout.
 *   6. Two different plaintexts produce two different wrapped
 *      ciphertexts (AES-GCM with random IV → non-deterministic).
 *
 * Uses `fake-indexeddb` to back the `zerochat-keystore` IndexedDB
 * database that the KEK is persisted in.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import 'fake-indexeddb/auto';

import {
  getKEK,
  clearKEKCache,
  wrapSecret,
  unwrapSecret,
} from '../keystore';

// CryptoKey objects don't have a public equality operator, so to
// compare two KEKs we compare what they produce — the same KEK must
// decrypt a wrapped value successfully. We do that in test #4 below.

describe('keystore: transparent AES-GCM wrapping', () => {
  beforeAll(() => {
    // jsdom in vitest provides crypto.subtle. Sanity-check it once.
    if (typeof crypto?.subtle?.generateKey !== 'function') {
      throw new Error('crypto.subtle.generateKey is not available in this test environment');
    }
  });

  beforeEach(() => {
    // Drop the in-memory cache so each test starts from a clean state.
    // We don't delete the keystore IndexedDB between tests within this
    // file — that lets us verify persistence semantics in test #5.
    clearKEKCache();
  });

  afterAll(() => {
    // Final cleanup.
    clearKEKCache();
  });

  it('wrapSecret returns a non-empty string distinct from the input', async () => {
    const plaintext = makeRandomBase64(32);
    const wrapped = await wrapSecret(plaintext);
    expect(wrapped).toBeTruthy();
    expect(typeof wrapped).toBe('string');
    expect(wrapped).not.toBe(plaintext);
    // Wrapped output is IV(12) || ciphertext(>=16) base64-encoded, so
    // it must be strictly longer than the plaintext base64.
    expect(wrapped.length).toBeGreaterThan(plaintext.length);
  });

  it('wrapSecret(plaintext) → unwrapSecret(wrapped) === plaintext (round-trip)', async () => {
    const plaintexts = [
      makeRandomBase64(32), // typical identity private key length
      makeRandomBase64(64), // longer session record
      makeRandomBase64(16), // short sender key fragment
      'AA==',               // single zero byte
    ];

    for (const plaintext of plaintexts) {
      const wrapped = await wrapSecret(plaintext);
      const unwrapped = await unwrapSecret(wrapped);
      expect(unwrapped).toBe(plaintext);
    }
  });

  it('unwrapSecret(legacyPlaintext) === legacyPlaintext (backward compat)', async () => {
    // Simulate legacy plaintext records written before wrapping was
    // enabled. `unwrapSecret` must return them unchanged so the
    // migration path is safe — old records keep working, new writes
    // are wrapped.
    const legacyValues = [
      makeRandomBase64(32), // identity private key
      makeRandomBase64(48), // session record
      makeRandomBase64(64), // signed prekey record
      'SGVsbG8gV29ybGQ=',   // "Hello World"
    ];

    for (const legacy of legacyValues) {
      const result = await unwrapSecret(legacy);
      expect(result).toBe(legacy);
    }
  });

  it('unwrapSecret handles empty string', async () => {
    expect(await unwrapSecret('')).toBe('');
    expect(await wrapSecret('')).toBe('');
  });

  it('concurrent getKEK() calls return the same boot promise', async () => {
    // Fire 5 concurrent getKEK() calls — they must all share the same
    // boot promise (otherwise we'd race-create two KEKs and one would
    // overwrite the other in IndexedDB).
    const promises = [
      getKEK(),
      getKEK(),
      getKEK(),
      getKEK(),
      getKEK(),
    ];
    const keys = await Promise.all(promises);
    // All callers must receive the exact same CryptoKey object.
    for (const k of keys) {
      expect(k).toBe(keys[0]);
    }
  });

  it('KEK persists across clearKEKCache — same key, previously-wrapped secrets still decrypt', async () => {
    // Phase 1: wrap a secret with the initial KEK.
    const plaintext = makeRandomBase64(32);
    const wrapped = await wrapSecret(plaintext);

    // Phase 2: simulate a soft logout (drop in-memory cache only —
    // IndexedDB keystore DB is NOT touched).
    clearKEKCache();

    // Phase 3: getKEK() must re-load the SAME KEK from IndexedDB
    // (otherwise the previously-wrapped secret would be unreadable).
    const unwrapped = await unwrapSecret(wrapped);
    expect(unwrapped).toBe(plaintext);
  });

  it('two wraps of the same plaintext produce different ciphertexts (random IV)', async () => {
    const plaintext = makeRandomBase64(32);
    const wrapped1 = await wrapSecret(plaintext);
    const wrapped2 = await wrapSecret(plaintext);
    expect(wrapped1).not.toBe(wrapped2);
    // Both must still decrypt back to the original plaintext.
    expect(await unwrapSecret(wrapped1)).toBe(plaintext);
    expect(await unwrapSecret(wrapped2)).toBe(plaintext);
  });

  it('clearKEKCache is a no-op when called multiple times in a row', () => {
    expect(() => {
      clearKEKCache();
      clearKEKCache();
      clearKEKCache();
    }).not.toThrow();
  });

  it('getKEK returns a CryptoKey with non-extractable=true', async () => {
    const key = await getKEK();
    // The KEK must be non-extractable so JS can't read its raw bytes
    // via crypto.subtle.exportKey — this is the core "device-bound"
    // property. (The raw bytes are still in IndexedDB, but they are
    // only reachable through the keystore DB, not the live CryptoKey.)
    expect((key as CryptoKey).extractable).toBe(false);
    // Confirm exportKey throws with non-extractable key.
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
  });
});

// ==================== Helpers ====================

/** Generate `n` random bytes and return as base64. */
function makeRandomBase64(n: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  let bin = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === undefined) continue;
    bin += String.fromCharCode(b);
  }
  return btoa(bin);
}
