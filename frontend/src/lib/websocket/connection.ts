/**
 * WebSocket Connection Manager
 * Handles low-level WebSocket connection with auto-reconnect and heartbeat
 */

import type { WSAttachment,WSMessage } from '@/types/websocket';

import { type EventCallback,EventEmitter } from './event-emitter';
import { HeartbeatManager } from './heartbeat';
import { MessageSender } from './message-sender';
import { type ReconnectConfig,ReconnectManager } from './reconnect';
import { 
  type ConnectionState, 
  DEFAULT_WS_CONFIG, 
  type PendingMessage,
  type WSConfig} from './types';

// Re-export types for backward compatibility
export type { ConnectionState, PendingMessage,WSConfig };
export { DEFAULT_WS_CONFIG };

/**
 * WebSocket Connection Manager Class
 */
export class WebSocketConnection {
  private ws: WebSocket | null = null;
  private config: WSConfig;
  private state: ConnectionState;
  private eventEmitter: EventEmitter;
  private reconnectManager: ReconnectManager;
  private messageSender: MessageSender;
  private heartbeatManager: HeartbeatManager;
  private explicitDisconnect = false;
  private stateListeners = new Set<(state: ConnectionState) => void>();
  /** RC-5 fix: Flag to prevent ReconnectManager from connecting during explicit connect() */
  private isExplicitConnecting = false;

  constructor(config: Partial<WSConfig> = {}) {
    this.config = { ...DEFAULT_WS_CONFIG, ...config };
    this.state = {
      isConnected: false,
      isConnecting: false,
      lastError: null,
      reconnectAttempts: 0,
    };
    this.eventEmitter = new EventEmitter();
    
    const reconnectConfig: Partial<ReconnectConfig> = {
      autoReconnect: this.config.autoReconnect,
      maxReconnectAttempts: this.config.maxReconnectAttempts,
      baseInterval: this.config.reconnectInterval,
    };
    this.reconnectManager = new ReconnectManager(reconnectConfig);
    // RC-3 fix: Use getToken callback if provided, with token refresh support
    // RC-5 fix: Check isExplicitConnecting to avoid conflict with explicit connect()
    this.reconnectManager.setReconnectCallback(async () => {
      // RC-5: Skip if explicit connection is in progress
      if (this.isExplicitConnecting) {
        return;
      }
      
      let freshToken: string;
      if (this.config.getToken) {
        // Use the provided callback which handles token refresh
        freshToken = await this.config.getToken();
      } else {
        // Fallback to direct localStorage access (may fail with expired token)
        freshToken = localStorage.getItem('access-token') || '';
      }
      await this.connect(this.config.url, freshToken);
    });

    this.messageSender = new MessageSender(
      this.eventEmitter,
      () => this.ws,
      () => this.state.isConnected
    );

    this.heartbeatManager = new HeartbeatManager(
      () => this.sendPing(),
      { interval: this.config.heartbeatInterval }
    );
  }

  // ==================== State Management ====================

  getState(): ConnectionState {
    return { ...this.state };
  }

