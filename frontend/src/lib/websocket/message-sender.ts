/**
 * Message Sender Module
 * Handles all WebSocket message sending operations
 */

import type { WSAttachment,WSMessage } from '@/types/websocket';

import type {EventEmitter } from './event-emitter';
import { type EventCallback } from './event-emitter';
import { type PendingMessage } from './types';

/**
 * Message Sender Class
 * Manages message ID generation, pending messages queue, and sending
 */
export class MessageSender {
  private pendingMessages = new Map<string, PendingMessage>();
  private messageIdCounter = 0;
  private eventEmitter: EventEmitter;
  private getWebSocket: () => WebSocket | null;
  private isConnected: () => boolean;

  constructor(
    eventEmitter: EventEmitter,
    getWebSocket: () => WebSocket | null,
    isConnected: () => boolean
  ) {
    this.eventEmitter = eventEmitter;
    this.getWebSocket = getWebSocket;
    this.isConnected = isConnected;
  }

  // ==================== Message ID Generation ====================

  generateMessageId(): string {
    return crypto.randomUUID();
  }

  // ==================== Pending Messages ====================

  getPendingMessages(): PendingMessage[] {
    return Array.from(this.pendingMessages.values());
  }

  clearPendingMessages(): void {
    this.pendingMessages.clear();
  }

  removePendingMessage(messageId: string): void {
    this.pendingMessages.delete(messageId);
  }

  // ==================== Core Send Logic ====================

  private sendIfConnected(fullMessage: WSMessage): void {
    const ws = this.getWebSocket();
    if (!this.isConnected() || ws?.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not connected');
    }

    ws.send(JSON.stringify(fullMessage));
    this.eventEmitter.emit('outgoing', fullMessage);
  }

  private storePending(message: WSMessage): void {
    this.pendingMessages.set(message.messageId, {
      message,
      timestamp: Date.now(),
    });
  }

  // ==================== Public Send Methods ====================

  async sendMessage(message: Omit<WSMessage, 'messageId' | 'timestamp'>): Promise<void> {
    const fullMessage: WSMessage = {
      ...message,
      messageId: this.generateMessageId(),
      timestamp: Date.now(),
    };

    this.storePending(fullMessage);
    this.sendIfConnected(fullMessage);
  }

    /**
     * Send multi-device message (Sesame protocol)
     * Each device receives its own encrypted copy
     */
    async sendMultiDeviceMessage(
      chatId: string,
      recipientId: string,
      recipientMessages: { deviceId: number; content: string; messageType: number }[],
      senderMessages?: { deviceId: number; content: string; messageType: number }[],
      attachments?: WSAttachment[],
      replyTo?: string,
      metadata?: Record<string, any>
    ): Promise<string> {
      const messageId = this.generateMessageId();
      const fullMessage: WSMessage = {
        type: 'multi_message',
        payload: {
          chatId,
          recipientId,
          recipientMessages,
          senderMessages,
          attachments,
          replyTo,
          metadata,
          messageId, // Include client-generated UUID in payload
        },
        messageId,
        timestamp: Date.now(),
      };

      this.storePending(fullMessage);

      try {
        this.sendIfConnected(fullMessage);
      } catch (error) {
        console.error('[MessageSender] Failed to send multi-device message:', error);
        throw error;
      }

      return messageId;
    }

  async sendHandshake(token: string): Promise<void> {
    const fullMessage: WSMessage = {
      type: 'handshake',
      payload: { token },
      messageId: this.generateMessageId(),
      timestamp: Date.now(),
    };

    this.sendIfConnected(fullMessage);
  }

  async sendAck(messageId: string): Promise<void> {
    const fullMessage: WSMessage = {
      type: 'ack',
      payload: { messageId },
      messageId: this.generateMessageId(),
      timestamp: Date.now(),
    };

    this.sendIfConnected(fullMessage);
  }

  sendTyping(chatId: string, isTyping: boolean): void {
    if (!this.isConnected() || this.getWebSocket()?.readyState !== WebSocket.OPEN) {
      return;
    }

    const fullMessage: WSMessage = {
      type: 'typing',
      payload: { chatId, isTyping },
      messageId: this.generateMessageId(),
      timestamp: Date.now(),
    };

    this.getWebSocket()!.send(JSON.stringify(fullMessage));
    this.eventEmitter.emit('outgoing', fullMessage);
  }

  sendPresence(status: 'online' | 'offline'): void {
    if (!this.isConnected() || this.getWebSocket()?.readyState !== WebSocket.OPEN) {
      return;
    }

    const fullMessage: WSMessage = {
      type: 'presence',
      payload: { status },
      messageId: this.generateMessageId(),
      timestamp: Date.now(),
    };

    this.getWebSocket()!.send(JSON.stringify(fullMessage));
    this.eventEmitter.emit('outgoing', fullMessage);
  }

