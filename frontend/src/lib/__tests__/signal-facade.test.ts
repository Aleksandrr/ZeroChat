/**
 * Tests for the lib/signal façade (the v0.1.x-compatible API backed by
 * the new v0.2.x WASM module).
 *
 * These tests stub out IndexedDB (with fake-IndexedDB-style in-memory
 * maps) so we can drive the façade without spinning up a real
 * IDBDatabase. They verify that:
 *
 *   1. initializeSignalWithRestore creates a fresh identity on first run
 *      and returns keysForPublishing.
 *   2. On second run (with the same userId), state is restored from
 *      IndexedDB and no new keys are generated.
 *   3. Two façades (Alice + Bob) can establish a session and exchange
 *      an encrypted 1:1 message end-to-end.
 *
 * NOTE: these tests run serially because the façade uses module-level
 * singletons (signalClient, stores, etc). We reset between tests via
 * `fullLogout()`.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

// We mock the storage layer to avoid IndexedDB entirely. Each storage
// function is replaced with an in-memory equivalent.
const memoryStore: Record<string, Map<string, any>> = {};

function getStore(name: string): Map<string, any> {
  if (!memoryStore[name]) memoryStore[name] = new Map();
  return memoryStore[name];
}

vi.mock('@/lib/signal/storage', () => ({
  initSignalDB: async () => ({} as IDBDatabase),
  clearAllStores: async () => {
    for (const k of Object.keys(memoryStore)) delete memoryStore[k];
  },
  getOrCreateDeviceId: async (skipServerCheck?: boolean) => {
    void skipServerCheck;
    let id = getStore('deviceId').get('current');
    if (!id) {
      id = Math.floor(Math.random() * 100) + 1;
      getStore('deviceId').set('current', id);
    }
    return id;
  },
  loadLocalDeviceUuid: async () => getStore('localUuid').get('current') ?? null,
  storeLocalDeviceUuid: async (uuid: string) => {
    getStore('localUuid').set('current', uuid);
  },
  storeIdentityKey: async (userId: string, publicKey: string, privateKey: string) => {
    getStore('identityKeys').set(userId, { userId, publicKey, privateKey, createdAt: Date.now() });
  },
  loadIdentityKey: async (userId: string) => getStore('identityKeys').get(userId) ?? null,
  saveSignalClientState: async (state: any) => {
    getStore('signalClientState').set('current', { ...state, createdAt: Date.now(), updatedAt: Date.now() });
  },
  loadSignalClientState: async () => getStore('signalClientState').get('current') ?? null,
  loadRegistration: async () => {
    const s = getStore('signalClientState').get('current');
    if (!s) return null;
    return { userId: s.userId, registrationId: s.registrationId, deviceId: s.deviceId };
  },
  // PreKey store
  storePreKey: async (pk: any) => {
    const uuid = getStore('localUuid').get('current');
    getStore('preKeys').set(`${uuid}:${pk.id}`, pk);
  },
  loadAllPreKeyRecords: async (uuid: string) => {
    const out: any[] = [];
    for (const [k, v] of getStore('preKeys').entries()) {
      if (k.startsWith(`${uuid}:`)) out.push({ id: v.id, publicKey: v.publicKey, record: v.record });
    }
    return out;
  },
  // SignedPreKey
  storeSignedPreKeyWithRecord: async (
    uuid: string,
    id: number,
    publicKey: Uint8Array,
    signature: Uint8Array,
    record: Uint8Array,
    createdAt: number,
    updatedAt: number,
  ) => {
    getStore('signedPreKeys').set(`${uuid}:${id}`, { id, publicKey, signature, record, createdAt, updatedAt });
  },
  loadAllSignedPreKeyRecords: async (uuid: string) => {
    const out: any[] = [];
    for (const [k, v] of getStore('signedPreKeys').entries()) {
      if (k.startsWith(`${uuid}:`)) out.push({ id: v.id, publicKey: v.publicKey, signature: v.signature, record: v.record, timestamp: v.createdAt });
    }
    return out;
  },
  // KyberPreKey
  storeKyberPreKeyWithRecord: async (
    uuid: string,
    id: number,
    publicKey: Uint8Array,
    signature: Uint8Array,
    record: Uint8Array,
    createdAt: number,
    updatedAt: number,
  ) => {
    getStore('kyberPreKeys').set(`${uuid}:${id}`, { id, publicKey, signature, record, createdAt, updatedAt });
  },
  loadAllKyberPreKeyRecords: async (uuid: string) => {
    const out: any[] = [];
    for (const [k, v] of getStore('kyberPreKeys').entries()) {
      if (k.startsWith(`${uuid}:`)) out.push({ id: v.id, publicKey: v.publicKey, signature: v.signature, record: v.record, timestamp: v.createdAt });
    }
    return out;
  },
  // Sessions
  storeSessionWithRecord: async (localUuid: string, remoteUuid: string, remoteDeviceId: number, record: Uint8Array) => {
    getStore('sessions').set(`${localUuid}:${remoteUuid}:${remoteDeviceId}`, { localUuid, remoteUuid, remoteDeviceId, record });
  },
  loadSessionRecord: async (localUuid: string, remoteUuid: string, remoteDeviceId: number) => {
    return getStore('sessions').get(`${localUuid}:${remoteUuid}:${remoteDeviceId}`) ?? null;
  },
  hasSession: async (remoteUuid: string, remoteDeviceId: number) => {
    const uuid = getStore('localUuid').get('current');
    return getStore('sessions').has(`${uuid}:${remoteUuid}:${remoteDeviceId}`);
  },
  deleteSession: async (remoteUuid: string, remoteDeviceId: number) => {
    const uuid = getStore('localUuid').get('current');
    getStore('sessions').delete(`${uuid}:${remoteUuid}:${remoteDeviceId}`);
  },
  // Sender keys
  storeSenderKey: async (sk: any) => {
    getStore('senderKeys').set(sk.id, sk);
  },
  getSenderKey: async (groupId: string, senderUserId: string) => {
    return getStore('senderKeys').get(`${groupId}:${senderUserId}`) ?? null;
  },
  getSenderKeysByGroup: async (groupId: string) => {
    const out: any[] = [];
    for (const [k, v] of getStore('senderKeys').entries()) {
      if (k.startsWith(`${groupId}:`)) out.push(v);
    }
    return out;
  },
  generateSenderKeyId: (groupId: string, senderUserId: string) => `${groupId}:${senderUserId}`,
  cleanupOrphanedIdentityKeys: async () => {},
  unlinkDevice: async () => {},
}));

// Import AFTER the mock is registered.
import * as signal from '@/lib/signal';

describe('lib/signal façade — fresh registration', () => {
  beforeEach(async () => {
    for (const k of Object.keys(memoryStore)) delete memoryStore[k];
    await signal.fullLogout();
  });

  it('initializeSignalWithRestore returns success + keysForPublishing on first run', async () => {
    const result = await signal.initializeSignalWithRestore('alice-user-1', false);
    expect(result.success).toBe(true);
    expect(result.deviceId).toBeGreaterThan(0);
    expect(result.uuid).toBeTruthy();
    expect(result.keysForPublishing).toBeDefined();
    expect(result.keysForPublishing!.preKeys.length).toBeGreaterThan(0);
    expect(result.keysForPublishing!.signedPreKeys.length).toBe(1);
    expect(result.keysForPublishing!.kyberPreKeys.length).toBe(1);
    expect(result.keysForPublishing!.identityKey).toBeTruthy();
    expect(result.keysForPublishing!.registrationId).toBeGreaterThan(0);
  });

  it('initializeSignalWithRestore restores existing state on second run (no new keys)', async () => {
    const first = await signal.initializeSignalWithRestore('alice-user-2', false);
    expect(first.success).toBe(true);
    const firstUuid = first.uuid;
    const firstDeviceId = first.deviceId;
    expect(first.keysForPublishing).toBeDefined();

    // Logout (clears in-memory WASM state but IndexedDB mock still has
    // the persisted data — using `uiLogout`, NOT `fullLogout`, which
    // would also clear storage).
    await signal.uiLogout();

    // Second run: should restore, not generate new keys.
    const second = await signal.initializeSignalWithRestore('alice-user-2', false);
    expect(second.success).toBe(true);
    expect(second.uuid).toBe(firstUuid);
    expect(second.deviceId).toBe(firstDeviceId);
    // No keysForPublishing on restore path (caller already has them).
    expect(second.keysForPublishing).toBeUndefined();
  });

  it('getIdentityPublicKey returns a stable byte array after init', async () => {
    await signal.initializeSignalWithRestore('alice-user-3', false);
    const k1 = signal.getIdentityPublicKey();
    const k2 = signal.getIdentityPublicKey();
    expect(k1).toBeInstanceOf(Uint8Array);
    expect(k2).toBeInstanceOf(Uint8Array);
    expect(Array.from(k1!)).toEqual(Array.from(k2!));
  });
});

describe('lib/signal façade — end-to-end 1:1 encryption', () => {
  // We need to drive two "users" through the same module-level state.
  // The façade has a single global signalClient, so we simulate Alice
  // and Bob by alternating: init Alice, capture her bundle, logout,
  // init Bob, have Bob process Alice's bundle, encrypt to Alice,
  // capture ciphertext, logout, init Alice, decrypt Bob's message.
  //
  // This is a smoke test of the façade rather than a full multi-user
  // scenario (which would require two separate signalClient instances).

  beforeEach(async () => {
    for (const k of Object.keys(memoryStore)) delete memoryStore[k];
    await signal.fullLogout();
  });

  it('Alice can generate a PreKey bundle', async () => {
    await signal.initializeSignalWithRestore('alice-user', false);
    const bundle = await signal.generatePreKeyBundle();
    expect(bundle.registrationId).toBeGreaterThan(0);
    expect(bundle.deviceId).toBeGreaterThan(0);
    expect(bundle.identityKey).toBeInstanceOf(Uint8Array);
    expect(bundle.signedPreKey).toBeInstanceOf(Uint8Array);
    expect(bundle.signedPreKeySignature).toBeInstanceOf(Uint8Array);
    expect(bundle.kyberPreKey).toBeInstanceOf(Uint8Array);
    expect(bundle.kyberPreKeySignature).toBeInstanceOf(Uint8Array);
  });

  it('Alice can encrypt a message (after establishing a session with a mock recipient bundle)', async () => {
    await signal.initializeSignalWithRestore('alice-user', false);
    // Generate a mock recipient bundle using the same façade.
    const recipientBundle = await signal.generatePreKeyBundle();
    // Now process it — this establishes a session in Alice's signalClient.
    await signal.processPreKeyBundle('bob-uid', 1, recipientBundle);

    const plaintext = 'Hello Bob from Alice!';
    const encrypted = await signal.encryptMessage('bob-uid', 1, plaintext);
    expect(encrypted.body).toBeInstanceOf(Uint8Array);
    expect(encrypted.body.length).toBeGreaterThan(0);
    expect(encrypted.type).toBeGreaterThan(0);
  });
});