  subscribeToState(listener: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  private updateState(updates: Partial<ConnectionState>): void {
    this.state = { ...this.state, ...updates };
    this.stateListeners.forEach(listener => listener(this.state));
  }

  // Getters for synchronous state access (RC-9 fix: avoid React state desync)
  get isConnected(): boolean {
    return this.state.isConnected;
  }

  get isConnecting(): boolean {
    return this.state.isConnecting;
  }

  // ==================== Connection Management ====================
  
  /** RC-7 fix: AbortController for cancelling connect() on disconnect() */
  private connectAbortController: AbortController | null = null;
  /** RC-7 fix: Timeout ID for cleanup */
  private connectTimeoutId: ReturnType<typeof setTimeout> | null = null;
  /** Pending resolve function for connect promise - called when handshake_ack received */
  private pendingConnectResolve: (() => void) | null = null;

  async connect(url?: string, token?: string): Promise<void> {
    // RC-5 fix: Block if explicit connection is already in progress
    if (this.isExplicitConnecting) {
      return;
    }

    // RC-6 fix: Also skip if already connected
    if (this.state.isConnected) {
      return;
    }
    
    this.isExplicitConnecting = true;
    
    // RC-7 fix: Create AbortController for this connection attempt
    this.connectAbortController = new AbortController();
    const { signal } = this.connectAbortController;
    
    if (url) this.config.url = url;
    if (token) this.config.token = token;

    // RC-6 fix: Close existing socket BEFORE creating new one
    if (this.ws) {
      const oldWs = this.ws;
      this.ws = null; // Clear reference first
      if (oldWs.readyState === WebSocket.OPEN || oldWs.readyState === WebSocket.CONNECTING) {
        oldWs.close(1000, 'Reconnecting');
      }
    }

    this.updateState({ isConnecting: true, lastError: null });
    this.reconnectManager.stop(); // Stop any pending reconnect attempts

    const authToken = this.config.token || localStorage.getItem('access-token') || '';

    const wsUrl = authToken ? `${this.config.url}?token=${authToken}` : this.config.url;

    return new Promise((resolve, reject) => {
      // Store resolve function to call after handshake_ack
      this.pendingConnectResolve = resolve;
      
      // RC-7 fix: Check if already aborted before creating socket
      if (signal.aborted) {
        this.isExplicitConnecting = false;
        this.pendingConnectResolve = null;
        reject(new Error('Connection aborted'));
        return;
      }
      
      try {
        this.ws = new WebSocket(wsUrl);

        // RC-7 fix: Store reference to this socket for abort cleanup
        const currentWs = this.ws;

        this.ws.onopen = () => {
          // RC-7 fix: Check if aborted during connection
          if (signal.aborted) {
            currentWs.close(1000, 'Aborted');
            return;
          }
          
          // RC-7 fix: Clear timeout on successful connection
          if (this.connectTimeoutId) {
            clearTimeout(this.connectTimeoutId);
            this.connectTimeoutId = null;
          }
          
          if (authToken) {
            // FIX: Wait for readyState to be OPEN
            const sendHandshake = () => {
              if (signal.aborted) {
                return;
              }
              if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({
                  type: 'handshake',
                  payload: { token: authToken },
                  timestamp: Date.now(),
                  messageId: this.messageSender.generateMessageId(),
                }));
                // Don't resolve here - wait for handshake_ack from server
              } else {
                // Retry after a short delay
                setTimeout(sendHandshake, 10);
              }
            };
            sendHandshake();
          } else {
            this.handleOpen();
            this.isExplicitConnecting = false;
            resolve();
          }
          
          // RC-7 fix: Reset flag ONLY after successful connection (handshake_ack received)
          // Note: resolve() is now called in handleOpen() after handshake_ack
        };

        this.ws.onmessage = (event) => this.handleMessage(event);
        this.ws.onclose = (event) => this.handleClose(event);
        this.ws.onerror = () => {
          // RC-7 fix: Reset flag on error
          this.isExplicitConnecting = false;
          this.pendingConnectResolve = null;
          this.handleError();
        };

        // RC-7 fix: Listen for abort signal
        signal.addEventListener('abort', () => {
          if (currentWs.readyState === WebSocket.CONNECTING || currentWs.readyState === WebSocket.OPEN) {
            currentWs.close(1000, 'Aborted');
          }
          if (this.connectTimeoutId) {
            clearTimeout(this.connectTimeoutId);
            this.connectTimeoutId = null;
          }
          this.isExplicitConnecting = false;
          reject(new Error('Connection aborted'));
        });

        // RC-7 fix: Store timeout ID for cleanup
        this.connectTimeoutId = setTimeout(() => {
          if (this.ws?.readyState !== WebSocket.OPEN) {
            this.isExplicitConnecting = false;
            reject(new Error('WebSocket connection timeout'));
          }
        }, 10000);
        
      } catch (error) {
        console.error('[WebSocket] Error creating socket:', error);
        this.isExplicitConnecting = false;
        reject(error);
      }
    });
  }

  disconnect(): void {
    // RC-7 fix: Abort any pending connection attempt
    if (this.connectAbortController) {
      this.connectAbortController.abort();
      this.connectAbortController = null;
    }
    
    // RC-7 fix: Clear any pending timeout
    if (this.connectTimeoutId) {
      clearTimeout(this.connectTimeoutId);
      this.connectTimeoutId = null;
    }
    
    this.explicitDisconnect = true;
    this.reconnectManager.stop();
    this.heartbeatManager.stop();

    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }

    this.updateState({
      isConnected: false,
      isConnecting: false,
      reconnectAttempts: 0,
    });

    this.eventEmitter.removeAllListeners();
  }

  async reconnect(): Promise<void> {
    this.disconnect();
    const freshToken = localStorage.getItem('access-token') || '';
    await new Promise(resolve => setTimeout(resolve, 100));
    await this.connect(this.config.url, freshToken);
  }

  // ==================== Internal Handlers ====================

  private handleOpen(): void {
    this.updateState({
      isConnected: true,
      isConnecting: false,
      lastError: null,
      reconnectAttempts: 0,
    });

    this.reconnectManager.reset();
    this.heartbeatManager.start();
    this.eventEmitter.emit('connected', {});
    this.messageSender.resendPendingMessages();
    
    // Resolve the connect promise after handshake is acknowledged
    // This ensures isConnected is true before any code tries to send messages
    if (this.pendingConnectResolve) {
      this.pendingConnectResolve();
      this.pendingConnectResolve = null;
    }
    
    // Also reset isExplicitConnecting flag
    if (this.isExplicitConnecting) {
      this.isExplicitConnecting = false;
    }
  }

  private handleMessage(event: MessageEvent): void {
    try {
      const data = JSON.parse(event.data);
      // For read and read_ack events, emit only payload
      // For other events, emit the full WSMessage
      if (data.type === 'read' || data.type === 'read_ack') {
        this.eventEmitter.emit(data.type, data.payload);
      } else {
        this.eventEmitter.emit(data.type, data);
      }

      if (data.type === 'ack' && data.messageId) {
        this.messageSender.removePendingMessage(data.messageId);
        this.eventEmitter.emit('acked', data.messageId);
      }

      if (data.type === 'pong') {
        this.eventEmitter.emit('pong', data);
      }

      if (data.type === 'error' && data.payload?.code === 'SIGNAL_DEVICE_NOT_READY') {
        console.warn('[WebSocket] SIGNAL_DEVICE_NOT_READY error received');
        const error = new Error('SIGNAL_DEVICE_NOT_READY');
        (error as Error & { code?: string }).code = 'SIGNAL_DEVICE_NOT_READY';
        this.updateState({ lastError: error, isConnecting: false });
        this.eventEmitter.emit('signal_not_ready', error);
        return;
      }

      if (data.type === 'handshake_ack' && data.success) {
        this.handleOpen();
      }
    } catch (error) {
      console.error('[WebSocket] Failed to parse message:', error);
    }
  }

  private handleClose(event: CloseEvent): void {
    this.heartbeatManager.stop();
    
    // Capture explicitDisconnect BEFORE resetting it
    const wasExplicitDisconnect = this.explicitDisconnect;
    this.explicitDisconnect = false;

    this.updateState({
      isConnected: false,
      isConnecting: false,
    });

    this.eventEmitter.emit('disconnected', { code: event.code, reason: event.reason });

    if (event.code === 4003 || event.reason?.includes('SIGNAL_DEVICE_NOT_READY')) {
      console.warn('[WebSocket] Closed due to SIGNAL_DEVICE_NOT_READY');
      const error = new Error('SIGNAL_DEVICE_NOT_READY');
      (error as Error & { code?: string }).code = 'SIGNAL_DEVICE_NOT_READY';
      this.updateState({ lastError: error });
      this.eventEmitter.emit('signal_not_ready', error);
      return;
    }

    // Check explicit disconnect FIRST (before other conditions)
    if (wasExplicitDisconnect) {
      return;
    }

    // RC-6 fix: Don't reconnect if explicit connection is in progress
    if (this.isExplicitConnecting) {
      return;
    }

    if (this.state.isConnecting) {
      return;
    }

    if (event.code === 1000) {
      return;
    }

    if (this.reconnectManager.canReconnect()) {
      this.updateState({ reconnectAttempts: this.reconnectManager.getAttempts() + 1 });
      this.reconnectManager.scheduleReconnect();
    }
  }

  private handleError(): void {
    const error = new Error('WebSocket error');
    this.updateState({ lastError: error });
    this.eventEmitter.emit('error', error);
  }

  private sendPing(): void {
    if (this.state.isConnected && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ 
        type: 'ping', 
        timestamp: Date.now(),
        id: `ping-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
      }));
    }
  }

  // ==================== Message Sending ====================

  sendMessage = (m: Omit<WSMessage, 'messageId' | 'timestamp'>) => this.messageSender.sendMessage(m);
  
  /**
   * Send a message with type and data (compatible with WebSocketClientInterface)
   */
  send = (type: string, data: unknown): void => {
    this.messageSender.sendMessage({ type, payload: data } as Omit<WSMessage, 'messageId' | 'timestamp'>);
  };
  
    sendMultiDeviceMessage = (
      chatId: string,
      recipientId: string,
      recipientMessages: { deviceId: number; content: string; messageType: number }[],
      senderMessages?: { deviceId: number; content: string; messageType: number }[],
      attachments?: WSAttachment[],
      replyTo?: string,
      metadata?: Record<string, any>
    ) => this.messageSender.sendMultiDeviceMessage(chatId, recipientId, recipientMessages, senderMessages, attachments, replyTo, metadata);
  sendHandshake = (t: string) => this.messageSender.sendHandshake(t);
  sendAck = (id: string) => this.messageSender.sendAck(id);
  sendTyping = (c: string, i: boolean) => this.messageSender.sendTyping(c, i);
  sendPresence = (s: 'online' | 'offline') => this.messageSender.sendPresence(s);
  sendSessionSync = (u: string, d: number, r: 'session_refresh' | 'new_device' | 'retry_request') => 
    this.messageSender.sendSessionSync(u, d, r);
  sendMessageRetryRequest = (o: string, c: string, s: string, d: number) => 
    this.messageSender.sendMessageRetryRequest(o, c, s, d);
  sendMarkRead = (c: string, m?: string[]) => this.messageSender.sendMarkRead(c, m);

  // ==================== Group Message Sending ====================

  /**
   * Send encrypted group message (Sender Key)
   */
  sendGroupMessage = (
    chatId: string,
    senderUserId: string,
    senderDeviceId: string,
    content: string,
    messageId: string,
    senderKeyId?: string,
    replyTo?: string,
    attachments?: WSAttachment[],
    senderKeyDistribution?: string,
    metadata?: Record<string, any>
  ) => this.messageSender.sendGroupMessage(chatId, senderUserId, senderDeviceId, content, messageId, senderKeyId, replyTo, attachments, senderKeyDistribution, metadata);

  /**
   * Request Sender Key update for a group
   */
  sendGroupKeyUpdate = (
    chatId: string,
    requestingUserId: string,
    requestingDeviceId: string,
    reason: 'member_joined' | 'member_left' | 'admin_changed' | 'manual_request'
  ) => this.messageSender.sendGroupKeyUpdate(chatId, requestingUserId, requestingDeviceId, reason);

  /**
   * Sync Sender Keys between user's own devices
   */
  sendGroupSync = (
    chatId: string,
    senderUserId: string,
    senderKeyId: string,
    senderKey: string,
    senderKeySignature?: string
  ) => this.messageSender.sendGroupSync(chatId, senderUserId, senderKeyId, senderKey, senderKeySignature);

  // ==================== Event Subscriptions ====================

  on<T = unknown>(event: string, callback: (data: T) => void): () => void {
    return this.eventEmitter.on(event, callback as EventCallback);
  }

  onMessage = (cb: (data: WSMessage) => void) => this.on('message', cb);
  onAck = (cb: (id: string) => void) => this.on('acked', cb);
  onTyping = (cb: (d: { userId: string; chatId: string }) => void) => 
    this.on('typing', (data: { type: string; payload: { userId: string; chatId: string } }) => {
      cb(data.payload);
    });
  onPresence = (cb: (d: { userId: string; status: 'online' | 'offline'; lastSeen?: string }) => void) =>
    this.on('presence', (data: { userId: string; status: 'online' | 'offline'; lastSeen?: string }) => {
      cb(data);
    });
  onConnected = (cb: () => void) => this.on('connected', cb);
  onDisconnected = (cb: (d: { code: number; reason: string }) => void) => this.on('disconnected', cb);
  onError = (cb: (e: Error) => void) => this.on('error', cb);
  onSignalNotReady = (cb: (e: Error) => void) => this.on('signal_not_ready', cb);
  onNewMessage = (cb: (d: unknown) => void) => this.on('NEW_MESSAGE', cb);
  onMessageDelivered = (cb: (d: unknown) => void) => this.on('MESSAGE_DELIVERED', cb);
  onMessageRead = (cb: (d: unknown) => void) => this.on('MESSAGE_READ', cb);
  onUserOnline = (cb: (d: { userId: string }) => void) =>
    this.on('USER_ONLINE', (data: { type: string; payload: { userId: string } }) => {
      cb(data.payload);
    });
  onUserOffline = (cb: (d: { userId: string }) => void) =>
    this.on('USER_OFFLINE', (data: { type: string; payload: { userId: string } }) => {
      cb(data.payload);
    });
  onSessionSync = (cb: (d: { userId: string; deviceId: number; reason: string }) => void) =>
    this.on('SESSION_SYNC', (data: { type: string; payload: { userId: string; deviceId: number; reason: string } }) => {
      cb(data.payload);
    });
  onMessageRetry = (cb: (d: { originalMessageId: string; chatId: string; senderId: string; senderDeviceId: number }) => void) =>
    this.on('MESSAGE_RETRY', (data: { type: string; payload: { originalMessageId: string; chatId: string; senderId: string; senderDeviceId: number } }) => {
      cb(data.payload);
    });
  onReadEvent = (cb: (payload: { chatId: string }) => void) => this.on('read', cb);
  onReadAck = (cb: (payload: { chatId: string; unreadCount?: number }) => void) => this.on('read_ack', cb);

  // ==================== Group Message Event Handlers ====================

  /**
   * Listen for incoming group messages
   */
   onGroupMessage = (cb: (d: {
     chatId: string;
     content: string;
     senderUserId: string;
     senderDeviceId: string;
     messageId: string;
     timestamp: number;
     senderKeyId?: string;
     replyTo?: string;
     attachments?: WSAttachment[];
     senderKeyDistribution?: string;
     unreadCount?: number;
     isPending?: boolean;
     isSelfDelivery?: boolean;
     metadata?: Record<string, any>;
   }) => void) => this.on('group_message', (data: { type: string; payload: {
     chatId: string;
     content: string;
     senderUserId: string;
     senderDeviceId: string;
     messageId: string;
     timestamp: number;
     senderKeyId?: string;
     replyTo?: string;
     attachments?: WSAttachment[];
     senderKeyDistribution?: string;
     unreadCount?: number;
     isPending?: boolean;
     isSelfDelivery?: boolean;
     metadata?: Record<string, any>;
   } }) => {
     cb(data.payload);
   });

  /**
   * Listen for group key update notifications
   */
  onGroupKeyUpdate = (cb: (d: {
    chatId: string;
    senderUserId: string;
    senderDeviceId: string;
    senderKeyId: string;
    senderKey: string;
    reason: 'member_joined' | 'member_left' | 'admin_changed';
  }) => void) => this.on('group_key_update', (data: { type: string; payload: {
    chatId: string;
    senderUserId: string;
    senderDeviceId: string;
    senderKeyId: string;
    senderKey: string;
    reason: 'member_joined' | 'member_left' | 'admin_changed';
  } }) => {
    cb(data.payload);
  });

  /**
   * Listen for group sync (Sender Key sync between own devices)
   */
  onGroupSync = (cb: (d: {
    chatId: string;
    senderUserId: string;
    senderKeyId: string;
    senderKey: string;
    senderKeySignature?: string;
  }) => void) => this.on('group_sync', (data: { type: string; payload: {
    chatId: string;
    senderUserId: string;
    senderKeyId: string;
    senderKey: string;
    senderKeySignature?: string;
  } }) => {
    cb(data.payload);
  });

  /**
   * Listen for group message acknowledgments
   */
  onGroupMessageAck = (cb: (d: { messageId: string; chatId: string; status: 'received' | 'delivered' }) => void) =>
    this.on('group_message_ack', (data: { type: string; payload: { messageId: string; chatId: string; status: 'received' | 'delivered' } }) => {
      cb(data.payload);
    });

  // ==================== P2P Sync Event Handlers ====================

  /**
   * Listen for sync_request from other devices
   * Called when another device requests history
   */
  onSyncRequest = (cb: (d: { requestingDeviceId: string; requestingSignalDeviceId?: number; targetDeviceId?: string; vectorClock: Record<string, number> }) => void) =>
    this.on('sync_request', (data: { type: string; payload: { requestingDeviceId: string; requestingSignalDeviceId?: number; targetDeviceId?: string; vectorClock: Record<string, number> } }) => {
      cb(data.payload);
    });

  /**
   * Listen for sync_history from other devices
   * Called when receiving encrypted history
   */
  onSyncHistory = (cb: (d: { targetDeviceId: string; senderDeviceId: string; senderSignalDeviceId?: number; encryptedHistory: string; vectorClock: Record<string, number> }) => void) =>
    this.on('sync_history', (data: { type: string; payload: { targetDeviceId: string; senderDeviceId: string; senderSignalDeviceId?: number; encryptedHistory: string; vectorClock: Record<string, number> } }) => {
      cb(data.payload);
    });

  /**
   * Listen for sync_ack from other devices
   * Called when sync is acknowledged
   */
  onSyncAck = (cb: (d: { deviceId: string; newVectorClock: Record<string, number> }) => void) =>
    this.on('sync_ack', (data: { type: string; payload: { deviceId: string; newVectorClock: Record<string, number> } }) => {
      cb(data.payload);
    });

  /**
   * Listen for device_online notifications
   * Called when another device comes online
   */
  onDeviceOnline = (cb: (d: { userId: string; deviceId: string; signalDeviceId: number; deviceName?: string }) => void) =>
    this.on('device_online', (data: { type: string; payload: { userId: string; deviceId: string; signalDeviceId: number; deviceName?: string } }) => {
      cb(data.payload);
    });

  // ==================== Two-Phase Sync Event Handlers ====================

  /**
   * Listen for sync_invite from new devices
   * Called when a new device requests history sync
   */
  onSyncInvite = (cb: (d: { invitingDeviceId: string; invitingDeviceName?: string; timestamp: number }) => void) =>
    this.on('sync_invite', (data: { type: string; payload: { invitingDeviceId: string; invitingDeviceName?: string; timestamp: number } }) => {
      cb(data.payload);
    });

  /**
   * Listen for sync_accept from devices that accepted sync
   * Called when a device accepts our sync invite
   */
  onSyncAccept = (cb: (d: { acceptingDeviceId: string; targetDeviceId: string; timestamp: number }) => void) =>
    this.on('sync_accept', (data: { type: string; payload: { acceptingDeviceId: string; targetDeviceId: string; timestamp: number } }) => {
      cb(data.payload);
    });

  /**
   * Listen for sync_cancel from server
   * Called when another device accepted the invite (we should close dialog)
   */
  onSyncCancel = (cb: (d: { invitingDeviceId: string; acceptedByDeviceId: string; reason?: string }) => void) =>
    this.on('sync_cancel', (data: { type: string; payload: { invitingDeviceId: string; acceptedByDeviceId: string; reason?: string } }) => {
      cb(data.payload);
    });

  /**
   * Listen for sync_reject from devices that rejected sync
   * Called when a device rejects our sync invite
   */
  onSyncReject = (cb: (d: { rejectingDeviceId: string; targetDeviceId: string; timestamp: number }) => void) =>
    this.on('sync_reject', (data: { type: string; payload: { rejectingDeviceId: string; targetDeviceId: string; timestamp: number } }) => {
      cb(data.payload);
    });

  /**
   * Send sync_request to request history from other devices
   */
  sendSyncRequest = async (requestingDeviceId: string, vectorClock: Record<string, number>) => {
    this.sendMessage({
      type: 'sync_request',
      payload: { requestingDeviceId, vectorClock },
    });
  };

  /**
   * Send sync_history to another device
   */
  sendSyncHistory = async (targetDeviceId: string, senderDeviceId: string, encryptedHistory: string, vectorClock: Record<string, number>) => {
    this.sendMessage({
      type: 'sync_history',
      payload: { targetDeviceId, senderDeviceId, encryptedHistory, vectorClock },
    });
  };

  /**
   * Send sync_ack to acknowledge sync completion
   */
  sendSyncAck = async (deviceId: string, newVectorClock: Record<string, number>) => {
    this.sendMessage({
      type: 'sync_ack',
      payload: { deviceId, newVectorClock },
    });
  };

  // ==================== Pending Messages ====================

  getPendingMessages = () => this.messageSender.getPendingMessages();
  clearPendingMessages = () => this.messageSender.clearPendingMessages();
}