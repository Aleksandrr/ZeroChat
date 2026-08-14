/**
 * Connection Types
 * Shared type definitions for WebSocket connection
 */

import type { WSAttachment,WSMessage } from '@/types/websocket';

/**
 * Connection state interface
 */
export interface ConnectionState {
  isConnected: boolean;
  isConnecting: boolean;
  lastError: Error | null;
  reconnectAttempts: number;
}

/**
 * WebSocket configuration
 */
export interface WSConfig {
  url: string;
  token: string;
  autoReconnect: boolean;
  reconnectInterval: number;
  maxReconnectAttempts: number;
  heartbeatInterval: number;
  /** Optional callback to get fresh token (with refresh if needed) for reconnection */
  getToken?: () => Promise<string>;
}

/**
 * Default WebSocket configuration
 *
 * F2: `maxReconnectAttempts` defaults to `Infinity` so the client
 * keeps retrying indefinitely (with a capped exponential backoff in
 * `ReconnectManager`). Callers can still pass a finite number if
 * they want the legacy "give up after N attempts" behaviour.
 */
export const DEFAULT_WS_CONFIG: WSConfig = {
  url: '',
  token: '',
  autoReconnect: true,
  reconnectInterval: 3000,
  maxReconnectAttempts: Infinity,
  heartbeatInterval: 30000,
};

/**
 * Pending message for reliability
 */
export interface PendingMessage {
  message: WSMessage;
  timestamp: number;
}

/**
 * Unified WebSocket client interface
 * Implemented by both WebSocketConnection and WorkerWebSocketClient
 */
export interface WebSocketClientInterface {
  // State
  getState(): ConnectionState;
  subscribeToState(listener: (state: ConnectionState) => void): () => void;
  // Synchronous getters for immediate state access (avoid React state desync)
  isConnected: boolean;
  isConnecting: boolean;
  
  // Connection
  connect(url?: string, token?: string): Promise<void> | void;
  disconnect(): void;
  
  // Messaging
  sendMessage(m: { type: string; payload: unknown }): Promise<void>;
  send(type: string, data: unknown): void;
  sendTyping(chatId: string, isTyping: boolean): void;
  sendMarkRead(chatId: string, messageIds?: string[]): void;
    sendMultiDeviceMessage(
      chatId: string,
      recipientId: string,
      recipientMessages: { deviceId: number; content: string; messageType: number }[],
      senderMessages?: { deviceId: number; content: string; messageType: number }[],
      attachments?: WSAttachment[]
    ): Promise<string>;
   sendGroupMessage(
     chatId: string,
     senderUserId: string,
     senderDeviceId: string,
     content: string,
     messageId?: string,
     senderKeyId?: string,
     replyTo?: string,
     attachments?: WSAttachment[],
     senderKeyDistribution?: string  // Base64-encoded Sender Key Distribution Message (SKDM)
   ): Promise<string>;
  sendSessionSync(userId: string, deviceId: number, reason: 'session_refresh' | 'new_device' | 'retry_request'): void;
  sendMessageRetryRequest(originalMessageId: string, chatId: string, senderId: string, senderDeviceId: number): void;
  
  // Event subscriptions
  on<T = unknown>(event: string, callback: (data: T) => void): () => void;
  onMessage(callback: (data: unknown) => void): () => void;
  onNewMessage(callback: (data: unknown) => void): () => void;
  onMessageDelivered(callback: (data: unknown) => void): () => void;
  onMessageRead(callback: (data: unknown) => void): () => void;
  onUserOnline(callback: (data: { userId: string }) => void): () => void;
  onUserOffline(callback: (data: { userId: string }) => void): () => void;
  onSessionSync(callback: (data: { userId: string; deviceId: number; reason: string }) => void): () => void;
  onMessageRetry(callback: (data: { originalMessageId: string; chatId: string; senderId: string; senderDeviceId: number }) => void): () => void;
  onReadEvent(callback: (data: unknown) => void): () => void;
  onReadAck(callback: (data: unknown) => void): () => void;
  onPresence(callback: (data: { userId: string; status: 'online' | 'offline'; lastSeen?: string }) => void): () => void;
  onSyncRequest(callback: (data: { requestingDeviceId: string; requestingSignalDeviceId?: number; targetDeviceId?: string; vectorClock: Record<string, number> }) => void): () => void;
  onSyncHistory(callback: (data: { targetDeviceId: string; senderDeviceId: string; senderSignalDeviceId?: number; encryptedHistory: string; vectorClock: Record<string, number> }) => void): () => void;
  onDeviceOnline(callback: (data: { userId: string; deviceId: string; signalDeviceId: number; deviceName?: string }) => void): () => void;
  // Two-phase sync events
  onSyncInvite(callback: (data: { invitingDeviceId: string; invitingDeviceName?: string; timestamp: number }) => void): () => void;
  onSyncAccept(callback: (data: { acceptingDeviceId: string; targetDeviceId: string; timestamp: number }) => void): () => void;
  onSyncCancel(callback: (data: { invitingDeviceId: string; acceptedByDeviceId: string; reason?: string }) => void): () => void;
  onSyncReject(callback: (data: { rejectingDeviceId: string; targetDeviceId: string; timestamp: number }) => void): () => void;
  onSignalNotReady(callback: (error: Error) => void): () => void;
  onConnected(callback: () => void): () => void;
}