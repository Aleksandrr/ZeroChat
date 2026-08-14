/**
 * P2P Sync Manager
 * 
 * Handles peer-to-peer synchronization between user's devices.
 * Implements the Sesame protocol for multi-device sync.
 * 
 * Architecture:
 * Device A (new) --> SYNC_REQUEST --> Device B (active)
 * Device B collects history, encrypts with Signal Protocol
 * Device B --> SYNC_HISTORY --> Device A
 * Device A decrypts, applies to IndexedDB
 * Device A --> SYNC_ACK --> Server
 * 
 * Signal Protocol Encryption:
 * Per Sesame spec section 3.1-3.4, devices of the same user use Signal Protocol
 * for encrypting sync history. This provides:
 * - Forward secrecy via Double Ratchet
 * - Authentication via identity keys
 * - Post-quantum security via Kyber-768 (PQXDH)
 * 
 * @see docs/signal/sesame.md - Sesame protocol specification
 */

import { getAllMessages, getAllContacts, initMessagesDB, type StoredMessage, storeMessages, storeContacts, type ContactRecord } from '@/lib/messages/db';
import {
  decryptMessage,
  encryptMessage,
  getCurrentUserId,
  hasSession,
  isSignalInitialized,
  processPreKeyBundle,
} from '@/lib/signal';
import { 
  initSignalDB, 
  loadLocalDeviceUuid} from '@/lib/signal/storage';
import type { PreKeyBundle } from '@/lib/signal/types';
import { base64ToUint8Array,uint8ArrayToBase64 } from '@/lib/utils/buffer';
import type { 
  VectorClock, 
  WSSyncAcceptPayload,
  WSSyncAckPayload,
  WSSyncCancelPayload,
  WSSyncHistoryPayload, 
  WSSyncInvitePayload,
  WSSyncRequestPayload} from '@/types/websocket';

// ==================== Types ====================

/**
 * PreKeyBundle fetch function type
 * Returns PreKeyBundle for a specific device of the same user
 */
type FetchPreKeyBundleFn = (userId: string, deviceId: number) => Promise<PreKeyBundle | null>;

export interface P2PSyncConfig {
  send: (type: string, payload: unknown) => Promise<void>;
  deviceId: string;
  userId: string;
  getSignalDeviceId: () => number | null;
  /** 
   * Function to fetch PreKeyBundle for another device of the same user.
   * This is needed to establish Signal Protocol sessions between devices.
   */
  fetchPreKeyBundle?: FetchPreKeyBundleFn;
}

export interface SyncStatus {
  isSyncing: boolean;
  lastSyncAt: number | null;
  error: string | null;
  vectorClock: VectorClock;
  // Two-phase sync fields
  invitePhase: 'idle' | 'inviting' | 'waiting' | 'accepted' | 'rejected' | 'timeout' | 'no_devices';
  inviteError?: string;
  // Progress tracking
  transferProgress: { current: number; total: number } | null;
  transferPhase: 'idle' | 'preparing' | 'sending' | 'receiving' | 'done' | 'error';
  // Donor device info (for UI)
  donorDeviceId?: string;
  donorDeviceName?: string;
}

export interface HistoryData {
  messages: StoredMessage[];
  contacts: ContactRecord[];        // Address book for P2P sync
  vectorClock: VectorClock;
}

// ==================== Constants ====================

const VECTOR_CLOCK_KEY = 'p2p_vector_clock';
const INVITE_SENT_KEY = 'p2p_invite_sent';
const INVITE_TIMEOUT_MS = 30000; // 30 seconds
const INVITE_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

// ==================== Helper Functions ====================

/**
 * Convert string to Uint8Array
 */
