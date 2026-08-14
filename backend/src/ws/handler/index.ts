import { wsAuth } from '../auth';
import { WSClient, WebSocketManager } from '../manager';
import { WebSocketClient } from './client';
import { isValidMessage, getAuthHeader } from './helpers';
import type { WSMessage } from '../types';
import { prisma } from '../../prisma/client';

// Import all handlers
import {
  // Auth handlers
  handleAuthMessage,
  handlePreKeyMessage,
  // Presence handlers
  handleHeartbeat,
  handlePing,
  handleTypingMessage,
  broadcastPresence,
  // Message handlers
  handleAckMessage,
  handleMessageRetry,
  handleMarkRead,
  // Multi-device handlers
  handleMultiDeviceMessage,
  handleFavoritesMessage,
  // Sync handlers
  handleSessionSync,
  handleSyncRequest,
  handleSyncHistory,
  handleSyncAck,
  handleDeviceOnline,
  notifyDeviceOnline,
  handleMessageAck,
  resetStaleDelivering,
  handleClientReady,
  sendPendingMessages,
  // P2P Sync handlers
  handleSyncInvite,
  handleSyncAccept,
  handleSyncCancel,
  handleSyncReject,
  // Group handlers
  handleGroupMessage,
  handleGroupKeyUpdate,
  handleGroupSync,
  handleSenderKeyDistribution,
  // Command Bus handlers
  handleCommand,
  // WebRTC Call handlers
  handleCallOffer,
  handleCallAnswer,
  handleCallReject,
  handleCallEnd,
  handleCallIce,
  handleCallBusy,
} from './handlers';

// Export WebSocketClient for external use
export { WebSocketClient } from './client';

// ==================== WebSocket Handler ====================

export class WebSocketHandler {
  private manager: WebSocketManager;

  constructor(manager: WebSocketManager) {
    this.manager = manager;
  }

  /**
   * Обрабатывает новое WebSocket соединение
   * @param socket WebSocket соединение
   * @param request HTTP запрос
   * @param onClientCreated Callback, вызываемый сразу после создания клиента (до async операций)
   *                        Это нужно для регистрации клиента в socketClients до отправки handshake_ack
   */
  async handleConnection(
    socket: WebSocket,
    request: any,
    onClientCreated?: (client: WebSocketClient) => void
  ): Promise<WebSocketClient | null> {
    // Build full URL from request for URL parsing
    const host = request.headers?.host || 'localhost:3001';
    const protocol = request.socket?.encrypted ? 'https' : 'http';
    const fullUrl = `${protocol}://${host}${request.url}`;
    const url = new URL(fullUrl);
    const token = url.searchParams.get('token') || getAuthHeader(request);

    if (!token) {
      socket.close(4001, 'Отсутствует токен аутентификации');
      return null;
    }

    try {
      const authResult = await wsAuth.authenticate(token);

      if (!authResult.success || !authResult.device) {
        // Send error message before closing for specific error codes
        if (authResult.error === 'SIGNAL_DEVICE_NOT_READY') {
          socket.send(JSON.stringify({
            type: 'error',
            payload: {
              code: 'SIGNAL_DEVICE_NOT_READY',
              message: authResult.message || 'Device registration in progress'
            },
            timestamp: Date.now(),
            id: crypto.randomUUID()
          }));
          // Wait a bit for message to be sent before closing
          setTimeout(() => {
            socket.close(4003, authResult.error || 'Signal device not ready');
          }, 100);
          return null;
        }
        // BUG #3 FIX: device has a signalDeviceId but verifiedAt is null.
        // The user must complete device verification (POST /devices/:id/verify)
        // before opening a WebSocket. Close with the dedicated 4004 code so
        // the client can render a "verify this device" UI instead of a
        // generic auth-failure screen.
        if (authResult.error === 'DEVICE_NOT_VERIFIED') {
          socket.send(JSON.stringify({
            type: 'error',
            payload: {
              code: 'DEVICE_NOT_VERIFIED',
              message: authResult.message || 'Device is not verified'
            },
            timestamp: Date.now(),
            id: crypto.randomUUID()
          }));
          setTimeout(() => {
            socket.close(4004, authResult.error || 'Device not verified');
          }, 100);
          return null;
        }
        socket.close(4002, authResult.error || 'Ошибка аутентификации');
        return null;
      }

      const client = new WebSocketClient(authResult.device, socket);
      this.manager.addClient(client);

      // CRITICAL: Call onClientCreated immediately after client creation
      // This registers the client in socketClients BEFORE sending handshake_ack
      // Without this, 'ready' message from client would be lost due to race condition
      if (onClientCreated) {
        onClientCreated(client);
      }

      this.sendHandshakeAck(socket, authResult.device);

      // NOTE: sendPendingMessages is now called when client sends 'ready' message
      // This fixes race condition where messages were sent before ChatContext subscribed

      // Broadcast presence to all contacts (users who have chats with this user)
      await broadcastPresence(authResult.device.userId, 'online', this.manager);

      // Notify other devices of this user about device online (for multi-device sync)
      await notifyDeviceOnline(client, this.manager);

      return client;

    } catch (error) {
      console.error('Ошибка при подключении:', error);
      socket.close(4002, 'Ошибка при подключении');
      return null;
    }
  }

