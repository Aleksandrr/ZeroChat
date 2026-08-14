/**
 * Tests for signal/core/{kyber,double-ratchet,x3dh,pqxdh}.ts.
 *
 * These modules are mostly thin validation/utility wrappers around the
 * WASM layer (post v0.2 migration). The tests verify the pure-JS parts:
 *   - Constants and size calculations
 *   - Validation functions (validate*, is*)
 *   - Helpers (publicKeysEqual, findSkippedMessageKey, etc.)
 *
 * Functions that simply delegate to the WASM client (encryptMessage,
 * decryptMessage, processPreKeyBundle) are tested via mocks — the real
 * WASM paths are already covered by signal-wasm.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ==================== kyber.ts ====================
import {
  KYBER_N,
  KYBER_Q,
  KYBER_K,
  KYBER_PUBLICKEYBYTES,
  KYBER_SECRETKEYBYTES,
  KYBER_CIPHERTEXTBYTES,
  KYBER_SSBYTES,
  KYBER_SYMBYTES,
  validatePublicKey,
  validateSecretKey,
  validateCiphertext,
  validateSharedSecret,
  publicKeysEqual,
  isKyberPublicKey,
  isKyberCiphertext,
} from '@/lib/signal/core/kyber';

describe('signal/core/kyber — constants', () => {
  it('KYBER_N is the polynomial degree 256', () => {
    expect(KYBER_N).toBe(256);
  });

  it('KYBER_Q is the prime modulus 3329', () => {
    expect(KYBER_Q).toBe(3329);
  });

  it('KYBER_K is the vector dimension 4 (ML-KEM-1024 / Kyber-1024)', () => {
    expect(KYBER_K).toBe(4);
  });

  it('KYBER_SSBYTES is the shared-secret length 32', () => {
    expect(KYBER_SSBYTES).toBe(32);
  });

  it('KYBER_SYMBYTES is the symmetric key length 32', () => {
    expect(KYBER_SYMBYTES).toBe(32);
  });

  it('KYBER_PUBLICKEYBYTES is 12*K*N/8 + 32 = 1568 (FIPS 203 ML-KEM-1024)', () => {
    expect(KYBER_PUBLICKEYBYTES).toBe((12 * KYBER_K * KYBER_N) / 8 + 32);
    expect(KYBER_PUBLICKEYBYTES).toBe(1568);
  });

  it('KYBER_SECRETKEYBYTES is 24*K*N/8 + 3*32 = 3168 (FIPS 203 ML-KEM-1024)', () => {
    expect(KYBER_SECRETKEYBYTES).toBe((24 * KYBER_K * KYBER_N) / 8 + 3 * 32);
    expect(KYBER_SECRETKEYBYTES).toBe(3168);
  });

  it('KYBER_CIPHERTEXTBYTES is du*K*N/8 + dv*N/8 = 1568 (FIPS 203 ML-KEM-1024, du=11 dv=5)', () => {
    expect(KYBER_CIPHERTEXTBYTES).toBe((11 * KYBER_K * KYBER_N) / 8 + (5 * KYBER_N) / 8);
    expect(KYBER_CIPHERTEXTBYTES).toBe(1568);
  });
});

describe('signal/core/kyber — validatePublicKey', () => {
  it('rejects null/undefined', () => {
    expect(validatePublicKey(null as any).valid).toBe(false);
    expect(validatePublicKey(undefined as any).valid).toBe(false);
  });

  it('rejects a key that is too short', () => {
    const tooShort = new Uint8Array(KYBER_PUBLICKEYBYTES - 1);
    expect(validatePublicKey(tooShort).valid).toBe(false);
    expect(validatePublicKey(tooShort).error).toMatch(/expected 1568/i);
  });

  it('rejects a key that is too long (beyond raw + 1 prefix byte)', () => {
    const tooLong = new Uint8Array(KYBER_PUBLICKEYBYTES + 2); // 1570 bytes
    expect(validatePublicKey(tooLong).valid).toBe(false);
  });

  it('accepts a raw FIPS-203 key (1568 bytes)', () => {
    const ok = new Uint8Array(KYBER_PUBLICKEYBYTES);
    expect(validatePublicKey(ok).valid).toBe(true);
    expect(validatePublicKey(ok).error).toBeUndefined();
  });

  it('accepts a libsignal wire-form key (1569 bytes = prefix + raw)', () => {
    const wire = new Uint8Array(KYBER_PUBLICKEYBYTES + 1);
    wire[0] = 0x08; // Kyber-1024 prefix
    expect(validatePublicKey(wire).valid).toBe(true);
  });
});

describe('signal/core/kyber — validateSecretKey', () => {
  it('rejects null/undefined', () => {
    expect(validateSecretKey(null as any).valid).toBe(false);
    });

  it('rejects a key with the wrong length', () => {
    const wrong = new Uint8Array(KYBER_SECRETKEYBYTES - 1);
    expect(validateSecretKey(wrong).valid).toBe(false);
  });

  it('accepts a key with the correct length', () => {
    const ok = new Uint8Array(KYBER_SECRETKEYBYTES);
    expect(validateSecretKey(ok).valid).toBe(true);
  });
});

describe('signal/core/kyber — validateCiphertext', () => {
  it('rejects null/undefined', () => {
    expect(validateCiphertext(null as any).valid).toBe(false);
  });

  it('rejects a ciphertext with the wrong length', () => {
    const wrong = new Uint8Array(KYBER_CIPHERTEXTBYTES - 1);
    expect(validateCiphertext(wrong).valid).toBe(false);
  });

  it('accepts a ciphertext with the correct length', () => {
    const ok = new Uint8Array(KYBER_CIPHERTEXTBYTES);
    expect(validateCiphertext(ok).valid).toBe(true);
  });
});

describe('signal/core/kyber — validateSharedSecret', () => {
  it('rejects null/undefined', () => {
    expect(validateSharedSecret(null as any).valid).toBe(false);
  });

  it('rejects a secret with the wrong length', () => {
    expect(validateSharedSecret(new Uint8Array(31)).valid).toBe(false);
  });

  it('accepts a 32-byte secret', () => {
    expect(validateSharedSecret(new Uint8Array(32)).valid).toBe(true);
  });
});

describe('signal/core/kyber — publicKeysEqual', () => {
  it('returns false for different-length keys', () => {
    expect(publicKeysEqual(new Uint8Array(10), new Uint8Array(11))).toBe(false);
  });

  it('returns true for identical keys', () => {
    const a = new Uint8Array([1, 2, 3, 4, 5]);
    expect(publicKeysEqual(a, a)).toBe(true);
  });

  it('returns true for two Uint8Arrays with the same bytes', () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([1, 2, 3]);
    expect(publicKeysEqual(a, b)).toBe(true);
  });

  it('returns false for two Uint8Arrays that differ at one byte', () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([1, 2, 4]);
    expect(publicKeysEqual(a, b)).toBe(false);
  });
});

describe('signal/core/kyber — isKyberPublicKey / isKyberCiphertext', () => {
  it('isKyberPublicKey returns true for a 1568-byte (raw) buffer', () => {
    expect(isKyberPublicKey(new Uint8Array(KYBER_PUBLICKEYBYTES))).toBe(true);
    expect(isKyberPublicKey(new Uint8Array(100))).toBe(false);
  });

  it('isKyberPublicKey also accepts the 1569-byte wire form (prefix + raw)', () => {
    expect(isKyberPublicKey(new Uint8Array(KYBER_PUBLICKEYBYTES + 1))).toBe(true);
  });

  it('isKyberCiphertext returns true for a 1568-byte buffer', () => {
    expect(isKyberCiphertext(new Uint8Array(KYBER_CIPHERTEXTBYTES))).toBe(true);
    expect(isKyberCiphertext(new Uint8Array(100))).toBe(false);
  });

  it('both return falsy for null/undefined', () => {
    expect(isKyberPublicKey(null as any)).toBeFalsy();
    expect(isKyberCiphertext(undefined as any)).toBeFalsy();
  });
});

// ==================== double-ratchet.ts ====================
import {
  MESSAGE_TYPES as DR_MESSAGE_TYPES,
  encryptMessage as drEncrypt,
  decryptMessage as drDecrypt,
  hasWasmSession,
  exportSession,
  importSession,
  archiveSession,
  advanceSendingChain,
  advanceReceivingChain,
  dhRatchetStep,
  storeSkippedMessageKey,
  findSkippedMessageKey,
  getSendingMessageNumber,
  getReceivingMessageNumber,
  needsDHRatchet,
} from '@/lib/signal/core/double-ratchet';

describe('signal/core/double-ratchet — MESSAGE_TYPES', () => {
  it('exposes PRE_KEY=3, SIGNAL=2, SENDER_KEY=4', () => {
    expect(DR_MESSAGE_TYPES.PRE_KEY).toBe(3);
    expect(DR_MESSAGE_TYPES.SIGNAL).toBe(2);
    expect(DR_MESSAGE_TYPES.SENDER_KEY).toBe(4);
  });
});

describe('signal/core/double-ratchet — encryptMessage / decryptMessage (mocked client)', () => {
  const mockClient = {
    encrypt_message: vi.fn(),
    decrypt_message: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('encryptMessage delegates to client.encrypt_message and returns EncryptedMessage shape', async () => {
    mockClient.encrypt_message.mockResolvedValueOnce({
      message_type: 2,
      body: new Uint8Array([1, 2, 3, 4]),
    });
    const result = await drEncrypt(mockClient, 'bob-uid', 1, new Uint8Array([9, 9]));
    expect(mockClient.encrypt_message).toHaveBeenCalledWith('bob-uid', 1, new Uint8Array([9, 9]));
    expect(result.type).toBe(2);
    expect(Array.from(result.body)).toEqual([1, 2, 3, 4]);
    expect(result.senderUserId).toBe('');
    expect(result.senderDeviceId).toBe(0);
  });

  it('encryptMessage throws when client is null', async () => {
    await expect(drEncrypt(null, 'x', 1, new Uint8Array(0))).rejects.toThrow(/not initialized/i);
  });

  it('decryptMessage delegates to client.decrypt_message and returns DecryptedMessage shape', async () => {
    mockClient.decrypt_message.mockResolvedValueOnce(new Uint8Array([7, 7, 7]));
    const result = await drDecrypt(mockClient, 'bob-uid', 1, new Uint8Array([1]), 2);
    expect(mockClient.decrypt_message).toHaveBeenCalledWith('bob-uid', 1, new Uint8Array([1]), 2);
    expect(result.type).toBe(2);
    expect(Array.from(result.body)).toEqual([7, 7, 7]);
    expect(result.senderUserId).toBe('bob-uid');
    expect(result.senderDeviceId).toBe(1);
  });

  it('decryptMessage throws when client is null', async () => {
    await expect(drDecrypt(null, 'x', 1, new Uint8Array(0), 2)).rejects.toThrow(/not initialized/i);
  });
});

describe('signal/core/double-ratchet — session helpers (mocked client)', () => {
  const mockClient = {
    has_session: vi.fn(),
    export_session: vi.fn(),
    import_session: vi.fn(),
    archive_session: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hasWasmSession returns false when client is null', async () => {
    expect(await hasWasmSession(null, 'x', 1)).toBe(false);
  });

  it('hasWasmSession returns false when client lacks has_session', async () => {
    expect(await hasWasmSession({}, 'x', 1)).toBe(false);
  });

  it('hasWasmSession delegates to client.has_session', async () => {
    mockClient.has_session.mockResolvedValueOnce(true);
    expect(await hasWasmSession(mockClient, 'bob-uid', 7)).toBe(true);
    expect(mockClient.has_session).toHaveBeenCalledWith('bob-uid', 7);
  });

  it('exportSession returns null when client lacks export_session', async () => {
    expect(await exportSession({}, 'x', 1)).toBeNull();
  });

  it('exportSession delegates to client.export_session', async () => {
    mockClient.export_session.mockResolvedValueOnce(new Uint8Array([1, 2, 3]));
    const result = await exportSession(mockClient, 'x', 1);
    expect(Array.from(result!)).toEqual([1, 2, 3]);
  });

  it('importSession throws when client lacks import_session', async () => {
    await expect(importSession({}, 'x', 1, new Uint8Array(0))).rejects.toThrow(/not supported/i);
  });

  it('importSession delegates to client.import_session', async () => {
    await importSession(mockClient, 'x', 1, new Uint8Array([9]));
    expect(mockClient.import_session).toHaveBeenCalledWith('x', 1, new Uint8Array([9]));
  });

  it('archiveSession throws when client is null', async () => {
    await expect(archiveSession(null, 'x', 1)).rejects.toThrow(/not initialized/i);
  });

  it('archiveSession is a no-op when client lacks archive_session', async () => {
    await archiveSession({}, 'x', 1); // should not throw
  });

  it('archiveSession delegates to client.archive_session when present', async () => {
    mockClient.archive_session.mockResolvedValueOnce(undefined);
    await archiveSession(mockClient, 'x', 1);
    expect(mockClient.archive_session).toHaveBeenCalledWith('x', 1);
  });
});

describe('signal/core/double-ratchet — chain advancement (P0-4: deprecated stubs throw)', () => {
  function makeState(CKs: Uint8Array, CKr: Uint8Array, Ns = 0, Nr = 0): any {
    return {
      DHs: { publicKey: new Uint8Array(0), privateKey: new Uint8Array(0) },
      DHr: new Uint8Array(0),
      RK: new Uint8Array(32),
      CKs,
      CKr,
      Ns,
      Nr,
      PN: 0,
      MKSkipped: new Map(),
    };
  }

  it('advanceSendingChain throws — Double Ratchet is handled by signal-wasm', async () => {
    const state = makeState(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), 0, 0);
    await expect(advanceSendingChain(state)).rejects.toThrow(/signal-wasm/i);
    // State must be untouched (the stub no longer mutates anything).
    expect(state.Ns).toBe(0);
  });

  it('advanceReceivingChain throws — Double Ratchet is handled by signal-wasm', async () => {
    const state = makeState(new Uint8Array(32), new Uint8Array(32).fill(3), 0, 0);
    await expect(advanceReceivingChain(state)).rejects.toThrow(/signal-wasm/i);
    expect(state.Nr).toBe(0);
  });

  it('dhRatchetStep throws — Double Ratchet is handled by signal-wasm', async () => {
    const state = makeState(new Uint8Array(32), new Uint8Array(32), 5, 7);
    await expect(dhRatchetStep(state, new Uint8Array([42]))).rejects.toThrow(/signal-wasm/i);
    // State must be untouched.
    expect(state.Ns).toBe(5);
    expect(state.Nr).toBe(7);
    expect(state.DHr).toEqual(new Uint8Array(0));
  });
});

describe('signal/core/double-ratchet — skipped message keys', () => {
  function makeState(): any {
    return { MKSkipped: new Map(), Ns: 0, Nr: 0, DHr: new Uint8Array(0) };
  }

  it('storeSkippedMessageKey stores the key under (publicKey, n)', () => {
    const state = makeState();
    const pk = new Uint8Array([1, 2, 3]);
    storeSkippedMessageKey(state, pk, 5, new Uint8Array([99]));
    const found = findSkippedMessageKey(state, pk, 5);
    expect(found).not.toBeNull();
    expect(Array.from(found!)).toEqual([99]);
  });

  it('findSkippedMessageKey returns null for a missing (pk, n) pair', () => {
    const state = makeState();
    const pk = new Uint8Array([1, 2, 3]);
    expect(findSkippedMessageKey(state, pk, 5)).toBeNull();
  });

  it('storeSkippedMessageKey evicts the oldest entry when MAX_MESSAGE_KEYS is exceeded', () => {
    const state = makeState();
    const pk = new Uint8Array([1]);
    // Insert 2001 keys (MAX_MESSAGE_KEYS is 2000).
    for (let i = 0; i <= 2000; i++) {
      storeSkippedMessageKey(state, pk, i, new Uint8Array([i & 0xff]));
    }
    expect(state.MKSkipped.size).toBe(2000);
    // The very first key (i=0) should have been evicted.
    expect(findSkippedMessageKey(state, pk, 0)).toBeNull();
    // The second key (i=1) should still be present.
    expect(findSkippedMessageKey(state, pk, 1)).not.toBeNull();
  });
});

describe('signal/core/double-ratchet — getSendingMessageNumber / getReceivingMessageNumber', () => {
  it('returns the Ns / Nr fields from the state', () => {
    const state = { Ns: 42, Nr: 17 } as any;
    expect(getSendingMessageNumber(state)).toBe(42);
    expect(getReceivingMessageNumber(state)).toBe(17);
  });
});

describe('signal/core/double-ratchet — needsDHRatchet', () => {
  it('returns true when the remote header public key differs from state.DHr', () => {
    const state = { DHr: new Uint8Array([1, 2, 3]) } as any;
    const remote = { publicKey: new Uint8Array([1, 2, 4]), messageNumber: 0 };
    expect(needsDHRatchet(state, remote)).toBe(true);
  });

  it('returns false when the remote header public key matches state.DHr', () => {
    const state = { DHr: new Uint8Array([1, 2, 3]) } as any;
    const remote = { publicKey: new Uint8Array([1, 2, 3]), messageNumber: 0 };
    expect(needsDHRatchet(state, remote)).toBe(false);
  });
});

// ==================== x3dh.ts ====================
import {
  validatePreKeyBundle,
  calculateX3DHSecret,
  verifySignedPreKeySignature,
  loadSignalModule,
  SignalClient,
} from '@/lib/signal/core/x3dh';
import type { PreKeyBundle } from '@/lib/signal/types';

describe('signal/core/x3dh — SignalClient re-export', () => {
  it('is undefined in v0.2.x (backwards-compat shim)', () => {
    expect(SignalClient).toBeUndefined();
  });
});

describe('signal/core/x3dh — validatePreKeyBundle', () => {
  function makeValidBundle(): PreKeyBundle {
    return {
      registrationId: 12345,
      deviceId: 1,
      identityKey: new Uint8Array(33),
      signedPreKeyId: 1,
      signedPreKey: new Uint8Array(33),
      signedPreKeySignature: new Uint8Array(64),
      preKeyId: 100,
      preKey: new Uint8Array(33),
      kyberPreKeyId: 1,
      kyberPreKey: new Uint8Array(1568), // ML-KEM-1024 raw public key size
      kyberPreKeySignature: new Uint8Array(64),
    };
  }

  it('returns valid:true for a well-formed bundle', () => {
    const result = validatePreKeyBundle(makeValidBundle());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects a bundle with registrationId=0', () => {
    const bundle = makeValidBundle();
    bundle.registrationId = 0;
    const result = validatePreKeyBundle(bundle);
    expect(result.valid).toBe(false);
    expect(result.errors.join('; ')).toMatch(/registration id/i);
  });

  it('rejects a bundle with an empty identity key', () => {
    const bundle = makeValidBundle();
    bundle.identityKey = new Uint8Array(0);
    const result = validatePreKeyBundle(bundle);
    expect(result.valid).toBe(false);
    expect(result.errors.join('; ')).toMatch(/identity key/i);
  });

  it('rejects a bundle missing the signed pre-key', () => {
    const bundle = makeValidBundle();
    bundle.signedPreKey = new Uint8Array(0);
    const result = validatePreKeyBundle(bundle);
    expect(result.valid).toBe(false);
    expect(result.errors.join('; ')).toMatch(/signed pre-key/i);
  });

  it('rejects a bundle missing the signed pre-key signature', () => {
    const bundle = makeValidBundle();
    bundle.signedPreKeySignature = new Uint8Array(0);
    const result = validatePreKeyBundle(bundle);
    expect(result.valid).toBe(false);
    expect(result.errors.join('; ')).toMatch(/signature/i);
  });

  it('rejects a bundle with a pre-key but no preKeyId', () => {
    const bundle = makeValidBundle();
    bundle.preKeyId = undefined;
    const result = validatePreKeyBundle(bundle);
    expect(result.valid).toBe(false);
    expect(result.errors.join('; ')).toMatch(/pre-key.*missing id/i);
  });

  it('rejects a bundle with a kyber pre-key but no kyberPreKeyId', () => {
    const bundle = makeValidBundle();
    bundle.kyberPreKeyId = undefined;
    const result = validatePreKeyBundle(bundle);
    expect(result.valid).toBe(false);
    expect(result.errors.join('; ')).toMatch(/kyber.*missing id/i);
  });

  it('accepts a bundle without a one-time pre-key (preKey/preKeyId both optional)', () => {
    const bundle = makeValidBundle();
    bundle.preKeyId = undefined;
    bundle.preKey = undefined;
    const result = validatePreKeyBundle(bundle);
    expect(result.valid).toBe(true);
  });
});

describe('signal/core/x3dh — calculateX3DHSecret', () => {
  it('returns a 32-byte shared secret derived from the inputs', async () => {
    const secret = await calculateX3DHSecret(
      new Uint8Array(32).fill(1),
      new Uint8Array(32).fill(2),
      new Uint8Array(32).fill(3),
      new Uint8Array(32).fill(4),
      new Uint8Array(32).fill(5),
    );
    expect(secret.length).toBe(32);
  });

  it('is deterministic for the same inputs', async () => {
    const a = await calculateX3DHSecret(
      new Uint8Array(32).fill(1),
      new Uint8Array(32).fill(2),
      new Uint8Array(32).fill(3),
      new Uint8Array(32).fill(4),
    );
    const b = await calculateX3DHSecret(
      new Uint8Array(32).fill(1),
      new Uint8Array(32).fill(2),
      new Uint8Array(32).fill(3),
      new Uint8Array(32).fill(4),
    );
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('differs when any input changes', async () => {
    const a = await calculateX3DHSecret(
      new Uint8Array(32).fill(1),
      new Uint8Array(32).fill(2),
      new Uint8Array(32).fill(3),
      new Uint8Array(32).fill(4),
    );
    const b = await calculateX3DHSecret(
      new Uint8Array(32).fill(9), // changed
      new Uint8Array(32).fill(2),
      new Uint8Array(32).fill(3),
      new Uint8Array(32).fill(4),
    );
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });
});

describe('signal/core/x3dh — verifySignedPreKeySignature (P0-3: real Ed25519 verification)', () => {
  // Helper: generate a real Ed25519 keypair, sign a payload, and return
  // the Signal-format identity key (0x05 prefix + 32 raw pub), the signed
  // payload, and the signature.
  async function makeSignedPair(payload: Uint8Array) {
    const kp = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    const rawPub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
    // Signal/libsignal identity key = 0x05 prefix + 32-byte raw Ed25519 pub.
    const identityKey = new Uint8Array(33);
    identityKey[0] = 0x05;
    identityKey.set(rawPub, 1);
    const signature = new Uint8Array(
      await crypto.subtle.sign('Ed25519', kp.privateKey, payload as BufferSource),
    );
    return { identityKey, signature };
  }

  it('returns true for a genuine Ed25519 signature over the signed pre-key', async () => {
    const signedPreKey = crypto.getRandomValues(new Uint8Array(32));
    const { identityKey, signature } = await makeSignedPair(signedPreKey);
    const ok = await verifySignedPreKeySignature(identityKey, signedPreKey, signature);
    expect(ok).toBe(true);
  });

  it('returns false for a tampered signed pre-key (signature no longer matches)', async () => {
    const signedPreKey = crypto.getRandomValues(new Uint8Array(32));
    const { identityKey, signature } = await makeSignedPair(signedPreKey);
    const tampered = new Uint8Array(signedPreKey);
    tampered[0] = (tampered[0] ?? 0) ^ 0x01;
    const ok = await verifySignedPreKeySignature(identityKey, tampered, signature);
    expect(ok).toBe(false);
  });

  it('returns false for a tampered signature', async () => {
    const signedPreKey = crypto.getRandomValues(new Uint8Array(32));
    const { identityKey, signature } = await makeSignedPair(signedPreKey);
    const tampered = new Uint8Array(signature);
    tampered[0] = (tampered[0] ?? 0) ^ 0x01;
    const ok = await verifySignedPreKeySignature(identityKey, signedPreKey, tampered);
    expect(ok).toBe(false);
  });

  it('returns false when verified under a different identity key', async () => {
    const signedPreKey = crypto.getRandomValues(new Uint8Array(32));
    const { identityKey: idA, signature } = await makeSignedPair(signedPreKey);
    const { identityKey: idB } = await makeSignedPair(signedPreKey);
    const ok = await verifySignedPreKeySignature(idB, signedPreKey, signature);
    expect(ok).toBe(false);
    // Sanity: the original key still verifies.
    expect(await verifySignedPreKeySignature(idA, signedPreKey, signature)).toBe(true);
  });

  it('fails closed on a malformed identity key (wrong length)', async () => {
    const ok = await verifySignedPreKeySignature(
      new Uint8Array(15), // not 32 or 33 bytes
      new Uint8Array(32),
      new Uint8Array(64),
    );
    expect(ok).toBe(false);
  });

  it('fails closed on a malformed signature (not 64 bytes)', async () => {
    const signedPreKey = crypto.getRandomValues(new Uint8Array(32));
    const { identityKey, signature } = await makeSignedPair(signedPreKey);
    const truncated = signature.subarray(0, 32);
    const ok = await verifySignedPreKeySignature(identityKey, signedPreKey, truncated);
    expect(ok).toBe(false);
  });

  it('accepts a 32-byte raw Ed25519 public key (no 0x05 prefix)', async () => {
    const signedPreKey = crypto.getRandomValues(new Uint8Array(32));
    const kp = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    const rawPub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
    const signature = new Uint8Array(
      await crypto.subtle.sign('Ed25519', kp.privateKey, signedPreKey as BufferSource),
    );
    const ok = await verifySignedPreKeySignature(rawPub, signedPreKey, signature);
    expect(ok).toBe(true);
  });
});

describe('signal/core/x3dh — loadSignalModule', () => {
  it('does not throw and returns void', async () => {
    await expect(loadSignalModule()).resolves.toBeUndefined();
  });
});
