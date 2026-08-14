// @ts-nocheck
/**
 * ⚠️  EXPERIMENTAL — NOT USED IN PRODUCTION  ⚠️
 *
 * This Signal Protocol Shared Worker is preserved as scaffolding for a future
 * migration of all Signal cryptographic operations out of the main thread.
 * It is **not instantiated anywhere in the app** today:
 *   - `SignalContext.tsx` initializes Signal in the main thread (via
 *     `lib/signal/index.ts`) and that is the only Signal path used by the UI.
 *   - `signal-worker-client.ts` defines `SignalWorkerClient` but no caller
 *     constructs it; `getOrCreateSignalWorkerClient()` is never invoked.
 *
 * Reasons for keeping Signal in the main thread for now:
 *   1. signal-wasm 0.2.x already runs in the main thread behind an operation
 *      queue that serializes ratchet mutations — concurrent access is safe.
 *   2. IndexedDB access from a SharedWorker is subject to Storage Access API
 *      restrictions in some browsers (Safari, Firefox private mode), which
 *      would break E2EE for affected users.
 *   3. Migrating the encrypt/decrypt hot-path to a worker is a large change
 *      with high regression risk on E2E tests; the WS Shared Worker already
 *      delivers the main win (1 WS per browser) without touching Signal.
 *
 * If you decide to revive this worker:
 *   - Port the v0.2.x modular store/function API (identity/session/prekey/
 *     signedPrekey/kyberPreKey/senderKey stores + encryptMessage /
 *     decryptMessage / processPreKeyBundle / etc.) from `lib/signal/index.ts`.
 *   - Wire `SignalContext.tsx` to use `SignalWorkerClient` instead of the
 *     in-process `signal` module when `isSignalWorkerAvailable()` returns
 *     true, with a hard fallback to the main-thread path otherwise.
 *   - Re-enable the test coverage for the worker path in
 *     `lib/signal/__tests__/`.
 *
 * Until then, leave this file as-is; do not delete (preserved for future
 * reference and to keep `signal-worker-client.ts` type-checking).
 *
 * =============================================================================
 *
 * Shared Worker for Signal Protocol
 *
 * Provides a single Signal Protocol instance shared across all browser tabs.
 * This eliminates session desynchronization issues in multi-tab scenarios.
 *
 * Architecture:
 * - One SignalClient instance per browser (shared across tabs)
 * - MessagePort-based communication with each tab
 * - All cryptographic operations go through the same WASM instance
 * - Session state is persisted to IndexedDB but cached in memory
 * - Operation queue ensures thread-safe access to ratchet state
 *
 * Benefits:
 * - No more decryption failures due to stale session state
 * - Consistent session state across all tabs
 * - Reduced memory usage (single WASM instance)
 * - Automatic session synchronization
 */

// ==================== Types ====================

/**
 * Message from tab to worker
 */
export type SignalWorkerClientMessage =
  | { type: 'init'; payload: { userId: string; deviceId?: number } }
  | { type: 'encrypt'; payload: { recipientId: string; recipientDeviceId: number; message: string; messageId?: string } }
  | { type: 'decrypt'; payload: { senderId: string; senderDeviceId: number; message: Uint8Array; messageType: number } }
  | { type: 'encrypt-group'; payload: { groupId: string; message: string } }
  | { type: 'decrypt-group'; payload: { groupId: string; senderUserId: string; senderDeviceId: number; message: Uint8Array; messageType: number } }
  | { type: 'has-session'; payload: { recipientId: string; deviceId: number } }
  | { type: 'process-prekey-bundle'; payload: { recipientId: string; deviceId: number; bundle: PreKeyBundle } }
  | { type: 'generate-prekey-bundle'; payload: { preKeyId?: number; signedPreKeyId?: number; kyberPreKeyId?: number } }
  | { type: 'archive-session'; payload: { userId: string; deviceId: number } }
  | { type: 'cleanup' }
  | { type: 'get-state' };

/**
 * Message from worker to tab
 */
export type SignalWorkerServerMessage =
  | { type: 'initialized'; payload: { success: boolean; identityKeyId?: string; deviceNeedsVerification?: boolean } }
  | { type: 'encrypted'; payload: EncryptedMessage }
  | { type: 'decrypted'; payload: { plaintext: string } }
  | { type: 'session-exists'; payload: { exists: boolean } }
  | { type: 'prekey-processed'; payload: { success: boolean } }
  | { type: 'prekey-bundle'; payload: PreKeyBundle | null }
  | { type: 'archived'; payload: { success: boolean } }
  | { type: 'cleaned-up'; payload: { success: boolean } }
  | { type: 'state'; payload: SignalWorkerState }
  | { type: 'error'; payload: { code: string; message: string; opId?: string } };