  sendSessionSync(
    userId: string,
    deviceId: number,
    reason: 'session_refresh' | 'new_device' | 'retry_request'
  ): void {
    if (!this.isConnected() || this.getWebSocket()?.readyState !== WebSocket.OPEN) {
      return;
    }

    const fullMessage: WSMessage = {
      type: 'session_sync',
      payload: { userId, deviceId, reason },
      messageId: this.generateMessageId(),
      timestamp: Date.now(),
    };

    this.getWebSocket()!.send(JSON.stringify(fullMessage));
    this.eventEmitter.emit('outgoing', fullMessage);
  }

  sendMessageRetryRequest(
    originalMessageId: string,
    chatId: string,
    senderId: string,
    senderDeviceId: number
  ): void {
    if (!this.isConnected() || this.getWebSocket()?.readyState !== WebSocket.OPEN) {
      return;
    }

    const fullMessage: WSMessage = {
      type: 'message_retry',
      payload: { originalMessageId, chatId, senderId, senderDeviceId, reason: 'decryption_failed' },
      messageId: this.generateMessageId(),
      timestamp: Date.now(),
    };

    this.getWebSocket()!.send(JSON.stringify(fullMessage));
    this.eventEmitter.emit('outgoing', fullMessage);
  }

  sendMarkRead(chatId: string, messageIds?: string[]): void {
    if (!this.isConnected() || this.getWebSocket()?.readyState !== WebSocket.OPEN) {
      return;
    }

    const fullMessage: WSMessage = {
      type: 'mark_read',
      payload: { chatId, messageIds },
      messageId: this.generateMessageId(),
      timestamp: Date.now(),
    };

    this.getWebSocket()!.send(JSON.stringify(fullMessage));
    this.eventEmitter.emit('outgoing', fullMessage);
  }

  // ==================== Group Message Sending ====================

  /**
   * Send encrypted group message (Sender Key)
   * @param senderKeyDistribution - Optional Base64-encoded SKDM to share with other group members
   */
   async sendGroupMessage(
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
     const msgId = messageId || this.generateMessageId();
     
     if (!this.isConnected() || this.getWebSocket()?.readyState !== WebSocket.OPEN) {
       throw new Error('WebSocket not connected');
     }

     const fullMessage: WSMessage = {
       type: 'group_message',
       payload: {
         chatId,
         senderUserId,
         senderDeviceId,
         content,
         messageId: msgId,
         senderKeyId,
         replyTo,
         attachments,
         senderKeyDistribution, // Include SKDM for other group members
         metadata,
       },
       messageId: msgId,
       timestamp: Date.now(),
     };

     console.log('[MessageSender] Sending group_message:', {
       chatId,
       senderUserId,
       senderDeviceId,
       contentLength: content.length,
       messageId: msgId,
       hasSenderKeyDistribution: !!senderKeyDistribution,
       hasAttachments: !!attachments,
       attachmentCount: attachments?.length
     });
     this.getWebSocket()!.send(JSON.stringify(fullMessage));
     this.eventEmitter.emit('outgoing', fullMessage);
     
     return msgId;
   }

  /**
   * Request Sender Key update for a group
   */
  sendGroupKeyUpdate(
    chatId: string,
    requestingUserId: string,
    requestingDeviceId: string,
    reason: 'member_joined' | 'member_left' | 'admin_changed' | 'manual_request'
  ): void {
    if (!this.isConnected() || this.getWebSocket()?.readyState !== WebSocket.OPEN) {
      return;
    }

    const fullMessage: WSMessage = {
      type: 'group_key_update',
      payload: {
        chatId,
        requestingUserId,
        requestingDeviceId,
        reason
      },
      messageId: this.generateMessageId(),
      timestamp: Date.now(),
    };

    this.getWebSocket()!.send(JSON.stringify(fullMessage));
    this.eventEmitter.emit('outgoing', fullMessage);
  }

  /**
   * Sync Sender Keys between user's own devices
   */
  sendGroupSync(
    chatId: string,
    senderUserId: string,
    senderKeyId: string,
    senderKey: string,
    senderKeySignature?: string
  ): void {
    if (!this.isConnected() || this.getWebSocket()?.readyState !== WebSocket.OPEN) {
      return;
    }

    const fullMessage: WSMessage = {
      type: 'group_sync',
      payload: {
        chatId,
        senderUserId,
        senderKeyId,
        senderKey,
        senderKeySignature
      },
      messageId: this.generateMessageId(),
      timestamp: Date.now(),
    };

    this.getWebSocket()!.send(JSON.stringify(fullMessage));
    this.eventEmitter.emit('outgoing', fullMessage);
  }

  // ==================== Resend Pending ====================

  resendPendingMessages(): void {
    const ws = this.getWebSocket();
    if (ws?.readyState === WebSocket.OPEN) {
      this.pendingMessages.forEach(({ message }) => {
        ws.send(JSON.stringify(message));
      });
    }
  }
}