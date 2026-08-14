/**
 * Shared Worker WebSocket Client
 * 
 * Client for connecting to the Shared Worker from browser tabs.
 * Provides a transparent interface similar to direct WebSocket connection.
 */

import type { WSAttachment } from '@/types/websocket';
import type {
  ConnectionState,
  WorkerClientMessage,
  WorkerServerMessage,
} from '@/workers/websocket.worker';

import { type EventCallback,EventEmitter } from './event-emitter';

export type { ConnectionState, WorkerClientMessage, WorkerServerMessage };

/**
 * Default connection state
 */
const DEFAULT_STATE: ConnectionState = {
  isConnected: false,
  isConnecting: false,
  lastError: null,
  reconnectAttempts: 0,
  deviceId: null,
};

/**
 * Shared Worker WebSocket Client
 * 
 * Uses SharedWorker for a single WebSocket connection shared across all tabs.
 * Falls back to direct WebSocket if SharedWorker is not available.
 */
export class WorkerWebSocketClient extends EventEmitter {
  private worker: SharedWorker | null = null;
  private port: MessagePort | null = null;
  private tabId: string | null = null;
  private state: ConnectionState = { ...DEFAULT_STATE };
  private stateListeners = new Set<(state: ConnectionState) => void>();
  private destroyed = false;
  private activeSubscriptions = new Map<string, number>();
  // Store last connection params for reconnect
  private lastUrl: string | null = null;
  private lastToken: string | null = null;
  // Pending subscriptions to send when port becomes available
  private pendingSubscriptions = new Set<string>();

  constructor() {
    super();
  }

  // ==================== State Management ====================

  getState(): ConnectionState {
    return { ...this.state };
  }

  subscribeToState(listener: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    // Immediately call with current state
    listener(this.state);
    return () => this.stateListeners.delete(listener);
  }

  private updateState(updates: Partial<ConnectionState>): void {
    this.state = { ...this.state, ...updates };
    this.stateListeners.forEach((listener) => listener(this.state));
  }

  // ==================== Connection Management ====================

  /**
   * Connect to Shared Worker and establish WebSocket connection
   */
  connect(url: string, token: string): void {
    if (this.destroyed) {
      return;
    }

    // Store connection params for potential reconnect
    this.lastUrl = url;
    this.lastToken = token;

    // If worker exists but WebSocket is not connected, send connect command
    if (this.worker && this.port) {
      if (this.state.isConnected) {
        return;
      }
      // Worker exists but WebSocket not connected - send connect command
      this.sendToWorker({
        type: 'connect',
        payload: { token, url },
      });
      return;
    }

    // Check SharedWorker support
    if (typeof SharedWorker === 'undefined') {
      this.emit('error', new Error('SharedWorker not supported'));
      return;
    }

    try {
      // Create Shared Worker
      this.worker = new SharedWorker(
        new URL('@/workers/websocket.worker.ts', import.meta.url),
        { type: 'module', name: 'zerochat-ws' }
      );

      this.port = this.worker.port;
      this.port.start();

      // Track if we've received the initial connected message
      let receivedTabId = false;

      // Handle messages from worker
      this.port.onmessage = (event: MessageEvent) => {
        const message = event.data as WorkerServerMessage;
        
        // Handle initial tab ID assignment
        if (message.type === 'connected' && !receivedTabId) {
          receivedTabId = true;
          this.tabId = message.payload.tabId;

          // Send any pending subscriptions now that port is available
          this.sendPendingSubscriptions();

          // Now send connect command with stored params
          this.sendToWorker({
            type: 'connect',
            payload: { token: this.lastToken!, url: this.lastUrl! },
          });
          return;
        }
        
        this.handleWorkerMessage(message);
      };

      this.port.onmessageerror = (event: MessageEvent) => {
        console.error('[WorkerClient] Message error:', event);
        this.emit('error', new Error('Worker message error'));
      };

    } catch (error) {
      console.error('[WorkerClient] Failed to create worker:', error);
      this.emit('error', error);
    }
  }