  /**
   * Обрабатывает входящее сообщение
   */
  async handleMessage(rawMessage: string, client: WSClient): Promise<void> {
    try {
      const message: WSMessage = JSON.parse(rawMessage);

      if (!isValidMessage(message)) {
        console.warn('[WS] Invalid message structure:', message);
        // Need to access socket for error sending
        if ('socket' in client) {
          this.sendError((client as WebSocketClient).socket, 'invalid_message', 'Невалидная структура сообщения');
        }
        return;
      }

      const wsClient = client as WebSocketClient;

      switch (message.type) {
        case 'auth':
          await handleAuthMessage(
            message.payload as any,
            wsClient,
            this.manager,
            (socket: WebSocket, code: string, message: string) => this.sendError(socket, code, message)
          );
          break;
        case 'prekey':
          await handlePreKeyMessage(message.payload as any, wsClient, this.manager);
          break;
        case 'ack':
          await handleAckMessage(message.payload as any, wsClient, this.manager);
          break;
        case 'heartbeat':
          handleHeartbeat(wsClient);
          break;
        case 'ping':
          handlePing(wsClient);
          break;
        case 'handshake':
          // Handshake is processed during connection, ignore here
          break;
        case 'typing':
          await handleTypingMessage(
            message.payload as any,
            wsClient,
            this.manager,
            (userId: string, status: 'online' | 'offline') => broadcastPresence(userId, status, this.manager),
            (socket: WebSocket, code: string, message: string) => this.sendError(socket, code, message)
          );
          break;
        case 'session_sync':
          handleSessionSync(message.payload as any, wsClient, this.manager);
          break;
        case 'message_retry':
          await handleMessageRetry(message.payload as any, wsClient, this.manager);
          break;
        case 'mark_read':
          await handleMarkRead(message.payload as any, wsClient, this.manager);
          break;
        case 'multi_message':
          await handleMultiDeviceMessage(
            message.payload as any,
            wsClient,
            this.manager,
            (client: WebSocketClient, messageId: string, chatId: string, status: 'sent' | 'delivered' | 'read' | 'failed', deviceId?: number | string) =>
              this.sendDeliveryStatus(client, messageId, chatId, status, deviceId)
          );
          break;
        case 'sync_request':
          await handleSyncRequest(message.payload as any, wsClient, this.manager);
          break;
        case 'sync_history':
          await handleSyncHistory(message.payload as any, wsClient, this.manager);
          break;
        case 'sync_ack':
          await handleSyncAck(message.payload as any, wsClient, this.manager);
          break;
        case 'device_online':
          await handleDeviceOnline(message.payload as any, wsClient, this.manager);
          break;
        case 'ready':
          // Reset stale "delivering" messages before sending pending
          await resetStaleDelivering(wsClient.getDeviceId());
          await handleClientReady(wsClient, (c) => sendPendingMessages(c, this.manager));
          break;
        case 'message_ack':
          await handleMessageAck(message.payload as any, wsClient, this.manager);
          break;
        // Two-phase P2P sync handlers
        case 'sync_invite':
          await handleSyncInvite(message.payload as any, wsClient, this.manager);
          break;
        case 'sync_accept':
          await handleSyncAccept(message.payload as any, wsClient, this.manager);
          break;
        case 'sync_cancel':
          await handleSyncCancel(message.payload as any, wsClient, this.manager);
          break;
        case 'sync_reject':
          await handleSyncReject(message.payload as any, wsClient, this.manager);
          break;
        // Group chat handlers
        case 'favorites_message':
          await handleFavoritesMessage(
            message.payload as any,
            wsClient,
            this.manager,
            (client: WebSocketClient, messageId: string, chatId: string, status: 'sent' | 'delivered' | 'read' | 'failed', deviceId?: number | string) =>
              this.sendDeliveryStatus(client, messageId, chatId, status, deviceId)
          );
          break;
        case 'group_message':
          await handleGroupMessage(message.payload as any, wsClient, this.manager);
          break;
        case 'group_key_update':
          await handleGroupKeyUpdate(message.payload as any, wsClient, this.manager);
          break;
        case 'group_sync':
          await handleGroupSync(message.payload as any, wsClient, this.manager);
          break;
         case 'sender_key_distribution_message':
           await handleSenderKeyDistribution(message.payload as any, wsClient, this.manager);
           break;
         case 'command':
           await handleCommand(message as any, wsClient, this.manager);
           break;
         // WebRTC Call Signaling — relay only
         case 'call_offer':
           await handleCallOffer(message.payload as any, wsClient, this.manager);
           break;
         case 'call_answer':
           await handleCallAnswer(message.payload as any, wsClient, this.manager);
           break;
         case 'call_reject':
           await handleCallReject(message.payload as any, wsClient, this.manager);
           break;
         case 'call_end':
           await handleCallEnd(message.payload as any, wsClient, this.manager);
           break;
         case 'call_ice':
           await handleCallIce(message.payload as any, wsClient, this.manager);
           break;
         case 'call_busy':
           await handleCallBusy(message.payload as any, wsClient, this.manager);
           break;
         default:
           console.warn('Неизвестный тип сообщения:', message.type);
      }

    } catch (error) {
      console.error('Ошибка обработки сообщения:', error);
      if ('socket' in client) {
        this.sendError((client as WebSocketClient).socket, 'parse_error', 'Ошибка обработки сообщения');
      }
    }
  }

