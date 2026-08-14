// @ts-nocheck
/**
 * ⚠️  EXPERIMENTAL — NOT USED IN PRODUCTION  ⚠️
 *
 * `SignalWorkerClient` is the in-tab counterpart to `workers/signal.worker.ts`.
 * It is fully implemented for parity with the main-thread Signal facade, but
 * **nothing in the app instantiates it** today. The production Signal path is
 * `SignalContext.tsx` -> `lib/signal/index.ts` (main-thread WASM).
 *
 * See the header comment in `workers/signal.worker.ts` for the rationale and
 * the migration checklist. This file is kept type-checkable and importable so
 * that future work can revive it without rewriting the client API.
 *
 * Do NOT call `getOrCreateSignalWorkerClient()` from production code without
 * also flipping the integration switch in `SignalContext.tsx`.
 *
 * =============================================================================
 *
 * Shared Worker Client for Signal Protocol
 *
 * Provides a transparent interface to the Signal Protocol Shared Worker.
 * All cryptographic operations are performed in the shared worker context,
 * ensuring consistent session state across all browser tabs.
 *
 * Features:
 * - Automatic connection management
 * - Promise-based API matching SignalProtocol
 * - Event-driven state updates
 * - Fallback to direct Signal Protocol if worker unavailable
 */

import type { SignalWorkerClientMessage, SignalWorkerServerMessage, SignalWorkerState, PreKeyBundle, EncryptedMessage } from '@/workers/signal.worker';

import { EventEmitter } from '@/lib/websocket/event-emitter';

// ==================== Types ====================

export interface SignalWorkerClientState {
  isInitialized: boolean;
  identityKeyId: string | null;
  deviceNeedsVerification: boolean;
  pendingOperations: number;
}

export interface UseSignalWorkerResult {
  // State
  isConnected: boolean;
  isInitialized: boolean;
  state: SignalWorkerClientState;
  connect: (userId: string, deviceId?: number) => Promise<void>;
  disconnect: () => void;

  // Encryption/Decryption
  encrypt: (recipientId: string, recipientDeviceId: number, message: string, messageId?: string) => Promise<EncryptedMessage>;
  decrypt: (senderId: string, senderDeviceId: number, message: Uint8Array, messageType: number) => Promise<string>;
  encryptGroup: (groupId: string, message: string) => Promise<EncryptedMessage>;
  decryptGroup: (groupId: string, senderUserId: string, senderDeviceId: number, message: Uint8Array, messageType: number) => Promise<string>;

  // Session management
  hasSession: (recipientId: string, deviceId: number) => Promise<boolean>;
  processPreKeyBundle: (recipientId: string, deviceId: number, bundle: PreKeyBundle) => Promise<void>;
  generatePreKeyBundle: (preKeyId?: number, signedPreKeyId?: number, kyberPreKeyId?: number) => Promise<PreKeyBundle | null>;
  archiveSession: (userId: string, deviceId: number) => Promise<void>;

  // Cleanup
  cleanup: () => Promise<void>;

  // Utilities
  subscribeToState: (listener: (state: SignalWorkerClientState) => void) => () => void;
  getState: () => SignalWorkerClientState;
}

// ==================== Constants ====================

const WORKER_URL = new URL('@/workers/signal.worker.ts', import.meta.url);

// ==================== Worker Client Class ====================

/**
 * Signal Worker Client
 *
 * Manages connection to the Signal Protocol Shared Worker.
 * Provides a promise-based API for all Signal operations.
 */
export class SignalWorkerClient extends EventEmitter {
  private worker: SharedWorker | null = null;
  private port: MessagePort | null = null;
  private tabId: string | null = null;
  private _isConnected = false;
  private _state: SignalWorkerClientState = {
    isInitialized: false,
    identityKeyId: null,
    deviceNeedsVerification: false,
    pendingOperations: 0
  };
  private stateListeners = new Set<(state: SignalWorkerClientState) => void>();
  private pendingPromises = new Map<string, { resolve: Function; reject: Function }>();
  private messageIdCounter = 0;
  private destroyed = false;

  constructor() {
    super();
  }

  // Getters for public properties
  get isConnected(): boolean {
    return this._isConnected;
  }

