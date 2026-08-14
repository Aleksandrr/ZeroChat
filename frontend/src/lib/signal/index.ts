/**
 * Signal Protocol Service for ZeroChat-TS (signal-wasm v0.2.x)
 *
 * Adapter that exposes the same façade API used by the rest of the app
 * (SignalContext.tsx, services/chat, hooks, ...) but internally drives
 * the new modular signal-wasm 0.2.x API:
 *   - 6 in-memory store instances (Identity/Session/PreKey/SignedPreKey/KyberPreKey/SenderKey)
 *   - WasmProtocolAddress for (uuid, deviceId) addressing
 *   - Module-level functions: generatePreKeys, processPreKeyBundle,
 *     encryptMessage, decryptMessage, encryptGroupMessage, ...
 *
 * All persistence to IndexedDB is preserved (sessions/prekeys/senderKeys
 * are still stored as opaque byte records). On boot the records are
 * imported into the in-memory stores so the WASM side has the same
 * private-key material as before.
 */

// @ts-nocheck - WASM types may not match perfectly

// ==================== Type Imports ====================
import * as core from './core';
// ==================== Module Imports ====================
import * as storage from './storage';
// Transparent AES-GCM wrapping for Signal private keys at rest. Only the
// cache-clear hook is needed here (called from `fullLogout()`); all
// wrap/unwrap happens inside the storage layer.
import { clearKEKCache } from './storage/keystore';
import type {
  DecryptedMessage,
  DeviceRecord,
  EncryptedMessage,
  IdentityKeyData,
  LinkedDevice,
  LinkingRequest,
  PreKeyBundle,
  RegistrationData,
  SessionState,
  SignalInitializationResult,
  StoredKyberPreKey,
  StoredPreKey,
  StoredSignedPreKey,
  UserRecord,
} from './types';
import * as utils from './utils';

// Re-export types
export * from './types';

// ==================== WASM Module Loading ====================

// Loaded lazily once and cached.
let wasmModule: typeof import('@getmaapp/signal-wasm') | null = null;
let wasmReady: Promise<void> | null = null;

// Module-level helpers bound after load.
let generate_uuid: () => Uint8Array;
let message_type_pre_key: () => number;
let message_type_signal: () => number;
let message_type_sender_key: () => number;

// ==================== State Management ====================

// In-memory store singletons (one set per local identity).
let identityStore: any = null;
let sessionStore: any = null;
let preKeyStore: any = null;
let signedPreKeyStore: any = null;
let kyberPreKeyStore: any = null;
let senderKeyStore: any = null;

// The current local identity key pair + protocol address.
let identityKeyPair: any = null;
let localAddress: any = null;

let isInitialized = false;
let currentUserId = '';
let currentDeviceId = 0;
let localUuid = '';

// Counter offsets persisted across sessions. v0.2.0 no longer tracks
// these inside the WASM client, so we own them in JS land.
let nextPreKeyId = 1;
let nextSignedPreKeyId = 1;
let nextKyberPreKeyId = 1;

// Track if PreKeys are loaded in WASM (resets on HMR).
let wasmPreKeysLoaded = false;

// Track decryption failures for session corruption detection.
const decryptionFailures = new Map<string, number>();

// ==================== Operation Queue (Mutex) ====================
// Serialize WASM operations to prevent ratchet state corruption.

type QueuedOperation<T> = () => Promise<T>;

class SignalOperationQueue {
  private queue: Promise<void> = Promise.resolve();
  private pendingOperations = 0;

  async enqueue<T>(operation: QueuedOperation<T>): Promise<T> {
    this.pendingOperations++;
    const opId = `${Date.now()}-${this.pendingOperations}`;

    const tail = this.queue;

    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const resultPromise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    this.queue = tail.catch(() => {}).then(async () => {
      try {
        const result = await operation();
        resolve(result);
      } catch (error) {
        console.error(`[SignalQueue] Operation ${opId} failed:`, error);
        reject(error);
      } finally {
        this.pendingOperations--;
      }
    });

    return resultPromise;
  }
}

const operationQueue = new SignalOperationQueue();

// ==================== WASM Module Loader ====================

async function loadSignalModule(): Promise<typeof import('@getmaapp/signal-wasm')> {
  if (wasmModule && wasmReady) {
    await wasmReady;
    return wasmModule;
  }

  if (!wasmReady) {
    const module = await import('@getmaapp/signal-wasm');

    // Prefer initSync with a bundled .wasm asset (works in jsdom/test
    // environments that don't implement fetch for file:// URLs). Fall
    // back to the async default() init in the browser.
    try {
      // Vite/webpack will inline this as a URL string at build time;
      // in Node tests we resolve the file from node_modules directly.
      let wasmBytes: Uint8Array | undefined;
      try {
        // Browser: Vite resolves `?url` imports to the asset URL.
        // We don't use that here; instead we try the in-memory path.
        const { readFileSync } = await import('node:fs');
        const { resolve } = await import('node:path');
        const wasmPath = resolve(
          (await import('node:url')).fileURLToPath(new URL('.', import.meta.url)),
          '../../../node_modules/@getmaapp/signal-wasm/signal_wasm_bg.wasm',
        );
        wasmBytes = new Uint8Array(readFileSync(wasmPath));
      } catch {
        // Not in Node — fall through to async init.
      }

      if (wasmBytes && typeof module.initSync === 'function') {
        module.initSync(wasmBytes);
        wasmReady = Promise.resolve();
      } else if (module.default && typeof module.default === 'function') {
        wasmReady = module.default();
        await wasmReady;
      } else {
        throw new Error('WASM initialization function not found');
      }
    } catch (err) {
      // Last resort: try async init.
      if (module.default && typeof module.default === 'function') {
        wasmReady = module.default();
        await wasmReady;
      } else {
        throw err;
      }
    }

    wasmModule = module;
    generate_uuid = module.generate_uuid;
    message_type_pre_key = module.message_type_pre_key;
    message_type_signal = module.message_type_signal;
    message_type_sender_key = module.message_type_sender_key;
    return module;
  }

  await wasmReady;
  return wasmModule!;
}

// ==================== Address / Key Helpers ====================

function makeAddress(uuid: string, deviceId: number): any {
  return new wasmModule!.WasmProtocolAddress(uuid, deviceId);
}

/**
 * Reconstruct a WasmIdentityKeyPair from raw key bytes persisted in
 * IndexedDB. Supports both legacy 32-byte raw Ed25519 keys and the
 * v0.2.x serialized protobuf form (which is longer).
 */
function identityFromStoredBytes(publicKey: Uint8Array, privateKey: Uint8Array): any {
  const W = wasmModule!;
  const pub = W.WasmPublicKey.deserialize(publicKey);
  const priv = W.WasmPrivateKey.deserialize(privateKey);
  return new W.WasmIdentityKeyPair(pub, priv);
}

// ==================== Session Save Helper ====================

/**
 * Save a session to IndexedDB after encryption/decryption so the
 * ratchet state survives page reloads.
 */
async function saveSession(
  remoteUuid: string,
  remoteDeviceId: number,
): Promise<void> {
  if (!sessionStore || !localUuid) {
    return;
  }
  try {
    const address = makeAddress(remoteUuid, remoteDeviceId);
    const sessionBytes = await sessionStore.export_session(address);
    if (sessionBytes && sessionBytes.length > 0) {
      await storage.storeSessionWithRecord(localUuid, remoteUuid, remoteDeviceId, sessionBytes);
    }
  } catch (e) {
    // Best-effort: do not crash the encrypt/decrypt path on persistence errors.
    console.warn('[Signal] saveSession failed:', e);
  }
}

// ==================== SignalProtocol Class ====================

/**
 * Main Signal Protocol façade. Preserves the v0.1.x method signatures
 * so callers (SignalContext.tsx, hooks, services) don't change.
 */
export class SignalProtocol {
  private _userId = '';
  private _deviceId = 0;
  private _uuid = '';

  async initializeSenderKey(groupId: string): Promise<Uint8Array> {
    if (!senderKeyStore || !localAddress) {
      throw new Error('Signal client not initialized');
    }

    return operationQueue.enqueue(async () => {
      try {
        const skdm = await wasmModule!.createSenderKeyDistribution(localAddress, groupId, senderKeyStore);

        const senderKeyState = await senderKeyStore.export_sender_key(localAddress, groupId);
        if (!senderKeyState) {
          throw new Error('Failed to export sender key state');
        }

        await storage.storeSenderKey({
          id: storage.generateSenderKeyId(groupId, this._userId),
          groupId,
          senderUserId: this._userId,
          senderKeyId: 0,
          senderKeyState: utils.uint8ArrayToBase64(senderKeyState),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });

        return skdm;
      } catch (error) {
        console.error(`[Signal] Failed to initialize Sender Key for group ${groupId}:`, error);
        throw error;
      }
    });
  }