  /**
   * Обрабатывает отключение клиента
   * FIX: Определение offline статуса теперь основано на реальных WebSocket соединениях,
   * а не на lastSeen в базе, чтобы избежать расхождений.
   */
  async handleDisconnect(client: WSClient): Promise<void> {
    const userId = client.getUserId();
    const deviceId = client.getDeviceId();
    
    // RC-5 FIX: Pass client reference to prevent ghost disconnect from deleting newer connection
    this.manager.removeClient(deviceId, client);
    
    // Check if user is now fully offline (no more devices connected)
    const remainingClients = this.manager.getClientsByUserId(userId);
    if (remainingClients.length === 0) {
      // User is now offline - update DB and broadcast to contacts
      try {
        await prisma.user.update({
          where: { id: userId },
          data: { status: 'OFFLINE', lastSeen: new Date() }
        });
        await broadcastPresence(userId, 'offline', this.manager);
        console.log(`[Disconnect] User ${userId} went offline (last device disconnected)`);
      } catch (error) {
        console.error('[Disconnect] Error updating user status:', error);
      }
    } else {
      console.log(`[Disconnect] User ${userId} still has ${remainingClients.length} online devices`);
    }
    
    console.log(`WebSocket отключение: deviceId=${deviceId}, userId=${userId}`);
  }

  // ==================== Helper Methods ====================

  private sendHandshakeAck(socket: WebSocket, device: { id: string; deviceId: string; signalDeviceId: number; userId: string; username: string }): void {
    if (socket.readyState === WebSocket.OPEN) {
      // API consistency: every other WS message carries its data inside
      // `payload`. `handshake_ack` previously used a top-level `device`
      // field, which broke the convention and made client-side message
      // handling special-case this one message type.
      //
      // We now send the same data in `payload` AND keep the legacy
      // top-level `device` field for backward compatibility with older
      // frontends. The legacy field can be removed once all clients
      // have migrated to reading `payload`.
      const deviceData = {
        id: device.id,
        deviceId: device.deviceId,
        signalDeviceId: device.signalDeviceId,
        userId: device.userId,
        username: device.username,
      };
      socket.send(JSON.stringify({
        type: 'handshake_ack',
        success: true,
        payload: deviceData,
        device: deviceData, // LEGACY: kept for backward compat — remove once all clients read `payload`
        timestamp: Date.now(),
        id: crypto.randomUUID(),
      }));
    }
  }

  private sendError(socket: WebSocket, _code: string, message: string): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'error',
        payload: {
          code: 4000,
          message
        },
        timestamp: Date.now(),
        id: crypto.randomUUID()
      }));
    }
  }

  private sendDeliveryStatus(
    client: WebSocketClient,
    messageId: string,
    chatId: string,
    status: 'sent' | 'delivered' | 'read' | 'failed',
    deviceId?: number | string
  ): void {
    client.send({
      type: 'delivery',
      payload: {
        messageId,
        chatId,
        status,
        deviceId,
        timestamp: Date.now()
      },
      timestamp: Date.now(),
      id: crypto.randomUUID()
    });
  }
}