  /**
   * Disconnect from Shared Worker
   */
  disconnect(): void {
    if (!this.worker) return;

    this.sendToWorker({ type: 'disconnect' });

    this.port?.close();
    this.worker = null;
    this.port = null;
    this.tabId = null;
    this.lastUrl = null;
    this.lastToken = null;
    this.updateState({ ...DEFAULT_STATE });
  }

  /**
   * Шаг 5 lifecycle: push a fresh token to the worker without doing a full
   * reconnect. Called by WebSocketContext when TokenRefreshManager reports
   * a new JWT. The worker will use this token on its next reconnect attempt.
   * If the WS is currently dead, the worker will reconnect immediately.
   *
   * If the port is not yet available (no prior connect() succeeded), this
   * is a no-op: the caller is expected to invoke connect() with the fresh
   * token once auth+signal are ready.
   */
  updateToken(token: string): void {
    if (!this.port) {
      // No active worker connection — nothing to push to. The next
      // connect(url, token) call carries the fresh token explicitly.
      return;
    }
    this.sendToWorker({ type: 'update-token', payload: { token } });
  }

  /**
   * Destroy the client completely
   */
  destroy(): void {
    this.destroyed = true;
    this.disconnect();
    this.removeAllListeners();
    this.stateListeners.clear();
  }

    // ==================== Messaging ====================

   /**
    * Send a message through WebSocket
    */
   send(type: string, data: unknown): void {
    if (!this.port) {
      console.error('[WorkerClient] Not connected to worker');
      return;
    }

    this.sendToWorker({
      type: 'send',
      payload: { type, data },
    });
  }

   /**
    * Subscribe to specific event types from WebSocket
    * DEPRECATED: Use subscribeToEvent(type, handler) instead
    */
   subscribe(eventTypes: string[]): () => void {
     if (!this.port) {
       console.error('[WorkerClient] Not connected to worker');
       return () => {};
     }

     this.sendToWorker({
       type: 'subscribe',
       payload: { eventTypes },
     });

     return () => {
       this.sendToWorker({
         type: 'unsubscribe',
         payload: { eventTypes },
       });
     };
   }

   /**
    * Subscribe to a specific event type with handler
    * Implements WebSocketClientInterface.subscribe
    */
   subscribeToEvent(type: string, handler: EventCallback): () => void {
     // Register local handler via EventEmitter
     this.on(type, handler);

     // Subscribe to this event type in the worker
     if (this.port) {
       this.sendToWorker({
         type: 'subscribe',
         payload: { eventTypes: [type] },
       });
     }

     // Return unsubscribe function
     return () => {
       this.off(type, handler);
       if (this.port) {
         this.sendToWorker({
           type: 'unsubscribe',
           payload: { eventTypes: [type] },
         });
       }
     };
   }

  /**
   * Set device ID for this connection
   */
  setDeviceId(deviceId: string): void {
    this.sendToWorker({
      type: 'set-device-id',
      payload: { deviceId },
    });
  }

  // ==================== Convenience Methods ====================

  /**
   * Send a message (compatible with WebSocketConnection.sendMessage)
   */
  sendMessage(m: { type: string; payload: unknown }): Promise<void> {
    this.send(m.type, m.payload);
    return Promise.resolve();
  }

  /**
   * Send typing indicator
   */
  sendTyping(chatId: string, isTyping: boolean): void {
    this.send('typing', { chatId, isTyping });
  }

  /**
   * Send mark read
   */
  sendMarkRead(chatId: string, messageIds?: string[]): void {
    this.send('mark_read', { chatId, messageIds });
  }

  /**
   * Send presence status
   */
  sendPresence(status: 'online' | 'offline'): void {
    this.send('presence', { status });
  }