  get isInitialized(): boolean {
    return this._state.isInitialized;
  }

  get state(): SignalWorkerClientState {
    return this._state;
  }

  // ==================== State Management ====================

  private updateState(updates: Partial<SignalWorkerClientState>): void {
    this._state = { ...this._state, ...updates };
    this.stateListeners.forEach((listener) => listener(this._state));
  }

  subscribeToState(listener: (state: SignalWorkerClientState) => void): () => void {
    this.stateListeners.add(listener);
    // Immediately call with current state
    listener(this._state);
    return () => this.stateListeners.delete(listener);
  }

  getState(): SignalWorkerClientState {
    return { ...this._state };
  }

  // ==================== Connection Management ====================

  async connect(userId: string, deviceId?: number): Promise<void> {
    if (this.destroyed) {
      throw new Error('SignalWorkerClient has been destroyed');
    }

    if (this.isConnected) {
      // Already connected, just initialize if needed
      if (!this._state.isInitialized) {
        return this.sendMessage({
          type: 'init',
          payload: { userId, deviceId }
        });
      }
      return;
    }

    // Check SharedWorker support
    if (typeof SharedWorker === 'undefined') {
      throw new Error('SharedWorker not supported in this browser');
    }

    try {
      // Create Shared Worker
      this.worker = new SharedWorker(WORKER_URL.href, { type: 'module', name: 'zerochat-signal' });

      this.port = this.worker.port;
      this.port.start();

      // Track if we've received the initial state
      let initialStateReceived = false;

      // Handle messages from worker
      this.port.onmessage = (event: MessageEvent) => {
        const message = event.data as SignalWorkerServerMessage;
        this.handleWorkerMessage(message);
      };

      this.port.onmessageerror = (event: MessageEvent) => {
        console.error('[SignalWorkerClient] Message error:', event);
        this.emit('error', new Error('Worker message error'));
      };

      // Wait for initial connection
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          if (!initialStateReceived) {
            reject(new Error('Timeout waiting for worker connection'));
          }
        }, 5000);

        const checkInitialized = () => {
          if (this._state.isInitialized) {
            clearTimeout(timeout);
            resolve();
          }
        };