/**
 * Worker connection state
 */
export interface SignalWorkerState {
  isInitialized: boolean;
  userId: string | null;
  deviceId: number | null;
  identityKeyId: string | null | undefined;
  deviceNeedsVerification: boolean;
  pendingOperations: number;
}

/**
 * PreKeyBundle for key exchange
 */
export interface PreKeyBundle {
  deviceId: number;
  registrationId: number;
  identityKey: Uint8Array;
  preKeyId?: number;
  preKey?: Uint8Array;
  signedPreKeyId: number;
  signedPreKey: Uint8Array;
  signedPreKeySignature: Uint8Array;
  kyberPreKeyId?: number;
  kyberPreKey?: Uint8Array;
  kyberPreKeySignature?: Uint8Array;
}

/**
 * Encrypted message result
 */
export interface EncryptedMessage {
  type: number;
  body: Uint8Array;
  senderUserId: string;
  senderDeviceId: number;
  messageId?: string;
}

// ==================== Constants ====================

const WORKER_NAME = 'zerochat-signal';

// ==================== Global State ====================

// Signal Protocol state (singleton across all tabs)
let SignalProtocolClass: any = null;
let signalClient: any = null;
let isInitialized = false;
let userId: string | null = null;
let deviceId: number | null = null;
let identityKeyId: string | undefined = undefined;
let deviceNeedsVerification = false;

// Operation queue (same as in main thread)
let operationQueue: any = null;

// Tab connections
interface TabConnection {
  port: MessagePort;
  tabId: string;
}
const tabs = new Map<string, TabConnection>();

// Track pending operations per tab
const pendingOperations = new Map<string, number>();

// ==================== WASM Module Loader ====================

async function loadSignalModule(): Promise<void> {
  if (SignalProtocolClass) return;

  try {
    const module = await import('@getmaapp/signal-wasm');

    if (module.default && typeof module.default === 'function') {
      await module.default();
    }

    // signal-wasm v0.2.x removed the monolithic SignalClient class in
    // favour of a modular store/function API. The worker body below
    // has not been migrated yet, so we mark the protocol class as
    // "unavailable" and let each handler throw a clear error.
    SignalProtocolClass = module.SignalClient ?? null;
    if (!SignalProtocolClass) {
      console.warn('[SignalWorker] signal-wasm v0.2.x detected — worker is a stub, all operations will throw.');
    }
    console.log('[SignalWorker] WASM module loaded');
  } catch (error) {
    console.error('[SignalWorker] Failed to load WASM module:', error);
    throw error;
  }
}

// ==================== Operation Queue ====================

class SignalOperationQueue {
  private queue: Promise<void> = Promise.resolve();
  private pendingOperations = 0;

  async enqueue<T>(operation: () => Promise<T>): Promise<T> {
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
        console.error(`[SignalWorker] Operation ${opId} failed:`, error);
        reject(error);
      } finally {
        this.pendingOperations--;
      }
    });

    return resultPromise;
  }

  getPendingCount(): number {
    return this.pendingOperations;
  }
}

// ==================== Storage Helpers ====================

// Simple storage wrappers for worker environment
async function initSignalDB(): Promise<IDBDatabase> {
  // In worker, we need to open IndexedDB directly
  const DB_NAME = 'ZeroChatSignalDB';
  const DB_VERSION = 4;

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      // Create stores if they don't exist
      const stores = [
        'identityKeys',
        'preKeys',
        'signedPreKeys',
        'kyberPreKeys',
        'sessions',
        'senderKeys',
        'registration',
        'linkedDevices',
        'linkingRequests',
        'sesameState',
        'signalClientState'
      ];

      stores.forEach(storeName => {
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName);
        }
      });
    };
  });
}

async function storeSessionWithRecord(localUuid: string, remoteUuid: string, remoteDeviceId: number, sessionBytes: Uint8Array): Promise<void> {
  const db = await initSignalDB();
  const sessionKey = `${localUuid}-${remoteUuid}-${remoteDeviceId}`;

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['sessions'], 'readwrite');
    const store = transaction.objectStore('sessions');
    const request = store.put({
      id: sessionKey,
      localUuid,
      remoteUuid,
      remoteDeviceId,
      sessionState: sessionBytes,
      updatedAt: Date.now()
    });

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