   /**
    * Send multi-device message
    */
    sendMultiDeviceMessage(
      chatId: string,
      recipientId: string,
      recipientMessages: { deviceId: number; content: string; messageType: number }[],
      senderMessages?: { deviceId: number; content: string; messageType: number }[],
      attachments?: WSAttachment[],
      replyTo?: string,
      metadata?: Record<string, any>
    ): Promise<string> {
     const messageId = `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
     this.send('multi_message', {
       chatId,
       recipientId,
       recipientMessages,
       senderMessages,
       attachments,
       replyTo,
       metadata,
       messageId,
     });
     return Promise.resolve(messageId);
   }

  /**
   * Send group message (Sender Key)
   */
   sendGroupMessage(
     chatId: string,
     senderUserId: string,
     senderDeviceId: string,
     content: string,
     messageId?: string,
     senderKeyId?: string,
     replyTo?: string,
     attachments?: WSAttachment[],
     senderKeyDistribution?: string,
     metadata?: Record<string, any>
   ): Promise<string> {
    const msgId = messageId || `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    this.send('group_message', {
      chatId,
      senderUserId,
      senderDeviceId,
      content,
      messageId: msgId,
      senderKeyId,
      replyTo,
      attachments,
      senderKeyDistribution,
      metadata,
    });
    return Promise.resolve(msgId);
  }

  /**
   * Send session sync request
   */
  sendSessionSync(
    userId: string,
    deviceId: number,
    reason: 'session_refresh' | 'new_device' | 'retry_request'
  ): void {
    this.send('session_sync', { userId, deviceId, reason });
  }

  /**
   * Send message retry request
   */
  sendMessageRetryRequest(
    originalMessageId: string,
    chatId: string,
    senderId: string,
    senderDeviceId: number
  ): void {
    this.send('message_retry', {
      originalMessageId,
      chatId,
      senderId,
      senderDeviceId,
    });
  }

  // ==================== Event Handlers ====================

  /**
   * Subscribe to connection state changes
   */
  onStatus(callback: (state: ConnectionState) => void): () => void {
    return this.subscribeToState(callback);
  }

  /**
   * Subscribe to messages
   */
  onMessage(callback: (data: unknown) => void): () => void {
    return this.on('message', callback as EventCallback);
  }

  /**
   * Subscribe to errors
   */
  onError(callback: (error: Error) => void): () => void {
    return this.on('error', callback as EventCallback);
  }

  /**
   * Subscribe to disconnect events
   */
  onDisconnected(callback: (reason?: string) => void): () => void {
    return this.on('disconnected', callback as EventCallback);
  }

  /**
   * Subscribe to reconnecting events
   */
  onReconnecting(callback: (attempt: number, delay: number) => void): () => void {
    return this.on('reconnecting', callback as EventCallback);
  }

  // ==================== WebSocketConnection-compatible Event Handlers ====================

  /**
   * Generic event subscription (compatible with WebSocketConnection)
   * Automatically subscribes to events in SharedWorker
   */
  on<T = unknown>(event: string, callback: (data: T) => void): () => void {
    // Subscribe in SharedWorker if this is the first listener for this event
    const count = this.activeSubscriptions.get(event) || 0;
    if (count === 0) {
      if (this.port) {
        this.sendToWorker({
          type: 'subscribe',
          payload: { eventTypes: [event] },
        });
      } else {
        // Queue subscription for when port becomes available
        this.pendingSubscriptions.add(event);
      }
    }
    this.activeSubscriptions.set(event, count + 1);

    // Add local listener
    const unsub = super.on(event, callback as EventCallback);

    // Return wrapped unsubscribe that also updates SharedWorker
    return () => {
      unsub();
      const newCount = (this.activeSubscriptions.get(event) || 1) - 1;
      if (newCount === 0) {
        this.activeSubscriptions.delete(event);
        this.pendingSubscriptions.delete(event);
        if (this.port) {
          this.sendToWorker({
            type: 'unsubscribe',
            payload: { eventTypes: [event] },
          });
        }
      } else {
        this.activeSubscriptions.set(event, newCount);
      }
    };
  }

