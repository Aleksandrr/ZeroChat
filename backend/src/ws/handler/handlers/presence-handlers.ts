import { prisma } from '../../../prisma/client';
import type { TypingPayload, PresencePayload } from '../../types';
import { WebSocketClient } from '../client';
import { WebSocketManager } from '../../manager';

/**
 * Handle heartbeat message
 */
export function handleHeartbeat(client: WebSocketClient): void {
  prisma.device.updateMany({
    where: { deviceId: client.getDeviceId() },
    data: { lastSeen: new Date() }
  }).catch(console.error);

  client.send({
    type: 'heartbeat',
    success: true,
    timestamp: Date.now()
  });
}

/**
 * Handle ping message (lightweight keep-alive)
 */
export function handlePing(client: WebSocketClient): void {
  // Lightweight ping-pong for connection keep-alive
  client.send({
    type: 'pong',
    timestamp: Date.now()
  });
}

/**
 * Handle typing indicator message
 */
export async function handleTypingMessage(
  payload: TypingPayload,
  sender: WebSocketClient,
  manager: WebSocketManager,
  broadcastPresence: (userId: string, status: 'online' | 'offline') => Promise<void>,
  sendError: (socket: WebSocket, code: string, message: string) => void
): Promise<void> {
  // Validate payload
  if (!payload || typeof payload.chatId === 'undefined') {
    console.warn('[WS] Invalid typing payload:', payload);
    sendError(sender.socket, 'invalid_payload', 'Отсутствует chatId в typing сообщении');
    return;
  }

  // Update lastSeen for the sender
  prisma.device.updateMany({
    where: { deviceId: sender.getDeviceId() },
    data: { lastSeen: new Date() }
  }).catch(console.error);

  // If user is typing, they are online - broadcast presence if needed
  if (payload.isTyping) {
    await broadcastPresence(sender.getUserId(), 'online');
  }

  // Find chat participants to get the recipient
  try {
    const chat = await prisma.chat.findUnique({
      where: { id: payload.chatId },
      select: {
        type: true,
        isGroup: true,
        chatUsers: {
          select: { userId: true }
        }
      }
    });

    if (!chat) {
      console.warn('[WS] Chat not found for typing:', payload.chatId);
      return;
    }

    // For private chats, find the other participant
    if (!chat.isGroup) {
      const recipient = chat.chatUsers.find(cu => cu.userId !== sender.getUserId());

      if (recipient) {
        // Forward typing status to recipient's devices
        const recipientClients = manager.getClientsByUserId(recipient.userId);

        for (const client of recipientClients) {
          client.send({
            type: 'typing',
            payload: {
              chatId: payload.chatId,
              userId: sender.getUserId(),
              isTyping: payload.isTyping
            },
            timestamp: Date.now(),
            id: crypto.randomUUID()
          });
        }
      }
    }
    // For group chats, forward to all participants (except sender)
    else {
      for (const chatUser of chat.chatUsers) {
        if (chatUser.userId === sender.getUserId()) continue;

        const recipientClients = manager.getClientsByUserId(chatUser.userId);
        for (const client of recipientClients) {
          client.send({
            type: 'typing',
            payload: {
              chatId: payload.chatId,
              userId: sender.getUserId(),
              isTyping: payload.isTyping
            },
            timestamp: Date.now(),
            id: crypto.randomUUID()
          });
        }
      }
    }
  } catch (error) {
    console.error('[WS] Error handling typing message:', error);
  }
}

/**
 * Broadcast presence status to all contacts (users who have chats with this user)
 */
export async function broadcastPresence(
  userId: string,
  status: 'online' | 'offline',
  manager: WebSocketManager
): Promise<void> {
  try {
    // Find all users who have chats with this user
    const chats = await prisma.chatUser.findMany({
      where: { userId },
      select: {
        chat: {
          select: {
            chatUsers: {
              select: { userId: true }
            }
          }
        }
      }
    });

    // Collect unique contact user IDs
    const contactUserIds = new Set<string>();
    for (const chatUser of chats) {
      for (const cu of chatUser.chat.chatUsers) {
        if (cu.userId !== userId) {
          contactUserIds.add(cu.userId);
        }
      }
    }

    // Get user's lastSeen for offline status
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { lastSeen: true }
    });

    // Build presence payload
    const presencePayload: PresencePayload = {
      userId,
      status,
      ...(status === 'offline' && user?.lastSeen ? { lastSeen: user.lastSeen.toISOString() } : {})
    };

    // Send presence to all online contacts
    for (const contactUserId of contactUserIds) {
      const contactClients = manager.getClientsByUserId(contactUserId);
      for (const client of contactClients) {
        client.send({
          type: 'presence',
          payload: presencePayload,
          timestamp: Date.now(),
          id: crypto.randomUUID()
        });
      }
    }

  } catch (error) {
    console.error('[Presence] Error broadcasting presence:', error);
  }
}