async function loadSessionRecord(localUuid: string, remoteUuid: string, remoteDeviceId: number): Promise<{ sessionState: Uint8Array } | null> {
  const db = await initSignalDB();
  const sessionKey = `${localUuid}-${remoteUuid}-${remoteDeviceId}`;

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['sessions'], 'readonly');
    const store = transaction.objectStore('sessions');
    const request = store.get(sessionKey);

    request.onerror = () => resolve(null);
    request.onsuccess = () => {
      const result = request.result;
      resolve(result || null);
    };
  });
}

// ==================== Signal Protocol Initialization ====================

async function initializeSignalProtocol(userId: string, deviceId?: number): Promise<void> {
  if (!SignalProtocolClass) {
    await loadSignalModule();
  }

  if (!operationQueue) {
    operationQueue = new SignalOperationQueue();
  }

  // Create new client
  signalClient = new SignalProtocolClass();

  // Load or generate identity keys
  // TODO: Implement proper key loading from IndexedDB
  // For now, we'll generate new keys if not present

  // Initialize client
  // The actual initialization logic needs to be ported from the main thread
  // This is a simplified version

  isInitialized = true;
  console.log('[SignalWorker] Signal Protocol initialized for user:', userId);
}

// ==================== Encryption/Decryption Operations ====================

async function encryptMessage(recipientId: string, recipientDeviceId: number, message: string): Promise<EncryptedMessage> {
  if (!signalClient || !isInitialized) {
    throw new Error('Signal Protocol not initialized');
  }

  return operationQueue.enqueue(async () => {
    // TODO: Implement actual encryption
    // This requires proper session management
    throw new Error('Not implemented in worker yet');
  });
}

async function decryptMessage(senderId: string, senderDeviceId: number, message: Uint8Array, messageType: number): Promise<string> {
  if (!signalClient || !isInitialized) {
    throw new Error('Signal Protocol not initialized');
  }

  return operationQueue.enqueue(async () => {
    // TODO: Implement actual decryption
    // This requires proper session management
    throw new Error('Not implemented in worker yet');
  });
}

async function encryptGroupMessage(groupId: string, message: string): Promise<EncryptedMessage> {
  if (!signalClient || !isInitialized) {
    throw new Error('Signal Protocol not initialized');
  }

  return operationQueue.enqueue(async () => {
    // TODO: Implement group encryption
    throw new Error('Not implemented in worker yet');
  });
}

async function decryptGroupMessage(groupId: string, senderUserId: string, senderDeviceId: number, message: Uint8Array, messageType: number): Promise<string> {
  if (!signalClient || !isInitialized) {
    throw new Error('Signal Protocol not initialized');
  }

  return operationQueue.enqueue(async () => {
    // TODO: Implement group decryption
    throw new Error('Not implemented in worker yet');
  });
}

async function hasSession(recipientId: string, deviceId: number): Promise<boolean> {
  if (!signalClient || !isInitialized) {
    return false;
  }

  return operationQueue.enqueue(async () => {
    // TODO: Check if session exists
    return false;
  });
}

async function processPreKeyBundle(recipientId: string, deviceId: number, bundle: PreKeyBundle): Promise<void> {
  if (!signalClient || !isInitialized) {
    throw new Error('Signal Protocol not initialized');
  }

  return operationQueue.enqueue(async () => {
    // TODO: Process PreKeyBundle
    throw new Error('Not implemented in worker yet');
  });
}

async function generatePreKeyBundle(preKeyId?: number, signedPreKeyId?: number, kyberPreKeyId?: number): Promise<PreKeyBundle | null> {
  if (!signalClient || !isInitialized) {
    return null;
  }

  return operationQueue.enqueue(async () => {
    // TODO: Generate PreKeyBundle
    return null;
  });
}

async function archiveSession(userId: string, deviceId: number): Promise<void> {
  if (!signalClient || !isInitialized) {
    return;
  }

  return operationQueue.enqueue(async () => {
    // TODO: Archive session
  });
}

async function cleanup(): Promise<void> {
  if (signalClient) {
    // Cleanup if needed
    signalClient = null;
    isInitialized = false;
  }
}

// ==================== Message Handling ====================

function sendToTab(tabId: string, message: SignalWorkerServerMessage): void {
  const tab = tabs.get(tabId);
  if (tab) {
    tab.port.postMessage(message);
  }
}

function broadcastMessage(message: SignalWorkerServerMessage): void {
  tabs.forEach((tab) => {
    tab.port.postMessage(message);
  });
}

