import { prisma } from '../../../prisma/client';
import type {
  AckPayload,
  MessageRetryPayload,
  MarkReadPayload,
  ReadEventPayload,
  ReadAckPayload
} from '../../types';
import { WebSocketClient } from '../client';
import { WebSocketManager } from '../../manager';

/**
 * Handle acknowledgment message
 */
export async function handleAckMessage(
  payload: AckPayload,
  client: WebSocketClient,
  manager: WebSocketManager
): Promise<void> {
  try {
    if (payload.chatId) {
      const message = await prisma.message.findUnique({
        where: { id: payload.messageId }
      });

      if (message) {
        const currentMetadata = (message.metadata as Record<string, unknown>) || {};
        await prisma.message.update({
          where: { id: payload.messageId },
          data: {
            metadata: {
              ...currentMetadata,
              ackStatus: payload.status,
              ackDeviceId: client.getDeviceId(),
              ackTimestamp: Date.now()
            }
          }
        });

        // Send ACK to all devices of the message author (except current device)
        const authorClients = manager.getClientsByUserId(message.authorId);
        for (const authorClient of authorClients) {
          if (authorClient.getDeviceId() !== client.getDeviceId()) {
            authorClient.send({
              type: 'ack',
              payload,
              timestamp: Date.now(),
              id: crypto.randomUUID()
            });
          }
        }
      }
    }

  } catch (error) {
    console.error('ACK handling error:', error);
  }
}

/**
 * Handle message retry request
 * When decryption fails, recipient requests sender to resend message with fresh session
 */
export async function handleMessageRetry(
  payload: MessageRetryPayload,
  recipient: WebSocketClient,
  manager: WebSocketManager
): Promise<void> {
  console.log(`[MessageRetry] Received retry request for message ${payload.originalMessageId} from ${recipient.getUserId()}`);

  // Find the original message and get sender
  const originalMessage = await prisma.message.findUnique({
    where: { id: payload.originalMessageId }
  });

  if (!originalMessage) {
    console.warn(`[MessageRetry] Original message ${payload.originalMessageId} not found`);
    recipient.send({
      type: 'error',
      payload: { code: 404, message: 'Original message not found' },
      timestamp: Date.now(),
      id: crypto.randomUUID()
    });
    return;
  }

  const senderId = originalMessage.authorId;

  // Forward retry request to all sender's devices
  const senderClients = manager.getClientsByUserId(senderId);
  if (senderClients.length > 0) {
    for (const senderClient of senderClients) {
      senderClient.send({
        type: 'message_retry',
        payload,
        timestamp: Date.now(),
        id: crypto.randomUUID()
      });
    }
    console.log(`[MessageRetry] Forwarded retry request to ${senderClients.length} device(s) of sender ${senderId}`);
  } else {
    console.log(`[MessageRetry] Sender ${senderId} not online, retry will be handled on next connection`);
  }

  // Acknowledge receipt
  recipient.send({
    type: 'message_retry_ack',
    success: true,
    timestamp: Date.now()
  });
}

/**
 * Handle mark-as-read request
 * Client marks messages as read, server notifies message authors
 */
export async function handleMarkRead(
  payload: MarkReadPayload,
  client: WebSocketClient,
  manager: WebSocketManager
): Promise<void> {
  try {
    const userId = client.getUserId();
    const { chatId, messageIds } = payload;

    // 1. Verify user is participant of the chat
    const chatUser = await prisma.chatUser.findUnique({
      where: { chatId_userId: { chatId, userId } }
    });

    if (!chatUser) {
      client.send({
        type: 'error',
        payload: { code: 403, message: 'Not a participant of this chat' },
        timestamp: Date.now(),
        id: crypto.randomUUID()
      });
      return;
    }

    // Define now early for use in all branches
    const now = new Date();

    // 2. Find messages to mark as read
    // Filter out null/undefined IDs to prevent Prisma validation errors
    const filteredMessageIds = messageIds?.filter(id => id != null) as string[] | undefined;

    const whereClause = filteredMessageIds && filteredMessageIds.length > 0
      ? {
          id: { in: filteredMessageIds },
          chatId,
          authorId: { not: userId } // Can't mark own messages as read
        }
      : {
          chatId,
          authorId: { not: userId },
          readStatuses: { none: { userId } } // Not already read by this user
        };

    const unreadMessages = await prisma.message.findMany({
      where: whereClause,
      select: { id: true, authorId: true }
    });

    if (unreadMessages.length === 0) {
      // No unread messages, but still reset unreadCount and update lastReadAt
      await prisma.chatUser.update({
        where: { chatId_userId: { chatId, userId } },
        data: {
          lastReadAt: now,
          unreadCount: 0
        }
      });

      // Send read_ack to ALL user's devices (multi-device sync)
      const ackPayload: ReadAckPayload = {
        chatId,
        markedCount: 0,
        unreadCount: 0,  // All messages read
        readAt: now.toISOString(),
        messageIds: []
      };
      manager.sendToUser(userId, {
        type: 'read_ack',
        payload: ackPayload,
        timestamp: Date.now(),
        id: crypto.randomUUID()
      });
      return;
    }

    const markedMessageIds = unreadMessages.map(m => m.id);

    // 3. Create read status records (batch)
    await prisma.messageReadStatus.createMany({
      data: unreadMessages.map(m => ({
        messageId: m.id,
        userId,
        readAt: now
      })),
      skipDuplicates: true // Handle idempotency
    });

    // 4. Update ChatUser lastReadAt and unreadCount
    await prisma.chatUser.update({
      where: { chatId_userId: { chatId, userId } },
      data: {
        lastReadAt: now,
        unreadCount: 0 // Reset unread count
      }
    });

    // 5. Send read_ack to ALL devices of the user (multi-device sync)
    const ackPayload: ReadAckPayload = {
      chatId,
      markedCount: markedMessageIds.length,
      unreadCount: 0,  // All messages read after marking
      readAt: now.toISOString(),
      messageIds: markedMessageIds
    };
    // Send to all user's devices, not just the requesting one
    manager.sendToUser(userId, {
      type: 'read_ack',
      payload: ackPayload,
      timestamp: Date.now(),
      id: crypto.randomUUID()
    });

    // 6. Notify message authors (send to ALL devices of each author)
    const authorMessageMap = new Map<string, string[]>();
    for (const msg of unreadMessages) {
      const existing = authorMessageMap.get(msg.authorId) || [];
      existing.push(msg.id);
      authorMessageMap.set(msg.authorId, existing);
    }

    for (const [authorId, msgIds] of authorMessageMap) {
      // Send read event to ALL devices of the author (not just one)
      const readEvent: ReadEventPayload = {
        chatId,
        readBy: userId,
        readAt: now.toISOString(),
        messageIds: msgIds
      };
      manager.sendToUser(authorId, {
        type: 'read',
        payload: readEvent,
        timestamp: Date.now(),
        id: crypto.randomUUID()
      });
    }

  } catch (error) {
    console.error('[MarkRead] Error handling mark_read:', error);
    client.send({
      type: 'error',
      payload: { code: 500, message: 'Failed to mark messages as read' },
      timestamp: Date.now(),
      id: crypto.randomUUID()
    });
  }
}