  /**
   * Send all pending subscriptions to the worker
   */
  private sendPendingSubscriptions(): void {
    if (this.pendingSubscriptions.size === 0 || !this.port) return;
    
    const eventTypes = Array.from(this.pendingSubscriptions);
    
    this.sendToWorker({
      type: 'subscribe',
      payload: { eventTypes },
    });
    
    this.pendingSubscriptions.clear();
  }

  /**
   * Subscribe to NEW_MESSAGE events
   */
  onNewMessage(callback: (data: unknown) => void): () => void {
    return this.on('NEW_MESSAGE', callback);
  }

  /**
   * Subscribe to MESSAGE_DELIVERED events
   */
  onMessageDelivered(callback: (data: unknown) => void): () => void {
    return this.on('MESSAGE_DELIVERED', callback);
  }

  /**
   * Subscribe to MESSAGE_READ events
   */
  onMessageRead(callback: (data: unknown) => void): () => void {
    return this.on('MESSAGE_READ', callback);
  }

  /**
   * Subscribe to USER_ONLINE events
   */
  onUserOnline(callback: (data: { userId: string }) => void): () => void {
    return this.on('USER_ONLINE', (data: { type: string; payload: { userId: string } }) => {
      callback(data.payload);
    });
  }

  /**
   * Subscribe to USER_OFFLINE events
   */
  onUserOffline(callback: (data: { userId: string }) => void): () => void {
    return this.on('USER_OFFLINE', (data: { type: string; payload: { userId: string } }) => {
      callback(data.payload);
    });
  }

  /**
   * Subscribe to SESSION_SYNC events
   */
  onSessionSync(callback: (data: { userId: string; deviceId: number; reason: string }) => void): () => void {
    return this.on('SESSION_SYNC', (data: { type: string; payload: { userId: string; deviceId: number; reason: string } }) => {
      callback(data.payload);
    });
  }

  /**
   * Subscribe to MESSAGE_RETRY events
   */
  onMessageRetry(callback: (data: { originalMessageId: string; chatId: string; senderId: string; senderDeviceId: number }) => void): () => void {
    return this.on('MESSAGE_RETRY', (data: { type: string; payload: { originalMessageId: string; chatId: string; senderId: string; senderDeviceId: number } }) => {
      callback(data.payload);
    });
  }

  /**
   * Subscribe to read events
   */
  onReadEvent(callback: (data: unknown) => void): () => void {
    return this.on('read', callback);
  }

  /**
   * Subscribe to read_ack events
   */
  onReadAck(callback: (data: unknown) => void): () => void {
    return this.on('read_ack', callback);
  }

  /**
   * Subscribe to presence events
   */
  onPresence(callback: (data: { userId: string; status: 'online' | 'offline'; lastSeen?: string }) => void): () => void {
    return this.on('presence', callback);
  }

  /**
   * Subscribe to typing events
   */
  onTyping(callback: (data: { userId: string; chatId: string }) => void): () => void {
    return this.on('typing', callback);
  }

  /**
   * Subscribe to sync_request events
   */
  onSyncRequest(callback: (data: { requestingDeviceId: string; requestingSignalDeviceId?: number; targetDeviceId?: string; vectorClock: Record<string, number> }) => void): () => void {
    return this.on('sync_request', callback);
  }

  /**
   * Subscribe to sync_history events
   */
  onSyncHistory(callback: (data: { targetDeviceId: string; senderDeviceId: string; senderSignalDeviceId?: number; encryptedHistory: string; vectorClock: Record<string, number> }) => void): () => void {
    return this.on('sync_history', callback);
  }

  /**
   * Subscribe to sync_ack events
   */
  onSyncAck(callback: (data: { deviceId: string; newVectorClock: Record<string, number> }) => void): () => void {
    return this.on('sync_ack', callback);
  }

  /**
   * Subscribe to device_online events
   */
  onDeviceOnline(callback: (data: { userId: string; deviceId: string; signalDeviceId: number; deviceName?: string }) => void): () => void {
    return this.on('device_online', callback);
  }