async function handleMessage(event: MessageEvent): Promise<void> {
  const message = event.data as SignalWorkerClientMessage;
  const tabId = event.ports[0]?.toString() || 'unknown';

  try {
    switch (message.type) {
      case 'init':
        userId = message.payload.userId;
        deviceId = message.payload.deviceId ?? 0;
        await initializeSignalProtocol(userId, deviceId);

        sendToTab(tabId, {
          type: 'initialized',
          payload: {
            success: true,
            identityKeyId,
            deviceNeedsVerification
          }
        });
        break;

      case 'encrypt':
        const encrypted = await encryptMessage(
          message.payload.recipientId,
          message.payload.recipientDeviceId,
          message.payload.message
        );
        sendToTab(tabId, { type: 'encrypted', payload: encrypted });
        break;

      case 'decrypt':
        const decrypted = await decryptMessage(
          message.payload.senderId,
          message.payload.senderDeviceId,
          message.payload.message,
          message.payload.messageType
        );
        sendToTab(tabId, { type: 'decrypted', payload: { plaintext: decrypted } });
        break;

      case 'encrypt-group':
        const groupEncrypted = await encryptGroupMessage(
          message.payload.groupId,
          message.payload.message
        );
        sendToTab(tabId, { type: 'encrypted', payload: groupEncrypted });
        break;

      case 'decrypt-group':
        const groupDecrypted = await decryptGroupMessage(
          message.payload.groupId,
          message.payload.senderUserId,
          message.payload.senderDeviceId,
          message.payload.message,
          message.payload.messageType
        );
        sendToTab(tabId, { type: 'decrypted', payload: { plaintext: groupDecrypted } });
        break;

      case 'has-session':
        const exists = await hasSession(message.payload.recipientId, message.payload.deviceId);
        sendToTab(tabId, { type: 'session-exists', payload: { exists } });
        break;

      case 'process-prekey-bundle':
        await processPreKeyBundle(
          message.payload.recipientId,
          message.payload.deviceId,
          message.payload.bundle
        );
        sendToTab(tabId, { type: 'prekey-processed', payload: { success: true } });
        break;

      case 'generate-prekey-bundle':
        const bundle = await generatePreKeyBundle(
          message.payload.preKeyId,
          message.payload.signedPreKeyId,
          message.payload.kyberPreKeyId
        );
        sendToTab(tabId, { type: 'prekey-bundle', payload: bundle });
        break;

      case 'archive-session':
        await archiveSession(message.payload.userId, message.payload.deviceId);
        sendToTab(tabId, { type: 'archived', payload: { success: true } });
        break;

      case 'cleanup':
        await cleanup();
        sendToTab(tabId, { type: 'cleaned-up', payload: { success: true } });
        break;

      case 'get-state':
        sendToTab(tabId, {
          type: 'state',
          payload: {
            isInitialized,
            userId,
            deviceId,
            identityKeyId,
            deviceNeedsVerification,
            pendingOperations: operationQueue ? operationQueue.getPendingCount() : 0
          }
        });
        break;

      default:
        // Exhaustive type check
        const _exhaustiveCheck: never = message;
        console.warn('[SignalWorker] Unknown message type:', _exhaustiveCheck);
    }
  } catch (error: any) {
    console.error('[SignalWorker] Error handling message:', error);
    sendToTab(tabId, {
      type: 'error',
      payload: {
        code: 'OPERATION_FAILED',
        message: error.message || 'Unknown error',
        opId: message.type
      }
    });
  }
}

// ==================== Worker Lifecycle ====================

// SharedWorkerGlobalScope onconnect handler
(self as any).onconnect = (event: MessageEvent) => {
  const port = event.ports[0];
  if (!port) {
    console.error('[SignalWorker] No port provided in connect event');
    return;
  }

  const tabId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  console.log('[SignalWorker] Tab connected:', tabId);

  // Store tab connection
  tabs.set(tabId, { port, tabId });

  // Handle messages from this tab
  port.onmessage = async (e: MessageEvent) => {
    await handleMessage(e);
  };

  port.onmessageerror = (error) => {
    console.error('[SignalWorker] Message error from tab:', tabId, error);
  };

  // Use addEventListener for close as onclose may not be defined in all types
  port.addEventListener('close', () => {
    console.log('[SignalWorker] Tab disconnected:', tabId);
    tabs.delete(tabId);

    // If no tabs connected, cleanup resources
    if (tabs.size === 0) {
      console.log('[SignalWorker] No tabs connected, cleaning up...');
      cleanup().catch(console.error);
    }
  });

  // Send initial state
  port.postMessage({
    type: 'state',
    payload: {
      isInitialized,
      userId,
      deviceId,
      identityKeyId,
      deviceNeedsVerification,
      pendingOperations: operationQueue ? operationQueue.getPendingCount() : 0
    }
  });
};

// Log worker start
console.log('[SignalWorker] Signal Protocol Shared Worker started');