  async addSenderKey(
    groupId: string,
    senderUserId: string,
    senderKeyId: number,
    senderKeyState: string,
  ): Promise<void> {
    if (!senderKeyStore) {
      throw new Error('Signal client not initialized');
    }

    return operationQueue.enqueue(async () => {
      try {
        // senderKeyState is base64-encoded bytes (legacy shape).
        const senderKeyBytes = utils.base64ToUint8Array(senderKeyState);
        const address = makeAddress(senderUserId, senderKeyId);
        await senderKeyStore.import_sender_key(address, groupId, senderKeyBytes);

        await storage.storeSenderKey({
          id: storage.generateSenderKeyId(groupId, senderUserId),
          groupId,
          senderUserId,
          senderKeyId,
          senderKeyState,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      } catch (error) {
        console.error(`[Signal] Failed to add Sender Key for group ${groupId}:`, error);
        throw error;
      }
    });
  }

  async encryptGroupMessage(groupId: string, message: string): Promise<EncryptedMessage> {
    if (!senderKeyStore || !localAddress) {
      throw new Error('Signal client not initialized');
    }

    return operationQueue.enqueue(async () => {
      try {
        // Ensure we have a sender key for this group.
        const senderKeys = await storage.getSenderKeysByGroup(groupId);
        if (senderKeys.length === 0) {
          await this.initializeSenderKey(groupId);
        } else {
          // Check if our key is already loaded in WASM.
          let existing: Uint8Array | null = null;
          try {
            existing = await senderKeyStore.export_sender_key(localAddress, groupId) ?? null;
          } catch {
            existing = null;
          }
          if (!existing) {
            const mySenderKey = senderKeys.find(sk => sk.senderUserId === this._userId);
            if (mySenderKey?.senderKeyState) {
              try {
                const senderKeyBytes = utils.base64ToUint8Array(mySenderKey.senderKeyState);
                if (senderKeyBytes.length === 0) {
                  throw new Error('Sender key bytes empty');
                }
                await senderKeyStore.import_sender_key(localAddress, groupId, senderKeyBytes);
              } catch (e) {
                console.warn('[Signal] Failed to import sender key, reinitializing:', e);
                await this.initializeSenderKey(groupId);
              }
            } else {
              await this.initializeSenderKey(groupId);
            }
          }
        }

        const messageBytes = new TextEncoder().encode(message);
        const encrypted = await wasmModule!.encryptGroupMessage(localAddress, groupId, messageBytes, senderKeyStore);

        // Persist the advanced chain state.
        try {
          const senderKeyState = await senderKeyStore.export_sender_key(localAddress, groupId);
          if (senderKeyState) {
            await storage.storeSenderKey({
              id: storage.generateSenderKeyId(groupId, this._userId),
              groupId,
              senderUserId: this._userId,
              senderKeyId: 0,
              senderKeyState: utils.uint8ArrayToBase64(senderKeyState),
              createdAt: Date.now(),
              updatedAt: Date.now(),
            });
          }
        } catch {
          // persistence is best-effort
        }

        return {
          type: message_type_sender_key(),
          body: encrypted,
          senderUserId: this._userId,
          senderDeviceId: this._deviceId,
        };
      } catch (error) {
        console.error(`[Signal] Failed to encrypt group message for ${groupId}:`, error);
        throw error;
      }
    });
  }

  async decryptGroupMessage(
    groupId: string,
    senderUserId: string,
    senderDeviceId: number,
    message: Uint8Array,
    messageType: number,
  ): Promise<string> {
    if (!senderKeyStore) {
      throw new Error('Signal client not initialized');
    }

    return operationQueue.enqueue(async () => {
      try {
        const senderAddress = makeAddress(senderUserId, senderDeviceId);

        // Ensure sender's sender key is loaded in WASM.
        let existingSenderKey: Uint8Array | null = null;
        try {
          existingSenderKey = await senderKeyStore.export_sender_key(senderAddress, groupId) ?? null;
        } catch {
          existingSenderKey = null;
        }
        if (!existingSenderKey) {
          const senderKeyRecord = await storage.getSenderKey(groupId, senderUserId);
          if (senderKeyRecord?.senderKeyState) {
            try {
              const senderKeyBytes = utils.base64ToUint8Array(senderKeyRecord.senderKeyState);
              await senderKeyStore.import_sender_key(senderAddress, groupId, senderKeyBytes);
            } catch (e) {
              console.warn('[Signal] Failed to import sender key for decryption:', e);
              throw new Error('Missing sender key for decryption');
            }
          } else {
            throw new Error('No sender key record found for decryption');
          }
        }

        const decryptedBytes = await wasmModule!.decryptGroupMessage(senderAddress, message, senderKeyStore);
        const decrypted = new TextDecoder().decode(decryptedBytes);

        // Persist the advanced chain state.
        try {
          const senderKeyState = await senderKeyStore.export_sender_key(senderAddress, groupId);
          if (senderKeyState) {
            await storage.storeSenderKey({
              id: storage.generateSenderKeyId(groupId, senderUserId),
              groupId,
              senderUserId,
              senderKeyId: senderDeviceId,
              senderKeyState: utils.uint8ArrayToBase64(senderKeyState),
              createdAt: Date.now(),
              updatedAt: Date.now(),
            });
          }
        } catch {
          // persistence is best-effort
        }

        return decrypted;
      } catch (error) {
        console.error(`[Signal] Failed to decrypt group message from ${senderUserId} for ${groupId}:`, error);
        throw error;
      }
    });
  }

  async initialize(
    userId: string,
    registrationId: number,
    identityKey?: { publicKey: Uint8Array; privateKey: Uint8Array },
  ): Promise<void> {
    if (isInitialized) {
      return;
    }

    await loadSignalModule();
    currentUserId = userId;
    this._userId = userId;

    await storage.initSignalDB();
    currentDeviceId = await storage.getOrCreateDeviceId();
    this._deviceId = currentDeviceId;

    const storedUuid = await storage.loadLocalDeviceUuid();
    if (storedUuid && typeof storedUuid === 'string') {
      localUuid = storedUuid;
    } else {
      if (storedUuid) {
        console.warn('[Signal] Clearing invalid stored UUID (was', typeof storedUuid, ')');
        await storage.storeLocalDeviceUuid('');
      }
      localUuid = utils.bytesToUuid(generate_uuid());
      await storage.storeLocalDeviceUuid(localUuid);
    }
    this._uuid = localUuid;

    try {
      if (identityKey?.publicKey.length && identityKey?.privateKey.length) {
        await this.restoreIdentity(registrationId, identityKey);
      } else {
        await this.generateIdentity(registrationId);
      }

      isInitialized = true;
      await this.saveState();
    } catch (error) {
      console.error('[Signal] Initialization failed:', error);
      throw error;
    }
  }

  private async restoreIdentity(
    registrationId: number,
    identityKey: { publicKey: Uint8Array; privateKey: Uint8Array },
  ): Promise<void> {
    const W = wasmModule!;

    identityKeyPair = identityFromStoredBytes(identityKey.publicKey, identityKey.privateKey);
    localAddress = new W.WasmProtocolAddress(localUuid, currentDeviceId);

    identityStore = new W.WasmInMemIdentityKeyStore(identityKeyPair, registrationId);
    sessionStore = new W.WasmInMemSessionStore();
    preKeyStore = new W.WasmInMemPreKeyStore();
    signedPreKeyStore = new W.WasmInMemSignedPreKeyStore();
    kyberPreKeyStore = new W.WasmInMemKyberPreKeyStore();
    senderKeyStore = new W.WasmInMemSenderKeyStore();

    // Restore offsets if previously persisted.
    const storedState = await storage.loadSignalClientState();
    if (storedState) {
      nextPreKeyId = storedState.nextPreKeyId ?? 1;
      nextSignedPreKeyId = storedState.nextSignedPreKeyId ?? 1;
      nextKyberPreKeyId = storedState.nextKyberPreKeyId ?? 1;
    }

    await ensureKeys();
  }

  private async generateIdentity(registrationId: number): Promise<void> {
    const W = wasmModule!;

    const privateKey = W.WasmPrivateKey.generate();
    const publicKey = privateKey.getPublicKey();
    identityKeyPair = new W.WasmIdentityKeyPair(publicKey, privateKey);
    localAddress = new W.WasmProtocolAddress(localUuid, currentDeviceId);

    identityStore = new W.WasmInMemIdentityKeyStore(identityKeyPair, registrationId);
    sessionStore = new W.WasmInMemSessionStore();
    preKeyStore = new W.WasmInMemPreKeyStore();
    signedPreKeyStore = new W.WasmInMemSignedPreKeyStore();
    kyberPreKeyStore = new W.WasmInMemKyberPreKeyStore();
    senderKeyStore = new W.WasmInMemSenderKeyStore();

    const pubSer = publicKey.serialize();
    const privSer = privateKey.serialize();
    await storage.storeIdentityKey(currentUserId, utils.uint8ArrayToBase64(pubSer), utils.uint8ArrayToBase64(privSer));

    await this.generateAndStorePreKeys(100);
    await this.generateAndStoreSignedPreKey();
    await this.generateAndStoreKyberPreKey();
  }

  private async generateAndStorePreKeys(count: number): Promise<any[]> {
    const startId = nextPreKeyId;
    const preKeys = await wasmModule!.generatePreKeys(startId, count, preKeyStore);
    nextPreKeyId += count;

    for (const pk of preKeys) {
      const pkId = pk.id;
      const pkPublicKey = pk.public_key;
      const pkRecord = pk.record;
      if (pkId && pkPublicKey) {
        await storage.storePreKey({
          id: pkId,
          publicKey: utils.uint8ArrayToBase64(pkPublicKey),
          record: pkRecord ? utils.uint8ArrayToBase64(pkRecord) : '',
          createdAt: Date.now(),
        });
      }
    }
    return preKeys;
  }

  private async generateAndStoreSignedPreKey(): Promise<any> {
    const spk = await wasmModule!.generateSignedPreKey(nextSignedPreKeyId, identityKeyPair, signedPreKeyStore);
    nextSignedPreKeyId += 1;

    if (spk?.id && spk?.public_key && localUuid && spk.record) {
      await storage.storeSignedPreKeyWithRecord(
        localUuid,
        spk.id,
        spk.public_key,
        spk.signature,
        spk.record,
        Date.now(),
        Date.now(),
      );
    }
    return spk;
  }

  private async generateAndStoreKyberPreKey(): Promise<any> {
    const kpk = await wasmModule!.generateKyberPreKey(nextKyberPreKeyId, identityKeyPair, kyberPreKeyStore);
    nextKyberPreKeyId += 1;

    if (kpk?.id && kpk?.public_key && localUuid && kpk.record) {
      await storage.storeKyberPreKeyWithRecord(
        localUuid,
        kpk.id,
        kpk.public_key,
        kpk.signature,
        kpk.record,
        Date.now(),
        Date.now(),
      );
    }
    return kpk;
  }

  async processPreKeyBundle(
    recipientId: string,
    recipientDeviceId: number,
    bundle: PreKeyBundle,
  ): Promise<void> {
    if (!sessionStore || !identityStore) {
      throw new Error('Signal client not initialized');
    }

    return operationQueue.enqueue(async () => {
      const W = wasmModule!;
      const recipientAddress = new W.WasmProtocolAddress(recipientId, recipientDeviceId);
      const identityKey = W.WasmPublicKey.deserialize(bundle.identityKey);
      const signedPreKey = W.WasmPublicKey.deserialize(bundle.signedPreKey);

      await W.processPreKeyBundle(
        recipientAddress,
        localAddress,
        bundle.registrationId,
        identityKey,
        bundle.signedPreKeyId,
        signedPreKey,
        bundle.signedPreKeySignature,
        bundle.preKeyId ?? undefined,
        bundle.preKey ?? undefined,
        bundle.kyberPreKeyId ?? 0,
        bundle.kyberPreKey ?? new Uint8Array(0),
        bundle.kyberPreKeySignature ?? new Uint8Array(0),
        sessionStore,
        identityStore,
      );

      await saveSession(recipientId, recipientDeviceId);
    });
  }

  async hasSession(remoteUuid: string, remoteDeviceId: number): Promise<boolean> {
    if (!sessionStore) return false;

    try {
      const address = makeAddress(remoteUuid, remoteDeviceId);
      const inWasm = await sessionStore.has_session(address);
      if (inWasm) return true;

      // Fall back to IndexedDB (session exists there but not loaded yet).
      if (localUuid) {
        const sessionRecord = await storage.loadSessionRecord(localUuid, remoteUuid, remoteDeviceId);
        if (sessionRecord?.record && sessionRecord.record.length > 0) {
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  async archiveSession(remoteUuid: string, remoteDeviceId: number): Promise<void> {
    if (!sessionStore) {
      throw new Error('Signal client not initialized');
    }
    const address = makeAddress(remoteUuid, remoteDeviceId);
    try {
      await sessionStore.archive_session(address);
    } catch (e) {
      // best-effort
    }
    await storage.deleteSession(remoteUuid, remoteDeviceId);
  }

  async encryptMessage(
    recipientId: string,
    recipientDeviceId: number,
    plaintext: string | Uint8Array,
  ): Promise<EncryptedMessage> {
    if (!sessionStore || !identityStore) {
      throw new Error('Signal client not initialized');
    }

    return operationQueue.enqueue(async () => {
      const messageBytes =
        typeof plaintext === 'string' ? new TextEncoder().encode(plaintext) : plaintext;

      // Import session from IndexedDB if needed.
      await ensureSessionLoaded(recipientId, recipientDeviceId);

      const recipientAddress = makeAddress(recipientId, recipientDeviceId);
      const ciphertext = await wasmModule!.encryptMessage(
        messageBytes,
        recipientAddress,
        localAddress,
        sessionStore,
        identityStore,
      );

      await saveSession(recipientId, recipientDeviceId);

      return {
        type: ciphertext.message_type ?? 1,
        body: ciphertext.body,
        senderUserId: this.userId,
        senderDeviceId: this.deviceId,
      };
    });
  }

  async decryptMessage(
    senderId: string,
    senderDeviceId: number,
    encrypted: EncryptedMessage,
  ): Promise<DecryptedMessage> {
    if (!sessionStore || !identityStore) {
      throw new Error('Signal client not initialized');
    }

    return operationQueue.enqueue(async () => {
      const senderAddress = makeAddress(senderId, senderDeviceId);

      // For SignalMessage (type 2) we need an existing session.
      if (encrypted.type === 2) {
        await ensureSessionLoaded(senderId, senderDeviceId);
      } else if (encrypted.type === 3) {
        // PreKeyMessage establishes a new session. Archive any existing one.
        let hasExisting = false;
        try {
          hasExisting = await sessionStore.has_session(senderAddress);
        } catch {
          hasExisting = false;
        }
        if (hasExisting) {
          try {
            await sessionStore.archive_session(senderAddress);
          } catch {
            // best-effort
          }
        }
      }

      const key = `${senderId}.${senderDeviceId}`;
      const currentFailures = decryptionFailures.get(key) ?? 0;

      try {
        const decrypted = await wasmModule!.decryptMessage(
          encrypted.body,
          encrypted.type ?? 3,
          senderAddress,
          localAddress,
          sessionStore,
          identityStore,
          preKeyStore,
          signedPreKeyStore,
          kyberPreKeyStore,
        );

        decryptionFailures.delete(key);
        await saveSession(senderId, senderDeviceId);

        const plaintext = new TextDecoder().decode(decrypted);
        return {
          type: encrypted.type,
          body: decrypted,
          senderUserId: senderId,
          senderDeviceId,
        };
      } catch (error) {
        console.error(`[Signal] Decryption failed for ${senderId}.${senderDeviceId}:`, error);
        decryptionFailures.set(key, currentFailures + 1);

        if (encrypted.type === 2 && currentFailures >= 2) {
          await storage.deleteSession(senderId, senderDeviceId);
          decryptionFailures.delete(key);
          const sessionError = new Error('Session corrupted - new PreKeyMessage required');
          (sessionError as any).code = 'SESSION_CORRUPTED';
          (sessionError as any).requiresNewSession = true;
          throw sessionError;
        }

        if (encrypted.type === 3) {
          await storage.deleteSession(senderId, senderDeviceId);
          decryptionFailures.delete(key);
          const preKeyError = new Error('Cannot decrypt PreKeyMessage: prekeys not found in WASM');
          (preKeyError as any).code = 'PREKEY_NOT_FOUND';
          (preKeyError as any).requiresNewSession = true;
          throw preKeyError;
        }

        throw error;
      }
    });
  }

  async generatePreKeyBundle(): Promise<PreKeyBundle> {
    if (!identityKeyPair || !identityStore) {
      throw new Error('Signal client not initialized');
    }

    const W = wasmModule!;
    const identityKeyPub = identityKeyPair.public_key.serialize();
    const registrationId = await storage.loadRegistration().then(r => r?.registrationId ?? 1);

    const preKeys = await this.generateAndStorePreKeys(1);
    const signedPreKey = await this.generateAndStoreSignedPreKey();
    const kyberPreKey = await this.generateAndStoreKyberPreKey();

    const preKey = preKeys[0];

    return {
      registrationId,
      deviceId: this._deviceId,
      identityKey: identityKeyPub,
      preKeyId: preKey?.id,
      preKey: preKey?.public_key,
      signedPreKeyId: signedPreKey?.id,
      signedPreKey: signedPreKey?.public_key,
      signedPreKeySignature: signedPreKey?.signature,
      kyberPreKeyId: kyberPreKey?.id,
      kyberPreKey: kyberPreKey?.public_key,
      kyberPreKeySignature: kyberPreKey?.signature,
    };
  }

  async generateSafetyNumber(
    contactUuid: string,
    contactIdentityKey: Uint8Array,
  ): Promise<string> {
    if (!identityKeyPair) {
      throw new Error('Signal client not initialized');
    }
    const W = wasmModule!;
    const contactPub = W.WasmPublicKey.deserialize(contactIdentityKey);
    const sn = W.generateSafetyNumber(localUuid, identityKeyPair.public_key, contactUuid, contactPub);
    return sn?.displayable || '';
  }

  private async saveState(): Promise<void> {
    if (!identityKeyPair) return;
    await storage.saveSignalClientState({
      userId: currentUserId,
      identityKeyPair: {
        publicKey: identityKeyPair.public_key.serialize(),
        privateKey: identityKeyPair.private_key.serialize(),
      },
      registrationId: await storage.loadRegistration().then(r => r?.registrationId ?? 1),
      deviceId: currentDeviceId,
      nextPreKeyId,
      nextSignedPreKeyId,
      nextKyberPreKeyId,
      localDeviceUuid: localUuid,
    });
  }

  async cleanup(): Promise<void> {
    freeAllStores();
    isInitialized = false;
    currentUserId = '';
    currentDeviceId = 0;
    localUuid = '';
    identityKeyPair = null;
    localAddress = null;
  }

  get initialized(): boolean {
    return isInitialized;
  }

  get userId(): string {
    return currentUserId;
  }

  get deviceId(): number {
    return currentDeviceId;
  }

  get uuid(): string {
    return localUuid;
  }

  get client_(): any {
    // Backwards-compatible accessor (returns the in-memory store bag).
    return {
      identityStore,
      sessionStore,
      preKeyStore,
      signedPreKeyStore,
      kyberPreKeyStore,
      senderKeyStore,
      identityKeyPair,
      localAddress,
    };
  }
}

// ==================== Standalone Exports ====================

export { storage };
export { core };
export { utils };

// Database initialization
export async function initSignalDB(): Promise<IDBDatabase> {
  return storage.initSignalDB();
}

// State check functions
export function isSignalInitialized(): boolean {
  return isInitialized;
}

export function getCurrentUserId(): string {
  return currentUserId;
}

export function getCurrentDeviceId(): number {
  return currentDeviceId;
}

export function getLocalUuid(): string {
  return localUuid;
}

export function getLocalDeviceId(): number {
  return currentDeviceId;
}

// Message types
export const MESSAGE_TYPES = {
  PRE_KEY: 3,
  SIGNAL: 2,
  SENDER_KEY: 7,
};

// Cleanup functions
export async function cleanupSignal(): Promise<void> {
  freeAllStores();
  isInitialized = false;
  currentUserId = '';
  currentDeviceId = 0;
  localUuid = '';
  identityKeyPair = null;
  localAddress = null;
}

export async function clearAllSignalData(): Promise<void> {
  await cleanupSignal();
  await storage.clearAllStores();
}

export async function isSignalStateRestorable(): Promise<boolean> {
  const state = await storage.loadSignalClientState();
  return state !== null;
}

// ==================== Initialization with Restore ====================

export async function initializeSignalWithRestore(
  userId: string,
  forceNewKeys = false,
): Promise<SignalInitializationResult> {
  try {
    const existingState = await storage.loadSignalClientState();
    const existingIdentity = await storage.loadIdentityKey(userId);

    if (existingState && !forceNewKeys && existingIdentity) {
      await loadSignalModule();

      const publicKey = utils.base64ToUint8Array(existingIdentity.publicKey);
      const privateKey = utils.base64ToUint8Array(existingIdentity.privateKey);
      const registrationId = existingState.registrationId ?? 1;
      const uuidToUse = existingState.localDeviceUuid || '';

      if (!uuidToUse || typeof uuidToUse !== 'string') {
        console.error('[Signal] UUID is invalid, cannot restore state');
        throw new Error('Invalid UUID in stored state');
      }

      const deviceId = await storage.getOrCreateDeviceId(true);

      // Restore offsets from persisted state.
      nextPreKeyId = existingState.nextPreKeyId ?? 1;
      nextSignedPreKeyId = existingState.nextSignedPreKeyId ?? 1;
      nextKyberPreKeyId = existingState.nextKyberPreKeyId ?? 1;

      // Build the WASM-side state from stored bytes.
      const W = wasmModule!;
      identityKeyPair = identityFromStoredBytes(publicKey, privateKey);
      localAddress = new W.WasmProtocolAddress(uuidToUse, deviceId);

      identityStore = new W.WasmInMemIdentityKeyStore(identityKeyPair, registrationId);
      sessionStore = new W.WasmInMemSessionStore();
      preKeyStore = new W.WasmInMemPreKeyStore();
      signedPreKeyStore = new W.WasmInMemSignedPreKeyStore();
      kyberPreKeyStore = new W.WasmInMemKyberPreKeyStore();
      senderKeyStore = new W.WasmInMemSenderKeyStore();

      currentUserId = userId;
      currentDeviceId = deviceId;
      localUuid = uuidToUse;
      isInitialized = true;

      // Import pre-keys from IndexedDB into the in-memory stores.
      await ensureKeys();
      wasmPreKeysLoaded = true;

      return {
        success: true,
        deviceId: currentDeviceId,
        uuid: localUuid,
      };
    }

    // Fresh registration path.
    await loadSignalModule();
    await storage.initSignalDB();

    currentDeviceId = await storage.getOrCreateDeviceId();
    const storedUuid = await storage.loadLocalDeviceUuid();
    if (storedUuid && typeof storedUuid === 'string') {
      localUuid = storedUuid;
    } else {
      if (storedUuid) {
        await storage.storeLocalDeviceUuid('');
      }
      localUuid = utils.bytesToUuid(generate_uuid());
      await storage.storeLocalDeviceUuid(localUuid);
    }
    currentUserId = userId;

    const W = wasmModule!;
    const privateKey = W.WasmPrivateKey.generate();
    const publicKey = privateKey.getPublicKey();
    identityKeyPair = new W.WasmIdentityKeyPair(publicKey, privateKey);
    localAddress = new W.WasmProtocolAddress(localUuid, currentDeviceId);

    const registrationId = W.generateRegistrationId();
    identityStore = new W.WasmInMemIdentityKeyStore(identityKeyPair, registrationId);
    sessionStore = new W.WasmInMemSessionStore();
    preKeyStore = new W.WasmInMemPreKeyStore();
    signedPreKeyStore = new W.WasmInMemSignedPreKeyStore();
    kyberPreKeyStore = new W.WasmInMemKyberPreKeyStore();
    senderKeyStore = new W.WasmInMemSenderKeyStore();
    isInitialized = true;

    nextPreKeyId = 1;
    nextSignedPreKeyId = 1;
    nextKyberPreKeyId = 1;

    await storage.storeIdentityKey(
      userId,
      utils.uint8ArrayToBase64(publicKey.serialize()),
      utils.uint8ArrayToBase64(privateKey.serialize()),
    );

    const preKeysForPublish: StoredPreKey[] = [];
    const preKeys = await W.generatePreKeys(nextPreKeyId, 100, preKeyStore);
    nextPreKeyId += 100;
    for (const pk of preKeys) {
      if (pk.id && pk.public_key) {
        await storage.storePreKey({
          id: pk.id,
          publicKey: utils.uint8ArrayToBase64(pk.public_key),
          record: pk.record ? utils.uint8ArrayToBase64(pk.record) : '',
          createdAt: Date.now(),
        });
        preKeysForPublish.push({
          id: pk.id,
          publicKey: utils.uint8ArrayToBase64(pk.public_key),
          createdAt: Date.now(),
        });
      }
    }

    const signedPreKey = await W.generateSignedPreKey(nextSignedPreKeyId, identityKeyPair, signedPreKeyStore);
    nextSignedPreKeyId += 1;
    const signedPreKeyForPublish: StoredSignedPreKey = {
      id: signedPreKey?.id ?? 0,
      publicKey: signedPreKey?.public_key ? utils.uint8ArrayToBase64(signedPreKey.public_key) : '',
      signature: signedPreKey?.signature ? utils.uint8ArrayToBase64(signedPreKey.signature) : '',
      createdAt: Date.now(),
    };
    if (signedPreKey?.id && signedPreKey?.public_key && localUuid) {
      await storage.storeSignedPreKeyWithRecord(
        localUuid,
        signedPreKey.id,
        signedPreKey.public_key,
        signedPreKey.signature,
        signedPreKey.record,
        Date.now(),
        Date.now(),
      );
    }

    const kyberPreKey = await W.generateKyberPreKey(nextKyberPreKeyId, identityKeyPair, kyberPreKeyStore);
    nextKyberPreKeyId += 1;
    const kyberPreKeyForPublish: StoredKyberPreKey = {
      id: kyberPreKey?.id ?? 0,
      publicKey: kyberPreKey?.public_key ? utils.uint8ArrayToBase64(kyberPreKey.public_key) : '',
      signature: kyberPreKey?.signature ? utils.uint8ArrayToBase64(kyberPreKey.signature) : '',
      createdAt: Date.now(),
    };
    if (kyberPreKey?.id && kyberPreKey?.public_key && localUuid) {
      await storage.storeKyberPreKeyWithRecord(
        localUuid,
        kyberPreKey.id,
        kyberPreKey.public_key,
        kyberPreKey.signature,
        kyberPreKey.record,
        Date.now(),
        Date.now(),
      );
    }

    await storage.saveSignalClientState({
      userId,
      identityKeyPair: {
        publicKey: publicKey.serialize(),
        privateKey: privateKey.serialize(),
      },
      registrationId,
      deviceId: currentDeviceId,
      nextPreKeyId,
      nextSignedPreKeyId,
      nextKyberPreKeyId,
      localDeviceUuid: localUuid,
    });

    wasmPreKeysLoaded = true;

    return {
      success: true,
      deviceId: currentDeviceId,
      uuid: localUuid,
      keysForPublishing: {
        preKeys: preKeysForPublish,
        signedPreKeys: [signedPreKeyForPublish],
        kyberPreKeys: [kyberPreKeyForPublish],
        identityKey: utils.uint8ArrayToBase64(publicKey.serialize()),
        registrationId,
        deviceId: currentDeviceId,
      },
    };
  } catch (error) {
    console.error('[Signal] Initialization failed:', error);
    return {
      success: false,
      error: String(error),
    };
  }
}

// ==================== Logout Functions ====================

export async function uiLogout(): Promise<void> {
  freeAllStores();
  isInitialized = false;
  currentUserId = '';
  currentDeviceId = 0;
  localUuid = '';
  identityKeyPair = null;
  localAddress = null;
  wasmPreKeysLoaded = false;
  decryptionFailures.clear();
}

export async function fullLogout(): Promise<void> {
  freeAllStores();
  isInitialized = false;
  currentUserId = '';
  currentDeviceId = 0;
  localUuid = '';
  identityKeyPair = null;
  localAddress = null;
  wasmPreKeysLoaded = false;
  decryptionFailures.clear();

  await storage.clearAllStores();
  // Drop the in-memory KEK cache so the next login re-loads the KEK
  // from the keystore IndexedDB. We deliberately do NOT delete the
  // keystore DB itself — the persisted KEK must remain so the same
  // device can re-read its wrapped Signal state on next login. If the
  // user clears all browser data for the origin, the keystore DB is
  // wiped alongside the Signal DB and a fresh KEK is generated on next
  // first launch (which is the correct "new device" semantics).
  clearKEKCache();
}

// ==================== Group Encryption Standalone Functions ====================

export async function initializeSenderKey(groupId: string): Promise<Uint8Array> {
  const proto = new SignalProtocol();
  // Reuse module-level state.
  (proto as any)._userId = currentUserId;
  (proto as any)._deviceId = currentDeviceId;
  (proto as any)._uuid = localUuid;
  return proto.initializeSenderKey(groupId);
}

/**
 * SECURITY (P0-5): Archive (wipe) the local user's SenderKey for a group.
 *
 * Called when group membership changes (member added/removed). Without
 * this rotation, a removed participant can keep decrypting future group
 * messages because their copy of the SenderKey never expires.
 *
 * signal-wasm 0.2.x does NOT expose a per-key `remove_sender_key` API
 * on `WasmInMemSenderKeyStore` (only `export_sender_key`/`import_sender_key`),
 * so to truly evict the old chain from WASM memory we:
 *   1. Delete the persisted record from IndexedDB.
 *   2. Free the entire in-memory `senderKeyStore` and allocate a fresh one.
 *   3. Re-import every OTHER group's sender key from IndexedDB so that
 *      unrelated groups keep working.
 *
 * The caller is expected to follow up with `initializeSenderKey(chatId)`
 * to mint a brand-new chain key + signing keypair, then broadcast the
 * new SKDM to the remaining participants.
 *
 * @param groupId  The group whose local SenderKey should be archived.
 */
export async function archiveSenderKey(groupId: string): Promise<void> {
  return operationQueue.enqueue(() => archiveSenderKeyInner(groupId));
}

/**
 * Inner implementation of `archiveSenderKey` — MUST be called from inside
 * the operation queue (either via `archiveSenderKey` or `rotateSenderKey`).
 * It does not enqueue on its own to avoid deadlocks when composed with
 * other queued operations.
 */
async function archiveSenderKeyInner(groupId: string): Promise<void> {
  if (!senderKeyStore) {
    throw new Error('SignalClient not initialized');
  }
  if (!currentUserId) {
    throw new Error('Current user ID not available');
  }

  // 1. Drop the persisted record for this (group, user).
  try {
    await storage.deleteSenderKey(groupId, currentUserId);
  } catch (e) {
    console.warn(`[Signal] archiveSenderKey: failed to delete persisted sender key for ${groupId}:`, e);
  }

  // 2. Free the in-memory store and re-create it.
  try {
    if (typeof senderKeyStore.free === 'function') {
      senderKeyStore.free();
    }
  } catch {
    // ignore — best-effort
  }
  const W = wasmModule ?? (await loadSignalModule());
  senderKeyStore = new W.WasmInMemSenderKeyStore();

  // 3. Re-import all OTHER sender keys (excluding the archived group/user).
  try {
    const all = await storage.getAllSenderKeys();
    for (const sk of all) {
      if (sk.groupId === groupId && sk.senderUserId === currentUserId) {
        continue; // skip the archived one
      }
      try {
        const bytes = utils.base64ToUint8Array(sk.senderKeyState);
        if (bytes.length === 0) continue;
        const address = makeAddress(sk.senderUserId, sk.senderKeyId);
        await senderKeyStore.import_sender_key(address, sk.groupId, bytes);
      } catch (e) {
        console.warn(
          `[Signal] archiveSenderKey: failed to re-import sender key for ${sk.groupId}/${sk.senderUserId}:`,
          e,
        );
      }
    }
  } catch (e) {
    console.warn('[Signal] archiveSenderKey: failed to re-import other sender keys:', e);
  }
}

/**
 * SECURITY (P0-5): Atomically archive the old SenderKey for a group and
 * initialize a fresh one. Returns the new SKDM bytes that the caller must
 * broadcast to the remaining group participants.
 *
 * Equivalent to calling `archiveSenderKey(chatId)` followed by
 * `initializeSenderKey(chatId)`, but performed inside a single operation
 * queue slot so no other operation can race with the rotation (and
 * without dead-locking on nested enqueue calls).
 */
export async function rotateSenderKey(groupId: string): Promise<Uint8Array> {
  return operationQueue.enqueue(async () => {
    await archiveSenderKeyInner(groupId);
    // Re-create the proto shim and call its initializeSenderKey directly.
    // SignalProtocol.initializeSenderKey enqueues on its own, which would
    // deadlock — so we inline the WASM call here instead.
    if (!senderKeyStore || !localAddress) {
      throw new Error('Signal client not initialized');
    }
    const skdm = await wasmModule!.createSenderKeyDistribution(localAddress, groupId, senderKeyStore);

    const senderKeyState = await senderKeyStore.export_sender_key(localAddress, groupId);
    if (!senderKeyState) {
      throw new Error('Failed to export sender key state');
    }

    await storage.storeSenderKey({
      id: storage.generateSenderKeyId(groupId, currentUserId),
      groupId,
      senderUserId: currentUserId,
      senderKeyId: 0,
      senderKeyState: utils.uint8ArrayToBase64(senderKeyState),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    return skdm;
  });
}

export async function addSenderKey(
  groupId: string,
  senderUserId: string,
  senderKeyId: number,
  senderKeyState: Uint8Array | string,
): Promise<void> {
  return operationQueue.enqueue(async () => {
    if (!senderKeyStore) {
      throw new Error('SignalClient not initialized');
    }
    const wasmReady = await ensureWasmState();
    if (!wasmReady) {
      throw new Error('Signal WASM state not ready - reinitialization required');
    }

    try {
      const bytes =
        typeof senderKeyState === 'string'
          ? utils.base64ToUint8Array(senderKeyState)
          : senderKeyState;
      const address = makeAddress(senderUserId, senderKeyId);
      await senderKeyStore.import_sender_key(address, groupId, bytes);

      await storage.storeSenderKey({
        id: storage.generateSenderKeyId(groupId, senderUserId),
        groupId,
        senderUserId,
        senderKeyId,
        senderKeyState: typeof senderKeyState === 'string' ? senderKeyState : utils.uint8ArrayToBase64(senderKeyState),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    } catch (error) {
      console.error(`[Signal] Failed to add Sender Key for group ${groupId}:`, error);
      throw error;
    }
  });
}

export async function encryptGroupMessage(groupId: string, message: string): Promise<EncryptedMessage> {
  return operationQueue.enqueue(async () => {
    if (!senderKeyStore || !localAddress) {
      throw new Error('SignalClient not initialized');
    }
    const wasmReady = await ensureWasmState();
    if (!wasmReady) {
      throw new Error('Signal WASM state not ready - reinitialization required');
    }

    try {
      const senderKeys = await storage.getSenderKeysByGroup(groupId);
      if (senderKeys.length === 0) {
        await initializeSenderKey(groupId);
      } else {
        let existing: Uint8Array | null = null;
        try {
          existing = await senderKeyStore.export_sender_key(localAddress, groupId) ?? null;
        } catch {
          existing = null;
        }
        if (!existing) {
          const mySenderKey = senderKeys.find(sk => sk.senderUserId === currentUserId);
          if (mySenderKey?.senderKeyState) {
            try {
              const senderKeyBytes = utils.base64ToUint8Array(mySenderKey.senderKeyState);
              if (senderKeyBytes.length === 0) {
                throw new Error('Sender key bytes empty');
              }
              await senderKeyStore.import_sender_key(localAddress, groupId, senderKeyBytes);
            } catch (e) {
              console.warn('[Signal] Failed to import sender key, reinitializing:', e);
              await initializeSenderKey(groupId);
            }
          } else {
            await initializeSenderKey(groupId);
          }
        }
      }

      const messageBytes = new TextEncoder().encode(message);
      const encrypted = await wasmModule!.encryptGroupMessage(localAddress, groupId, messageBytes, senderKeyStore);

      try {
        const senderKeyState = await senderKeyStore.export_sender_key(localAddress, groupId);
        if (senderKeyState) {
          await storage.storeSenderKey({
            id: storage.generateSenderKeyId(groupId, currentUserId),
            groupId,
            senderUserId: currentUserId,
            senderKeyId: 0,
            senderKeyState: utils.uint8ArrayToBase64(senderKeyState),
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
        }
      } catch {
        // best-effort
      }

      return {
        type: message_type_sender_key(),
        body: encrypted,
        senderUserId: currentUserId,
        senderDeviceId: currentDeviceId,
      };
    } catch (error) {
      console.error(`[Signal] Failed to encrypt group message for ${groupId}:`, error);
      throw error;
    }
  });
}

export async function decryptGroupMessage(
  groupId: string,
  senderUserId: string,
  senderDeviceId: number,
  message: Uint8Array,
  messageType: number,
): Promise<string> {
  return operationQueue.enqueue(async () => {
    if (!senderKeyStore) {
      throw new Error('SignalClient not initialized');
    }
    const wasmReady = await ensureWasmState();
    if (!wasmReady) {
      throw new Error('Signal WASM state not ready - reinitialization required');
    }

    try {
      const senderAddress = makeAddress(senderUserId, senderDeviceId);

      let existingSenderKey: Uint8Array | null = null;
      try {
        existingSenderKey = await senderKeyStore.export_sender_key(senderAddress, groupId) ?? null;
      } catch {
        existingSenderKey = null;
      }
      if (!existingSenderKey) {
        const senderKeyRecord = await storage.getSenderKey(groupId, senderUserId);
        if (senderKeyRecord?.senderKeyState) {
          try {
            const senderKeyBytes = utils.base64ToUint8Array(senderKeyRecord.senderKeyState);
            await senderKeyStore.import_sender_key(senderAddress, groupId, senderKeyBytes);
          } catch (e) {
            console.warn('[Signal] Failed to import sender key for decryption:', e);
            throw new Error('Missing sender key for decryption');
          }
        } else {
          throw new Error('No sender key record found for decryption');
        }
      }

      const decryptedBytes = await wasmModule!.decryptGroupMessage(senderAddress, message, senderKeyStore);
      const decrypted = new TextDecoder().decode(decryptedBytes);

      try {
        const senderKeyState = await senderKeyStore.export_sender_key(senderAddress, groupId);
        if (senderKeyState) {
          await storage.storeSenderKey({
            id: storage.generateSenderKeyId(groupId, senderUserId),
            groupId,
            senderUserId,
            senderKeyId: senderDeviceId,
            senderKeyState: utils.uint8ArrayToBase64(senderKeyState),
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
        }
      } catch {
        // best-effort
      }

      return decrypted;
    } catch (error) {
      console.error(`[Signal] Failed to decrypt group message from ${senderUserId} for ${groupId}:`, error);
      throw error;
    }
  });
}

// ==================== Device Management ====================

export async function unlinkDevice(deviceId: number): Promise<void> {
  await storage.unlinkDevice(deviceId);
}

// ==================== Orphaned Keys Cleanup ====================

export async function cleanupOrphanedIdentityKeys(currentUserId: string): Promise<void> {
  await storage.cleanupOrphanedIdentityKeys(currentUserId);
}

// ==================== Encryption Standalone Functions ====================

export async function encryptMessage(
  recipientId: string,
  recipientDeviceId: number,
  plaintext: Uint8Array | string,
): Promise<EncryptedMessage> {
  return operationQueue.enqueue(async () => {
    if (!sessionStore || !identityStore) {
      throw new Error('SignalClient not initialized');
    }
    const wasmReady = await ensureWasmState();
    if (!wasmReady) {
      throw new Error('Signal WASM state not ready - reinitialization required');
    }

    const messageBytes = typeof plaintext === 'string' ? new TextEncoder().encode(plaintext) : plaintext;

    await ensureSessionLoaded(recipientId, recipientDeviceId);

    const recipientAddress = makeAddress(recipientId, recipientDeviceId);
    const result = await wasmModule!.encryptMessage(
      messageBytes,
      recipientAddress,
      localAddress,
      sessionStore,
      identityStore,
    );

    await saveSession(recipientId, recipientDeviceId);

    return {
      type: result?.message_type ?? 1,
      body: result?.body,
      senderUserId: currentUserId,
      senderDeviceId: currentDeviceId,
    };
  });
}

export async function decryptMessage(
  senderId: string,
  senderDeviceId: number,
  message: Uint8Array,
  messageType?: number,
): Promise<{ body: Uint8Array; type: number }> {
  return operationQueue.enqueue(async () => {
    if (!sessionStore || !identityStore) {
      throw new Error('SignalClient not initialized');
    }
    const wasmReady = await ensureWasmState();
    if (!wasmReady) {
      throw new Error('Signal WASM state not ready - reinitialization required');
    }

    const senderAddress = makeAddress(senderId, senderDeviceId);
    const type = messageType ?? 3;

    if (type === 2) {
      await ensureSessionLoaded(senderId, senderDeviceId);
    } else if (type === 3) {
      let hasExisting = false;
      try {
        hasExisting = await sessionStore.has_session(senderAddress);
      } catch {
        hasExisting = false;
      }
      if (hasExisting) {
        try {
          await sessionStore.archive_session(senderAddress);
        } catch {
          // best-effort
        }
      }
    }

    const key = `${senderId}.${senderDeviceId}`;
    const currentFailures = decryptionFailures.get(key) ?? 0;

    try {
      const decrypted = await wasmModule!.decryptMessage(
        message,
        type,
        senderAddress,
        localAddress,
        sessionStore,
        identityStore,
        preKeyStore,
        signedPreKeyStore,
        kyberPreKeyStore,
      );

      decryptionFailures.delete(key);
      await saveSession(senderId, senderDeviceId);

      return { body: decrypted, type };
    } catch (error) {
      console.error(`[Signal] Decryption failed for ${senderId}.${senderDeviceId}:`, error);
      decryptionFailures.set(key, currentFailures + 1);

      if (type === 2 && currentFailures >= 2) {
        await storage.deleteSession(senderId, senderDeviceId);
        decryptionFailures.delete(key);
        const sessionError = new Error('Session corrupted - new PreKeyMessage required');
        (sessionError as any).code = 'SESSION_CORRUPTED';
        (sessionError as any).requiresNewSession = true;
        throw sessionError;
      }

      if (type === 3) {
        await storage.deleteSession(senderId, senderDeviceId);
        decryptionFailures.delete(key);
        const preKeyError = new Error('Cannot decrypt PreKeyMessage: prekeys not found in WASM');
        (preKeyError as any).code = 'PREKEY_NOT_FOUND';
        (preKeyError as any).requiresNewSession = true;
        throw preKeyError;
      }

      throw error;
    }
  });
}

export async function processPreKeyBundle(
  recipientId: string,
  recipientDeviceId: number,
  bundle: PreKeyBundle,
): Promise<void> {
  if (!sessionStore || !identityStore) {
    throw new Error('SignalClient not initialized');
  }

  return operationQueue.enqueue(async () => {
    const W = wasmModule!;
    const recipientAddress = new W.WasmProtocolAddress(recipientId, recipientDeviceId);
    const identityKey = W.WasmPublicKey.deserialize(bundle.identityKey);
    const signedPreKey = W.WasmPublicKey.deserialize(bundle.signedPreKey);

    await W.processPreKeyBundle(
      recipientAddress,
      localAddress,
      bundle.registrationId,
      identityKey,
      bundle.signedPreKeyId,
      signedPreKey,
      bundle.signedPreKeySignature,
      bundle.preKeyId ?? undefined,
      bundle.preKey ?? undefined,
      bundle.kyberPreKeyId ?? 0,
      bundle.kyberPreKey ?? new Uint8Array(0),
      bundle.kyberPreKeySignature ?? new Uint8Array(0),
      sessionStore,
      identityStore,
    );

    await saveSession(recipientId, recipientDeviceId);
  });
}

export async function generatePreKeyBundle(
  _preKeyId?: number,
  _signedPreKeyId?: number,
  _kyberPreKeyId?: number,
): Promise<PreKeyBundle> {
  // In v0.2.x the IDs are owned by us (nextPreKeyId / nextSignedPreKeyId /
  // nextKyberPreKeyId counters). The legacy args are kept for
  // backwards-compat with callers but ignored.
  void _preKeyId;
  void _signedPreKeyId;
  void _kyberPreKeyId;

  if (!identityKeyPair) {
    throw new Error('SignalClient not initialized');
  }

  const W = wasmModule!;
  const identityKeyPub = identityKeyPair.public_key.serialize();
  const registration = await storage.loadRegistration();
  const registrationId = registration?.registrationId ?? 1;

  const preKeys = await W.generatePreKeys(nextPreKeyId, 1, preKeyStore);
  nextPreKeyId += 1;
  const preKey = preKeys[0];
  await persistPreKey(preKey);

  const signedPreKey = await W.generateSignedPreKey(nextSignedPreKeyId, identityKeyPair, signedPreKeyStore);
  nextSignedPreKeyId += 1;
  await persistSignedPreKey(signedPreKey);

  const kyberPreKey = await W.generateKyberPreKey(nextKyberPreKeyId, identityKeyPair, kyberPreKeyStore);
  nextKyberPreKeyId += 1;
  await persistKyberPreKey(kyberPreKey);

  return {
    registrationId,
    deviceId: currentDeviceId,
    identityKey: identityKeyPub,
    preKeyId: preKey?.id,
    preKey: preKey?.public_key,
    signedPreKeyId: signedPreKey?.id,
    signedPreKey: signedPreKey?.public_key,
    signedPreKeySignature: signedPreKey?.signature,
    kyberPreKeyId: kyberPreKey?.id,
    kyberPreKey: kyberPreKey?.public_key,
    kyberPreKeySignature: kyberPreKey?.signature,
  };
}

async function persistPreKey(pk: any): Promise<void> {
  if (!pk?.id || !pk?.public_key) return;
  await storage.storePreKey({
    id: pk.id,
    publicKey: utils.uint8ArrayToBase64(pk.public_key),
    record: pk.record ? utils.uint8ArrayToBase64(pk.record) : '',
    createdAt: Date.now(),
  });
}

async function persistSignedPreKey(spk: any): Promise<void> {
  if (!spk?.id || !spk?.public_key || !localUuid || !spk.record) return;
  await storage.storeSignedPreKeyWithRecord(
    localUuid,
    spk.id,
    spk.public_key,
    spk.signature,
    spk.record,
    Date.now(),
    Date.now(),
  );
}

async function persistKyberPreKey(kpk: any): Promise<void> {
  if (!kpk?.id || !kpk?.public_key || !localUuid || !kpk.record) return;
  await storage.storeKyberPreKeyWithRecord(
    localUuid,
    kpk.id,
    kpk.public_key,
    kpk.signature,
    kpk.record,
    Date.now(),
    Date.now(),
  );
}

// ==================== Session Functions ====================

export async function archiveSession(
  remoteUuid: string,
  remoteDeviceId: number,
): Promise<void> {
  if (!sessionStore) {
    throw new Error('SignalClient not initialized');
  }
  const address = makeAddress(remoteUuid, remoteDeviceId);
  try {
    await sessionStore.archive_session(address);
  } catch {
    // best-effort
  }
  await storage.deleteSession(remoteUuid, remoteDeviceId);
}

export async function hasSession(
  remoteUuid: string,
  remoteDeviceId: number,
): Promise<boolean> {
  if (!sessionStore) return false;

  try {
    const address = makeAddress(remoteUuid, remoteDeviceId);
    const inWasm = await sessionStore.has_session(address);
    if (inWasm) return true;
    if (localUuid) {
      const sessionRecord = await storage.loadSessionRecord(localUuid, remoteUuid, remoteDeviceId);
      if (sessionRecord?.record && sessionRecord.record.length > 0) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

// ==================== Export/Import Functions ====================

export function destroySignalClient(_client?: any): void {
  // Backwards-compatible signature: callers used to pass a (now removed)
  // SignalClient instance. We ignore it and free the global stores.
  void _client;
  freeAllStores();
}

export async function generateSafetyNumber(
  _client: any,
  contactUuid: string,
  contactIdentityKey: Uint8Array,
): Promise<string> {
  if (!identityKeyPair) {
    throw new Error('SignalClient not initialized');
  }
  const W = wasmModule!;
  const contactPub = W.WasmPublicKey.deserialize(contactIdentityKey);
  const sn = W.generateSafetyNumber(localUuid, identityKeyPair.public_key, contactUuid, contactPub);
  return sn?.displayable || '';
}

export async function exportSession(
  remoteUuid: string,
  remoteDeviceId: number,
): Promise<Uint8Array | null> {
  if (!sessionStore) return null;
  try {
    const address = makeAddress(remoteUuid, remoteDeviceId);
    return (await sessionStore.export_session(address)) ?? null;
  } catch {
    return null;
  }
}

export async function importSession(
  remoteUuid: string,
  remoteDeviceId: number,
  sessionBytes: Uint8Array,
): Promise<void> {
  if (!sessionStore) {
    throw new Error('SignalClient not initialized');
  }
  const address = makeAddress(remoteUuid, remoteDeviceId);
  await sessionStore.import_session(address, sessionBytes);
}

export function getIdentityPublicKey(): Uint8Array | null {
  if (!identityKeyPair) return null;
  return identityKeyPair.public_key.serialize();
}

export async function getRegistrationId(): Promise<number> {
  if (!identityStore) return 0;
  // In v0.2.0 the identity store holds the registration ID internally.
  // We persist it in IndexedDB; read it back from there.
  const r = await storage.loadRegistration();
  return r?.registrationId ?? 0;
}

export function getNextPreKeyId(): number {
  return nextPreKeyId;
}

export function getNextSignedPreKeyId(): number {
  return nextSignedPreKeyId;
}

export function getNextKyberPreKeyId(): number {
  return nextKyberPreKeyId;
}

export async function exportPreKey(preKeyId: number): Promise<Uint8Array | null> {
  if (!preKeyStore) return null;
  try {
    return (await preKeyStore.export_pre_key(preKeyId)) ?? null;
  } catch {
    return null;
  }
}

export async function importPreKey(
  preKeyId: number,
  preKeyBytes: Uint8Array,
): Promise<void> {
  if (!preKeyStore) {
    throw new Error('SignalClient not initialized');
  }
  await preKeyStore.import_pre_key(preKeyId, preKeyBytes);
}

export async function exportSignedPreKey(signedPreKeyId: number): Promise<Uint8Array | null> {
  if (!signedPreKeyStore) return null;
  try {
    return (await signedPreKeyStore.export_signed_pre_key(signedPreKeyId)) ?? null;
  } catch {
    return null;
  }
}

export async function importSignedPreKey(
  signedPreKeyId: number,
  signedPreKeyBytes: Uint8Array,
): Promise<void> {
  if (!signedPreKeyStore) {
    throw new Error('SignalClient not initialized');
  }
  await signedPreKeyStore.import_signed_pre_key(signedPreKeyId, signedPreKeyBytes);
}

export async function exportKyberPreKey(kyberPreKeyId: number): Promise<Uint8Array | null> {
  if (!kyberPreKeyStore) return null;
  try {
    return (await kyberPreKeyStore.export_kyber_pre_key(kyberPreKeyId)) ?? null;
  } catch {
    return null;
  }
}

export async function importKyberPreKey(
  kyberPreKeyId: number,
  kyberPreKeyBytes: Uint8Array,
): Promise<void> {
  if (!kyberPreKeyStore) {
    throw new Error('SignalClient not initialized');
  }
  await kyberPreKeyStore.import_kyber_pre_key(kyberPreKeyId, kyberPreKeyBytes);
}

export async function exportSenderKey(distributionId: string): Promise<Uint8Array | null> {
  if (!senderKeyStore || !localAddress) return null;
  try {
    return (await senderKeyStore.export_sender_key(localAddress, distributionId)) ?? null;
  } catch {
    return null;
  }
}

export async function importSenderKey(
  distributionId: string,
  senderKeyBytes: Uint8Array,
): Promise<void> {
  if (!senderKeyStore || !localAddress) {
    throw new Error('SignalClient not initialized');
  }
  await senderKeyStore.import_sender_key(localAddress, distributionId, senderKeyBytes);
}

// ==================== Sender Key Distribution Functions ====================

export async function createSenderKeyDistribution(
  groupId: string,
  senderUserId: string,
  _recipientId: string,
  _recipientDeviceId: number,
): Promise<{ distributionId: string; message: Uint8Array } | null> {
  return operationQueue.enqueue(async () => {
    if (!senderKeyStore || !localAddress) {
      throw new Error('SignalClient not initialized');
    }
    if (!localUuid) {
      throw new Error('Local UUID not available');
    }

    try {
      const existingKey = await storage.getSenderKey(groupId, senderUserId);
      if (!existingKey) {
        await initializeSenderKey(groupId);
      }

      const distributionId = groupId;
      const skdm = await wasmModule!.createSenderKeyDistribution(localAddress, distributionId, senderKeyStore);
      return { distributionId, message: skdm };
    } catch (error) {
      console.error(`[Signal] Failed to create SKDM for group ${groupId}:`, error);
      return null;
    }
  });
}

export async function processSenderKeyDistribution(
  groupId: string,
  senderUserId: string,
  senderDeviceId: number,
  skdm: Uint8Array,
  _senderPublicKey?: Uint8Array,
): Promise<boolean> {
  return operationQueue.enqueue(async () => {
    if (!senderKeyStore) {
      throw new Error('SignalClient not initialized');
    }
    if (!localUuid) {
      throw new Error('Local UUID not available');
    }

    try {
      const senderAddress = makeAddress(senderUserId, senderDeviceId);
      await wasmModule!.processSenderKeyDistribution(senderAddress, skdm, senderKeyStore);

      const exportedState = await senderKeyStore.export_sender_key(senderAddress, groupId);
      if (exportedState) {
        await storage.storeSenderKey({
          id: storage.generateSenderKeyId(groupId, senderUserId),
          groupId,
          senderUserId,
          senderKeyId: 0,
          senderKeyState: utils.uint8ArrayToBase64(exportedState),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }

      return true;
    } catch (error) {
      console.error(`[Signal] Failed to process SKDM for group ${groupId}:`, error);
      return false;
    }
  });
}

export async function exportSenderKeyDistribution(groupId: string): Promise<{
  distributionId: string;
  senderKeyId: number;
  senderKeyBytes: Uint8Array;
} | null> {
  return operationQueue.enqueue(async () => {
    if (!senderKeyStore || !localAddress) {
      throw new Error('SignalClient not initialized');
    }
    if (!currentUserId) {
      throw new Error('Current user ID not available');
    }

    try {
      const senderKey = await storage.getSenderKey(groupId, currentUserId);
      if (!senderKey) {
        await initializeSenderKey(groupId);
        return null;
      }

      const distributionId = groupId;
      const senderKeyBytes = await senderKeyStore.export_sender_key(localAddress, distributionId);
      if (!senderKeyBytes) return null;

      return {
        distributionId,
        senderKeyId: senderKey.senderKeyId,
        senderKeyBytes,
      };
    } catch (error) {
      console.error(`[Signal] Failed to export Sender Key distribution for group ${groupId}:`, error);
      return null;
    }
  });
}

// ==================== Internal Helpers ====================

/**
 * Free all in-memory store instances. Safe to call when nothing is allocated.
 */
function freeAllStores(): void {
  for (const store of [identityStore, sessionStore, preKeyStore, signedPreKeyStore, kyberPreKeyStore, senderKeyStore, identityKeyPair, localAddress]) {
    if (store && typeof store.free === 'function') {
      try {
        store.free();
      } catch {
        // ignore
      }
    }
  }
  identityStore = null;
  sessionStore = null;
  preKeyStore = null;
  signedPreKeyStore = null;
  kyberPreKeyStore = null;
  senderKeyStore = null;
  identityKeyPair = null;
  localAddress = null;
}

/**
 * Ensure a session from IndexedDB is loaded into the WASM session store
 * before encrypt/decrypt. Idempotent.
 */
async function ensureSessionLoaded(remoteUuid: string, remoteDeviceId: number): Promise<void> {
  if (!sessionStore) return;

  const address = makeAddress(remoteUuid, remoteDeviceId);

  // Check WASM-side first.
  let inWasm = false;
  try {
    inWasm = await sessionStore.has_session(address);
  } catch {
    inWasm = false;
  }
  if (inWasm) return;

  // Fall back to IndexedDB.
  if (!localUuid) return;
  const sessionRecord = await storage.loadSessionRecord(localUuid, remoteUuid, remoteDeviceId);
  if (sessionRecord?.localUuid && sessionRecord.localUuid !== localUuid) {
    await storage.deleteSession(remoteUuid, remoteDeviceId);
    return;
  }
  if (sessionRecord?.record) {
    try {
      await sessionStore.import_session(address, sessionRecord.record);
    } catch {
      // Import may fail if a session was concurrently created.
    }
  }
}

/**
 * Import stored keys into the in-memory WASM stores.
 * Loads PreKeys, SignedPreKeys and KyberPreKeys from IndexedDB. Required
 * for decryption of PreKeyMessage (type 3) to work after a page reload.
 */
export async function ensureKeys(_client?: any, _uuid?: string): Promise<void> {
  if (!preKeyStore || !signedPreKeyStore || !kyberPreKeyStore) {
    throw new Error('Stores not initialized');
  }
  const uuid = _uuid ?? localUuid;
  if (!uuid) {
    throw new Error('Local UUID required for ensureKeys');
  }

  try {
    // PreKeys
    const preKeys = await storage.loadAllPreKeyRecords(uuid);
    for (const pk of preKeys) {
      try {
        await preKeyStore.import_pre_key(pk.id, pk.record);
      } catch {
        // already imported or invalid; ignore
      }
    }

    // SignedPreKeys
    const signedPreKeys = await storage.loadAllSignedPreKeyRecords(uuid);
    if (signedPreKeys.length === 0) {
      const newSpk = await wasmModule!.generateSignedPreKey(nextSignedPreKeyId, identityKeyPair, signedPreKeyStore);
      nextSignedPreKeyId += 1;
      await persistSignedPreKey(newSpk);
    } else {
      for (const spk of signedPreKeys) {
        try {
          await signedPreKeyStore.import_signed_pre_key(spk.id, spk.record);
        } catch {
          // ignore
        }
      }
    }

    // KyberPreKeys
    const kyberPreKeys = await storage.loadAllKyberPreKeyRecords(uuid);
    if (kyberPreKeys.length === 0) {
      const newKpk = await wasmModule!.generateKyberPreKey(nextKyberPreKeyId, identityKeyPair, kyberPreKeyStore);
      nextKyberPreKeyId += 1;
      await persistKyberPreKey(newKpk);
    } else {
      for (const kpk of kyberPreKeys) {
        try {
          await kyberPreKeyStore.import_kyber_pre_key(kpk.id, kpk.record);
        } catch {
          // ignore
        }
      }
    }
  } catch (error) {
    console.error('[Signal] ensureKeys failed:', error);
    throw error;
  }
}

/**
 * Ensure WASM state is ready for decryption (HMR recovery).
 * Restores identity + prekeys from IndexedDB if the in-memory stores
 * were wiped by an HMR reload.
 */
async function ensureWasmState(): Promise<boolean> {
  if (wasmPreKeysLoaded && identityStore && localUuid) {
    return true;
  }

  const existingState = await storage.loadSignalClientState();
  if (!existingState) return false;

  const userId = existingState.userId || currentUserId;
  if (!userId) return false;

  const existingIdentity = await storage.loadIdentityKey(userId);
  if (!existingIdentity) return false;

  await loadSignalModule();

  if (!identityStore) {
    const publicKey = utils.base64ToUint8Array(existingIdentity.publicKey);
    const privateKey = utils.base64ToUint8Array(existingIdentity.privateKey);
    const registrationId = existingState.registrationId ?? 1;
    const uuidToUse = existingState.localDeviceUuid || '';
    if (!uuidToUse || typeof uuidToUse !== 'string') return false;

    const deviceId = existingState.deviceId || (await storage.getOrCreateDeviceId(true));
    nextPreKeyId = existingState.nextPreKeyId ?? 1;
    nextSignedPreKeyId = existingState.nextSignedPreKeyId ?? 1;
    nextKyberPreKeyId = existingState.nextKyberPreKeyId ?? 1;

    try {
      const W = wasmModule!;
      identityKeyPair = identityFromStoredBytes(publicKey, privateKey);
      localAddress = new W.WasmProtocolAddress(uuidToUse, deviceId);

      identityStore = new W.WasmInMemIdentityKeyStore(identityKeyPair, registrationId);
      sessionStore = new W.WasmInMemSessionStore();
      preKeyStore = new W.WasmInMemPreKeyStore();
      signedPreKeyStore = new W.WasmInMemSignedPreKeyStore();
      kyberPreKeyStore = new W.WasmInMemKyberPreKeyStore();
      senderKeyStore = new W.WasmInMemSenderKeyStore();

      currentUserId = userId;
      currentDeviceId = deviceId;
      localUuid = uuidToUse;
      isInitialized = true;
    } catch (error) {
      console.error('[Signal] ensureWasmState - Failed to restore state:', error);
      return false;
    }
  }

  if (!localUuid) {
    const storedUuid = await storage.loadLocalDeviceUuid();
    if (!storedUuid) return false;
    localUuid = storedUuid;
  }

  try {
    await ensureKeys();
    wasmPreKeysLoaded = true;
    return true;
  } catch (error) {
    console.error('[Signal] ensureWasmState - Failed to load PreKeys:', error);
    return false;
  }
}

// ==================== Prekey Manager Helpers (U10 / U11) ====================
//
// These functions back the `usePrekeyManager` hook:
//   - `generatePreKeyBatch(count)`  → U10 (one-time prekey replenishment)
//   - `generateKyberPreKeyBatch(count)` → U10 (PQ one-time prekey replenishment)
//   - `generateNewSignedPreKey()`   → U11 (signed prekey rotation)
//   - `getSignedPreKeyInfo()`       → U11 (read age of the most-recent SPK)
//   - `persistKeyCounters()`        → save nextPreKeyId / nextSignedPreKeyId /
//                                     nextKyberPreKeyId to IndexedDB so the
//                                     incremented counters survive a reload.
//
// All four generators use the same in-memory store singletons and the same
// IndexedDB-backed storage helpers that initial registration uses, so the
// freshly-generated keys are immediately usable by `encryptMessage` /
// `processPreKeyBundle` (they're imported into the WASM stores on the fly
// via `generatePreKeys` / `generateSignedPreKey` / `generateKyberPreKey`).

/**
 * Persist the current `nextPreKeyId` / `nextSignedPreKeyId` /
 * `nextKyberPreKeyId` counters to IndexedDB. Required after every batch
 * generation so the counters survive a page reload — otherwise the next
 * generation would reuse the same IDs and overwrite existing records.
 *
 * Reads the rest of the state (identity, registrationId, deviceId, uuid)
 * from existing storage so the caller doesn't have to provide it.
 */
export async function persistKeyCounters(): Promise<void> {
  if (!identityKeyPair || !localUuid) return;
  try {
    const registration = await storage.loadRegistration();
    await storage.saveSignalClientState({
      userId: currentUserId,
      identityKeyPair: {
        publicKey: identityKeyPair.public_key.serialize(),
        privateKey: identityKeyPair.private_key.serialize(),
      },
      registrationId: registration?.registrationId ?? 1,
      deviceId: currentDeviceId,
      nextPreKeyId,
      nextSignedPreKeyId,
      nextKyberPreKeyId,
      localDeviceUuid: localUuid,
    });
  } catch (err) {
    console.error('[Signal] persistKeyCounters failed:', err);
  }
}

/**
 * Generate a batch of one-time EC PreKeys and persist them to IndexedDB
 * (both the public material and the WASM record). Used by U10
 * (prekey replenishment) when the server-side pool drops below 25%.
 *
 * Returns the public material for each generated key — the caller
 * uploads this array to the server via `/keys/pqxdh/one-time`.
 */
export async function generatePreKeyBatch(
  count: number,
): Promise<Array<{ id: number; publicKey: Uint8Array }>> {
  if (!preKeyStore || !wasmModule) {
    throw new Error('Signal not initialized');
  }
  if (count <= 0) return [];

  const startId = nextPreKeyId;
  const preKeys = await wasmModule.generatePreKeys(startId, count, preKeyStore);
  nextPreKeyId += count;

  const result: Array<{ id: number; publicKey: Uint8Array }> = [];
  for (const pk of preKeys) {
    if (pk?.id && pk?.public_key) {
      await storage.storePreKey({
        id: pk.id,
        publicKey: utils.uint8ArrayToBase64(pk.public_key),
        record: pk.record ? utils.uint8ArrayToBase64(pk.record) : '',
        createdAt: Date.now(),
      });
      result.push({ id: pk.id, publicKey: pk.public_key });
    }
  }

  await persistKeyCounters();
  return result;
}

/**
 * Generate a batch of one-time PQ (Kyber) PreKeys and persist them to
 * IndexedDB. Used by U10 alongside `generatePreKeyBatch`.
 *
 * Returns public material + signature for each generated key.
 */
export async function generateKyberPreKeyBatch(
  count: number,
): Promise<Array<{ id: number; publicKey: Uint8Array; signature: Uint8Array }>> {
  if (!kyberPreKeyStore || !wasmModule || !identityKeyPair) {
    throw new Error('Signal not initialized');
  }
  if (count <= 0) return [];

  const result: Array<{ id: number; publicKey: Uint8Array; signature: Uint8Array }> = [];
  for (let i = 0; i < count; i++) {
    const kpk = await wasmModule.generateKyberPreKey(
      nextKyberPreKeyId,
      identityKeyPair,
      kyberPreKeyStore,
    );
    nextKyberPreKeyId += 1;

    if (kpk?.id && kpk?.public_key && localUuid && kpk.record) {
      await storage.storeKyberPreKeyWithRecord(
        localUuid,
        kpk.id,
        kpk.public_key,
        kpk.signature,
        kpk.record,
        Date.now(),
        Date.now(),
      );
      result.push({
        id: kpk.id,
        publicKey: kpk.public_key,
        signature: kpk.signature,
      });
    }
  }

  await persistKeyCounters();
  return result;
}

/**
 * Generate a single new SignedPreKey and persist it to IndexedDB
 * (both the public material + signature and the WASM record).
 *
 * Used by U11 (signed prekey rotation) when the current SPK is older
 * than 30 days. The OLD SPK record is intentionally kept in storage
 * so in-flight PreKey messages encrypted against it can still be
 * decrypted — only the SERVER's view of "current SPK" is updated
 * (via the `publishSignalKeys` API call in the hook).
 */
export async function generateNewSignedPreKey(): Promise<{
  id: number;
  publicKey: Uint8Array;
  signature: Uint8Array;
}> {
  if (!signedPreKeyStore || !wasmModule || !identityKeyPair) {
    throw new Error('Signal not initialized');
  }

  const spk = await wasmModule.generateSignedPreKey(
    nextSignedPreKeyId,
    identityKeyPair,
    signedPreKeyStore,
  );
  nextSignedPreKeyId += 1;

  if (!spk?.id || !spk?.public_key) {
    throw new Error('Failed to generate signed prekey');
  }

  if (localUuid && spk.record) {
    await storage.storeSignedPreKeyWithRecord(
      localUuid,
      spk.id,
      spk.public_key,
      spk.signature,
      spk.record,
      Date.now(),
      Date.now(),
    );
  }

  await persistKeyCounters();
  return {
    id: spk.id,
    publicKey: spk.public_key,
    signature: spk.signature,
  };
}

/**
 * Return the `{ id, createdAt }` of the most-recently-created signed
 * prekey for the current local device, or `null` if no SPK exists in
 * storage. Used by U11 to decide whether the current SPK is older
 * than 30 days and needs rotating.
 *
 * "Most recent" is determined by the `timestamp` field on the
 * DBSignedPreKeyRecord (set at creation time). We don't track which
 * SPK is the "current published" one explicitly — but since rotation
 * always creates a newer one and we publish only the newest, the
 * newest record IS the published one.
 */
export async function getSignedPreKeyInfo(): Promise<{
  id: number;
  createdAt: number;
} | null> {
  if (!localUuid) return null;
  try {
    const records = await storage.loadAllSignedPreKeyRecords(localUuid);
    if (records.length === 0) return null;
    // Newest first.
    records.sort((a, b) => b.timestamp - a.timestamp);
    const newest = records[0];
    if (!newest) return null;
    return { id: newest.id, createdAt: newest.timestamp };
  } catch (err) {
    console.error('[Signal] getSignedPreKeyInfo failed:', err);
    return null;
  }
}