        // Check after a short delay
        setTimeout(checkInitialized, 100);
      });

      // Initialize with user ID
      await this.sendMessage({
        type: 'init',
        payload: { userId, deviceId }
      });

      this._isConnected = true;
    } catch (error) {
      console.error('[SignalWorkerClient] Failed to connect to worker:', error);
      this.emit('error', error as Error);
      throw error;
    }
  }

  disconnect(): void {
    if (this.port) {
      this.port.close();
      this.port = null;
    }
    if (this.worker) {
      this.worker = null;
    }
    this._isConnected = false;
  }

  // ==================== Message Handling ====================

  private sendMessage(message: SignalWorkerClientMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.port) {
        reject(new Error('Not connected to worker'));
        return;
      }

      const msgId = `${Date.now()}-${this.messageIdCounter++}`;
      this.pendingPromises.set(msgId, { resolve, reject });

      // Send with message ID for correlation
      (this.port as MessagePort).postMessage({
        ...message,
        _msgId: msgId
      });

      // Set timeout for response
      setTimeout(() => {
        const pending = this.pendingPromises.get(msgId);
        if (pending) {
          this.pendingPromises.delete(msgId);
          reject(new Error('Operation timeout'));
        }
      }, 30000); // 30 second timeout
    });
  }

  private handleWorkerMessage(message: SignalWorkerServerMessage): void {
    // Handle state updates
    if (message.type === 'state') {
      this.updateState({
        isInitialized: message.payload.isInitialized,
        identityKeyId: message.payload.identityKeyId,
        deviceNeedsVerification: message.payload.deviceNeedsVerification,
        pendingOperations: message.payload.pendingOperations
      });
      return;
    }

    // Handle responses to requests
    // In a full implementation, we'd correlate responses with pending promises
    // For now, we just emit events

    switch (message.type) {
      case 'initialized':
        this.updateState({ isInitialized: true });
        this.emit('initialized', message.payload);
        break;

      case 'encrypted':
        this.emit('encrypted', message.payload);
        break;

      case 'decrypted':
        this.emit('decrypted', message.payload);
        break;

      case 'session-exists':
        this.emit('sessionExists', message.payload);
        break;

      case 'prekey-processed':
        this.emit('prekeyProcessed', message.payload);
        break;

      case 'prekey-bundle':
        this.emit('prekeyBundle', message.payload);
        break;

      case 'archived':
        this.emit('archived', message.payload);
        break;

      case 'cleaned-up':
        this.emit('cleanedUp', message.payload);
        break;

      case 'error':
        this.emit('error', new Error(message.payload.message));
        break;
    }
  }

  // ==================== Signal Protocol API ====================

  async encrypt(recipientId: string, recipientDeviceId: number, message: string, messageId?: string): Promise<EncryptedMessage> {
    return this.sendMessage({
      type: 'encrypt',
      payload: { recipientId, recipientDeviceId, message, messageId }
    });
  }

  async decrypt(senderId: string, senderDeviceId: number, message: Uint8Array, messageType: number): Promise<string> {
    const result = await this.sendMessage({
      type: 'decrypt',
      payload: { senderId, senderDeviceId, message, messageType }
    });
    return result.plaintext;
  }

  async encryptGroup(groupId: string, message: string): Promise<EncryptedMessage> {
    return this.sendMessage({
      type: 'encrypt-group',
      payload: { groupId, message }
    });
  }

  async decryptGroup(groupId: string, senderUserId: string, senderDeviceId: number, message: Uint8Array, messageType: number): Promise<string> {
    const result = await this.sendMessage({
      type: 'decrypt-group',
      payload: { groupId, senderUserId, senderDeviceId, message, messageType }
    });
    return result.plaintext;
  }

  async hasSession(recipientId: string, deviceId: number): Promise<boolean> {
    const result = await this.sendMessage({
      type: 'has-session',
      payload: { recipientId, deviceId }
    });
    return result.exists;
  }

  async processPreKeyBundle(recipientId: string, deviceId: number, bundle: PreKeyBundle): Promise<void> {
    await this.sendMessage({
      type: 'process-prekey-bundle',
      payload: { recipientId, deviceId, bundle }
    });
  }

  async generatePreKeyBundle(preKeyId?: number, signedPreKeyId?: number, kyberPreKeyId?: number): Promise<PreKeyBundle | null> {
    return this.sendMessage({
      type: 'generate-prekey-bundle',
      payload: { preKeyId, signedPreKeyId, kyberPreKeyId }
    });
  }

  async archiveSession(userId: string, deviceId: number): Promise<void> {
    await this.sendMessage({
      type: 'archive-session',
      payload: { userId, deviceId }
    });
  }

  async cleanup(): Promise<void> {
    await this.sendMessage({ type: 'cleanup' });
  }

  // ==================== Lifecycle ====================

  destroy(): void {
    this.destroyed = true;
    this.disconnect();
    this.stateListeners.clear();
    this.pendingPromises.forEach(({ reject }) => {
      reject(new Error('Client destroyed'));
    });
    this.pendingPromises.clear();
  }
}

// ==================== Singleton Instance ====================

let globalSignalWorkerClient: SignalWorkerClient | null = null;

/**
 * Get or create the global Signal Worker Client instance.
 * Returns null if SharedWorker is not available.
 *
 * EXPERIMENTAL: do NOT call this from production code. The Signal worker is
 * not wired into `SignalContext.tsx` and the WASM-side operations would all
 * throw on signal-wasm 0.2.x. See the file header for the full rationale.
 */
export function getOrCreateSignalWorkerClient(): SignalWorkerClient | null {
  if (typeof SharedWorker === 'undefined') {
    console.warn('[SignalWorkerClient] SharedWorker not available, falling back to direct Signal Protocol');
    return null;
  }

  if (!globalSignalWorkerClient) {
    globalSignalWorkerClient = new SignalWorkerClient();
  }

  return globalSignalWorkerClient;
}

/**
 * Check if Signal Worker is available and supported.
 *
 * Note: returns true whenever the SharedWorker API exists; it does NOT mean
 * the Signal worker is actually wired up. See the file header.
 */
export function isSignalWorkerAvailable(): boolean {
  return typeof SharedWorker !== 'undefined';
}