  // ==================== Two-Phase Sync Event Handlers ====================

  /**
   * Subscribe to sync_invite events
   */
  onSyncInvite(callback: (data: { invitingDeviceId: string; invitingDeviceName?: string; timestamp: number }) => void): () => void {
    return this.on('sync_invite', callback);
  }

  /**
   * Subscribe to sync_accept events
   */
  onSyncAccept(callback: (data: { acceptingDeviceId: string; targetDeviceId: string; timestamp: number }) => void): () => void {
    return this.on('sync_accept', callback);
  }

  /**
   * Subscribe to sync_cancel events
   */
  onSyncCancel(callback: (data: { invitingDeviceId: string; acceptedByDeviceId: string; reason?: string }) => void): () => void {
    return this.on('sync_cancel', callback);
  }

  /**
   * Subscribe to sync_reject events
   */
  onSyncReject(callback: (data: { rejectingDeviceId: string; targetDeviceId: string; timestamp: number }) => void): () => void {
    return this.on('sync_reject', callback);
  }

  /**
   * Subscribe to signal_not_ready events
   */
  onSignalNotReady(callback: (error: Error) => void): () => void {
    return this.on('signal_not_ready', callback);
  }

  /**
   * Subscribe to connected events
   */
  onConnected(callback: () => void): () => void {
    return this.on('connected', callback);
  }

  // ==================== Internal Methods ====================

  private sendToWorker(message: WorkerClientMessage): void {
    if (this.port) {
      this.port.postMessage(message);
    }
  }

  private handleWorkerMessage(message: WorkerServerMessage): void {
    switch (message.type) {
      case 'connected':
        this.tabId = message.payload.tabId;
        this.emit('connected', {});
        break;

      case 'state':
        this.updateState(message.payload);
        break;

      case 'message':
        const serverMessage = message.payload as unknown as { type: string; payload: unknown; timestamp?: number };
        this.emit('message', serverMessage);
        if (serverMessage.type) {
          // События, которые должны получать full message (не обёрнуты в connection.ts)
          const fullMessageEvents = [
            'NEW_MESSAGE', 'MESSAGE_DELIVERED', 'MESSAGE_READ',
            'USER_ONLINE', 'USER_OFFLINE', 'SESSION_SYNC', 'MESSAGE_RETRY'
          ];
          // События, которые должны получать payload (обёрнуты или special)
          const payloadEvents = [
            'read', 'read_ack', 'typing', 'presence',
            'command_ack', 'command_event', 'command_error',
            'group_message', 'group_key_update', 'group_sync', 'group_message_ack',
            'sync_request', 'sync_history', 'sync_ack', 'device_online',
            'sync_invite', 'sync_accept', 'sync_cancel', 'sync_reject'
          ];
          
          if (fullMessageEvents.includes(serverMessage.type)) {
            this.emit(serverMessage.type, serverMessage);
          } else if (payloadEvents.includes(serverMessage.type)) {
            this.emit(serverMessage.type, serverMessage.payload);
          } else {
            // Для неизвестных событий по умолчанию payload (как в оригинальном worker)
            this.emit(serverMessage.type, serverMessage.payload);
          }
        }
        break;

      case 'disconnected':
        this.emit('disconnected', message.payload.reason);
        break;

      case 'error':
        this.emit('error', new Error(message.payload.message));
        break;

      case 'reconnecting':
        this.emit('reconnecting', message.payload.attempt, message.payload.delay);
        break;
    }
  }

  // ==================== Getters ====================

  getTabId(): string | null {
    return this.tabId;
  }

  get isConnected(): boolean {
    return this.state.isConnected;
  }

  get isConnecting(): boolean {
    return this.state.isConnecting;
  }
}

/**
 * Create a Shared Worker WebSocket client
 */
export function createWorkerClient(): WorkerWebSocketClient {
  return new WorkerWebSocketClient();
}