function stringToUint8Array(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

/**
 * Convert Uint8Array to string
 */
function uint8ArrayToString(arr: Uint8Array): string {
  return new TextDecoder().decode(arr);
}

// ==================== P2PSyncManager Class ====================

export class P2PSyncManager {
  private send: (type: string, payload: unknown) => Promise<void>;
  private deviceId: string;
  private userId: string;
  private getSignalDeviceId: () => number | null;
  private fetchPreKeyBundle?: FetchPreKeyBundleFn;
  
  private syncStatus: SyncStatus = {
    isSyncing: false,
    lastSyncAt: null,
    error: null,
    vectorClock: {},
    invitePhase: 'idle',
    transferProgress: null,
    transferPhase: 'idle',
  };
  
  private statusListeners = new Set<(status: SyncStatus) => void>();
  
  // Two-phase sync state
  private inviteTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private acceptedDeviceId: string | null = null;
  private deviceName: string | null = null;

  constructor(config: P2PSyncConfig) {
    this.send = config.send;
    this.deviceId = config.deviceId;
    this.userId = config.userId;
    this.getSignalDeviceId = config.getSignalDeviceId;
    this.fetchPreKeyBundle = config.fetchPreKeyBundle;
  }

  // ==================== Public Methods ====================

  /**
   * Get current sync status
   */
  getStatus(): SyncStatus {
    return { ...this.syncStatus };
  }

  /**
   * Subscribe to sync status changes
   */
  subscribeToStatus(callback: (status: SyncStatus) => void): () => void {
    this.statusListeners.add(callback);
    return () => this.statusListeners.delete(callback);
  }

  /**
   * Get current vector clock from localStorage
   */
  getVectorClock(): VectorClock {
    try {
      const saved = localStorage.getItem(VECTOR_CLOCK_KEY);
      if (saved) {
        return JSON.parse(saved);
      }
    } catch (error) {
      console.error('[P2PSync] Failed to load vector clock:', error);
    }
    return {};
  }

  /**
   * Save vector clock to localStorage
   */
  private saveVectorClock(vc: VectorClock): void {
    try {
      localStorage.setItem(VECTOR_CLOCK_KEY, JSON.stringify(vc));
    } catch (error) {
      console.error('[P2PSync] Failed to save vector clock:', error);
    }
  }

  /**
   * Increment vector clock for this device
   */
  private incrementVectorClock(): VectorClock {
    const vc = this.getVectorClock();
    vc[this.deviceId] = (vc[this.deviceId] || 0) + 1;
    this.saveVectorClock(vc);
    return vc;
  }

  /**
   * Merge vector clocks (take max for each device)
   */
  private mergeVectorClocks(vc1: VectorClock, vc2: VectorClock): VectorClock {
    const merged: VectorClock = { ...vc1 };
    for (const [deviceId, seq] of Object.entries(vc2)) {
      merged[deviceId] = Math.max(merged[deviceId] || 0, seq);
    }
    return merged;
  }

  /**
   * Request history from other devices
   * Called when a new device comes online
   */
  async requestHistory(): Promise<void> {
    this.updateStatus({ isSyncing: true, error: null });
    
    try {
      const payload: WSSyncRequestPayload = {
        requestingDeviceId: this.deviceId,
        vectorClock: this.getVectorClock(),
      };
      
      await this.send('sync_request', payload);
    } catch (error) {
      console.error('[P2PSync] Failed to request history:', error);
      this.updateStatus({ 
        isSyncing: false, 
        error: error instanceof Error ? error.message : 'Failed to request history' 
      });
      throw error;
    }
  }

   /**
    * Prepare and encrypt history for a requesting device
    * Called when receiving a sync_request from another device
    * 
    * @param requestingDeviceId - UUID of the requesting device
    * @param requestingSignalDeviceId - Signal Protocol device ID (1-127) for encryption
    */
   async prepareHistory(requestingDeviceId: string, requestingSignalDeviceId?: number): Promise<WSSyncHistoryPayload> {
     try {
       // Collect history from IndexedDB
       const historyData = await this.collectHistory();
       
        // Serialize history to JSON (including contacts)
        const historyJson = JSON.stringify({
          messages: historyData.messages,
          contacts: historyData.contacts,
          vectorClock: historyData.vectorClock,
        });
       
       // Encrypt history using Signal Protocol
       // We encrypt to ourselves (same user, different device)
       const historyBytes = stringToUint8Array(historyJson);
       
       // Use Signal Protocol to encrypt for the requesting device
       // The requesting device is the same user, so we encrypt to our own other device
       const encrypted = await this.encryptHistoryForDevice(historyBytes, requestingSignalDeviceId);
       
       const payload: WSSyncHistoryPayload = {
         targetDeviceId: requestingDeviceId,
         senderDeviceId: this.deviceId,
         senderSignalDeviceId: this.getSignalDeviceId() || undefined,
         encryptedHistory: uint8ArrayToBase64(encrypted),
         vectorClock: this.incrementVectorClock(),
       };
       
       return payload;
     } catch (error) {
       console.error('[P2PSync] Failed to prepare history:', error);
       throw error;
     }
   }

  /**
   * Send prepared history to a requesting device
   */
  async sendHistory(payload: WSSyncHistoryPayload): Promise<void> {
    await this.send('sync_history', payload);
  }

   /**
    * Apply received history to local storage
    * Called when receiving sync_history from another device
    */
   async applyHistory(payload: WSSyncHistoryPayload): Promise<void> {
     this.updateStatus({ isSyncing: true, error: null });
     
     try {
       // Decrypt history
       const encryptedBytes = base64ToUint8Array(payload.encryptedHistory);
       const decryptedBytes = await this.decryptHistoryFromDevice(encryptedBytes, payload.senderSignalDeviceId);
       const historyJson = uint8ArrayToString(decryptedBytes);
       
       // Parse history
       const history: HistoryData = JSON.parse(historyJson);
       
        // Apply messages to IndexedDB
        await initMessagesDB();
        if (history.messages.length > 0) {
          await storeMessages(history.messages);
        }
        
        // Apply contacts to IndexedDB (P2P sync for address book only)
        if (history.contacts && history.contacts.length > 0) {
          try {
            await storeContacts(history.contacts);
          } catch (contactError) {
            console.error('[P2PSync] Failed to store contacts, but continuing:', contactError);
            // Don't throw - contacts sync should not block message sync
          }
        }
        // Note: user_cache is NOT synchronized (local only)
       
       // Merge vector clocks
       const mergedVC = this.mergeVectorClocks(this.getVectorClock(), payload.vectorClock);
       mergedVC[this.deviceId] = (mergedVC[this.deviceId] || 0) + 1;
       this.saveVectorClock(mergedVC);
       
       // Send acknowledgment
       await this.sendAck(mergedVC);
       
       this.updateStatus({
         isSyncing: false,
         lastSyncAt: Date.now(),
         vectorClock: mergedVC
       });
       
     } catch (error) {
       console.error('[P2PSync] Failed to apply history:', error);
       this.updateStatus({ 
         isSyncing: false, 
         error: error instanceof Error ? error.message : 'Failed to apply history' 
       });
       throw error;
     }
   }

  /**
   * Send acknowledgment after applying history
   */
  async sendAck(vectorClock: VectorClock): Promise<void> {
    const payload: WSSyncAckPayload = {
      deviceId: this.deviceId,
      newVectorClock: vectorClock,
    };
    
    await this.send('sync_ack', payload);
  }

  // ==================== Private Methods ====================

  /**
   * Update sync status and notify listeners
   */
  private updateStatus(updates: Partial<SyncStatus>): void {
    this.syncStatus = { ...this.syncStatus, ...updates };
    this.statusListeners.forEach(callback => callback(this.syncStatus));
  }

    /**
     * Collect history from IndexedDB for synchronization
     */
    private async collectHistory(): Promise<HistoryData> {
      await initMessagesDB();
      
      // Get all messages from IndexedDB
      const allMessages = await getAllMessages();
      
      // Get all contacts from IndexedDB (for P2P sync)
      const allContacts = await getAllContacts();
      
      return {
        messages: allMessages,
        contacts: allContacts,
        vectorClock: this.getVectorClock(),
      };
    }

  /**
   * Ensure Signal Protocol session exists with another device
   * Per Sesame spec, devices of the same user establish sessions via X3DH/PQXDH
   * 
   * @param targetDeviceId - Signal device ID (1-127) of the other device
   */
  private async ensureSessionWithDevice(targetDeviceId: number): Promise<void> {
    if (!isSignalInitialized()) {
      throw new Error('[P2PSync] Signal Protocol not initialized');
    }

    const currentUserId = getCurrentUserId();
    if (!currentUserId) {
      throw new Error('[P2PSync] Current user ID not available');
    }

    // Check if session already exists
    const sessionExists = await hasSession(currentUserId, targetDeviceId);
    if (sessionExists) {
      return;
    }

    // Fetch PreKeyBundle for the target device
    if (!this.fetchPreKeyBundle) {
      throw new Error('[P2PSync] fetchPreKeyBundle not configured - cannot establish session');
    }

    const bundle = await this.fetchPreKeyBundle(currentUserId, targetDeviceId);
    if (!bundle) {
      throw new Error(`[P2PSync] Could not fetch PreKeyBundle for device ${targetDeviceId}`);
    }

    // Process the PreKeyBundle to establish session
    await processPreKeyBundle(currentUserId, targetDeviceId, bundle);
  }

  /**
   * Encrypt history for a specific device using Signal Protocol
   * 
   * Per Sesame spec section 3.3, messages to other devices of the same user
   * are encrypted using Signal Protocol sessions. This provides:
   * - Forward secrecy via Double Ratchet
   * - Authentication via identity keys
   * - Post-quantum security via PQXDH
   * 
   * @param data - History data to encrypt
   * @param targetSignalDeviceId - Signal device ID (1-127) of the receiving device
   */
  private async encryptHistoryForDevice(
    data: Uint8Array, 
    targetSignalDeviceId?: number
  ): Promise<Uint8Array> {
    if (!isSignalInitialized()) {
      throw new Error('[P2PSync] Signal Protocol not initialized');
    }

    const currentUserId = getCurrentUserId();
    if (!currentUserId) {
      throw new Error('[P2PSync] Current user ID not available');
    }

    // Validate Signal device ID
    if (targetSignalDeviceId === undefined || targetSignalDeviceId === null) {
      throw new Error('[P2PSync] Signal device ID is required for encryption');
    }

    // Ensure session exists with the target device
    await this.ensureSessionWithDevice(targetSignalDeviceId);

    // Encrypt using Signal Protocol
    // The recipient is the same user (userId), but different device
    const encrypted = await encryptMessage(currentUserId, targetSignalDeviceId, data);
    
    // Return the encrypted body with message type prefix
    // Format: [1 byte message type] + [encrypted body]
    const result = new Uint8Array(1 + encrypted.body.length);
    result[0] = encrypted.type;
    result.set(encrypted.body, 1);
    
    return result;
  }

  /**
   * Decrypt history from a device using Signal Protocol
   * 
   * @param data - Encrypted history data (format: [1 byte type] + [encrypted body])
   * @param senderSignalDeviceId - Signal device ID of the sending device
   */
  private async decryptHistoryFromDevice(
    data: Uint8Array,
    senderSignalDeviceId?: number
  ): Promise<Uint8Array> {
    if (!isSignalInitialized()) {
      throw new Error('[P2PSync] Signal Protocol not initialized');
    }

    const currentUserId = getCurrentUserId();
    if (!currentUserId) {
      throw new Error('[P2PSync] Current user ID not available');
    }

    // Validate Signal device ID
    if (senderSignalDeviceId === undefined || senderSignalDeviceId === null) {
      throw new Error('[P2PSync] Signal device ID is required for decryption');
    }

    // Extract message type and body
    if (data.length < 2) {
      throw new Error('[P2PSync] Encrypted data too short');
    }
    
    const messageType = data[0];
    const encryptedBody = data.slice(1);

    // Decrypt using Signal Protocol
    const decrypted = await decryptMessage(
      currentUserId,
      senderSignalDeviceId,
      encryptedBody,
      messageType
    );
    
    return decrypted.body;
  }

  // ==================== Two-Phase Sync Methods ====================

  /**
   * Set device name for sync invites
   */
  setDeviceName(name: string): void {
    this.deviceName = name;
  }

  /**
   * Send sync invite to all other devices
   * Called by new device to request history
   */
  async sendInvite(): Promise<void> {
    // Check cooldown to prevent spam
    const lastInvite = localStorage.getItem(INVITE_SENT_KEY);
    if (lastInvite) {
      const lastInviteTime = parseInt(lastInvite, 10);
      const elapsed = Date.now() - lastInviteTime;
      if (elapsed < INVITE_COOLDOWN_MS) {
        this.updateStatus({
          invitePhase: 'timeout',
          inviteError: 'Please wait before sending another invite'
        });
        return;
      }
    }
    
    // Clear any previous state
    this.clearInviteTimeout();
    this.acceptedDeviceId = null;
    
    this.updateStatus({
      isSyncing: true,
      invitePhase: 'inviting',
      error: null
    });
    
    try {
      const payload: WSSyncInvitePayload = {
        invitingDeviceId: this.deviceId,
        invitingDeviceName: this.deviceName || undefined,
        timestamp: Date.now()
      };
      
      await this.send('sync_invite', payload);
      
      // Store invite timestamp
      localStorage.setItem(INVITE_SENT_KEY, Date.now().toString());
      
      // Start timeout
      this.startInviteTimeout();
      
      this.updateStatus({ invitePhase: 'waiting' });
      
    } catch (error) {
      console.error('[P2PSync] Failed to send sync invite:', error);
      this.updateStatus({
        isSyncing: false,
        invitePhase: 'timeout',
        inviteError: error instanceof Error ? error.message : 'Failed to send invite'
      });
      throw error;
    }
  }

  /**
   * Handle sync accept from a donor device
   * Called when another device accepts the sync request
   */
  async handleSyncAccept(payload: WSSyncAcceptPayload): Promise<void> {
    // Clear timeout
    this.clearInviteTimeout();
    
    // Check if we already have an accept (race condition)
    if (this.acceptedDeviceId && this.acceptedDeviceId !== payload.acceptingDeviceId) {
      return;
    }
    
    this.acceptedDeviceId = payload.acceptingDeviceId;
    
    this.updateStatus({
      invitePhase: 'accepted',
      donorDeviceId: payload.acceptingDeviceId,
      donorDeviceName: (payload as any).acceptingDeviceName || 'Device',
      transferPhase: 'preparing'
    });
    
    // Now send sync_request to the accepting device
    try {
      await this.requestHistoryFromDevice(payload.acceptingDeviceId);
    } catch (error) {
      console.error('[P2PSync] Failed to request history from donor:', error);
      this.updateStatus({
        isSyncing: false,
        transferPhase: 'error',
        error: error instanceof Error ? error.message : 'Failed to request history'
      });
    }
  }

  /**
   * Handle sync cancel
   * Called when another device accepted or timeout occurred
   */
  handleSyncCancel(payload: WSSyncCancelPayload): void {
    // Clear timeout
    this.clearInviteTimeout();
    
    if (payload.reason === 'accepted' && payload.acceptedByDeviceId !== this.acceptedDeviceId) {
      // Another device accepted, we should stop waiting
      this.updateStatus({
        isSyncing: false,
        invitePhase: 'timeout',
        inviteError: 'Another device is already sending history'
      });
    } else if (payload.reason === 'no_devices') {
      this.updateStatus({
        isSyncing: false,
        invitePhase: 'no_devices',
        inviteError: 'No other devices available for sync'
      });
    } else if (payload.reason === 'timeout') {
      this.updateStatus({
        isSyncing: false,
        invitePhase: 'timeout',
        inviteError: 'Sync request timed out'
      });
    } else if (payload.reason === 'rejected') {
      this.updateStatus({
        isSyncing: false,
        invitePhase: 'rejected',
        inviteError: 'Sync request was rejected'
      });
    }
  }

  /**
   * Request history from a specific device (after accept)
   */
  private async requestHistoryFromDevice(donorDeviceId: string): Promise<void> {
    const payload: WSSyncRequestPayload = {
      requestingDeviceId: this.deviceId,
      vectorClock: this.getVectorClock(),
    };
    
    // Include target device ID for direct routing
    await this.send('sync_request', {
      ...payload,
      targetDeviceId: donorDeviceId
    });
    
    this.updateStatus({ transferPhase: 'receiving' });
  }

  /**
   * Start invite timeout
   */
  private startInviteTimeout(): void {
    this.inviteTimeoutId = setTimeout(() => {
      this.updateStatus({
        isSyncing: false,
        invitePhase: 'timeout',
        inviteError: 'No devices responded within 30 seconds'
      });
    }, INVITE_TIMEOUT_MS);
  }

  /**
   * Clear invite timeout
   */
  private clearInviteTimeout(): void {
    if (this.inviteTimeoutId) {
      clearTimeout(this.inviteTimeoutId);
      this.inviteTimeoutId = null;
    }
  }

  /**
   * Check if this device needs sync (empty vector clock)
   */
  needsSync(): boolean {
    const vc = this.getVectorClock();
    return Object.keys(vc).length === 0;
  }

  /**
   * Reset sync state
   */
  resetSyncState(): void {
    this.clearInviteTimeout();
    this.acceptedDeviceId = null;
    this.updateStatus({
      isSyncing: false,
      invitePhase: 'idle',
      transferPhase: 'idle',
      transferProgress: null,
      error: null,
      donorDeviceId: undefined,
      donorDeviceName: undefined
    });
  }

  /**
   * Update transfer progress
   */
  updateTransferProgress(current: number, total: number): void {
    this.updateStatus({
      transferProgress: { current, total }
    });
  }

  /**
   * Mark transfer as complete
   */
  markTransferComplete(): void {
    this.updateStatus({
      isSyncing: false,
      transferPhase: 'done',
      transferProgress: null
    });
  }
}

// ==================== Factory Function ====================

/**
 * Create a P2P Sync Manager instance
 */
export function createP2PSyncManager(config: P2PSyncConfig): P2PSyncManager {
  return new P2PSyncManager(config);
}

export default P2PSyncManager;
