import { prisma } from '../../../prisma/client';
import { Prisma } from '@prisma/client';
import type {
  SessionSyncPayload,
  SyncRequestPayload,
  SyncHistoryPayload,
  SyncAckPayload,
  DeviceOnlinePayload
} from '../../types';
import { WebSocketClient } from '../client';
import { WebSocketManager } from '../../manager';

/**
 * Handle session sync notification
 * When a client notifies about session state change, forward to recipient
 *
 * SECURITY: The authenticated WS sender and `payload.userId` (the
 * sync target) must share at least one chat. Otherwise a malicious
 * user could send arbitrary session_sync notifications to any user
 * they know the ID of, even with whom they have no conversation.
 */
export async function handleSessionSync(
  payload: SessionSyncPayload,
  sender: WebSocketClient,
  manager: WebSocketManager
): Promise<void> {
  console.log(`[SessionSync] Received session_sync from ${sender.getUserId()}: ${payload.reason}`);

  // Sender identity verification — sender and target must have a
  // shared chat. We pick any chat that contains the target user
  // AND has the sender as a participant.
  const senderUserId = sender.getUserId();
  let hasSharedChat = false;
  try {
    const shared = await prisma.chatUser.findFirst({
      where: {
        userId: payload.userId,
        chat: { chatUsers: { some: { userId: senderUserId } } },
      },
      select: { userId: true },
    });
    hasSharedChat = !!shared;
  } catch (err) {
    console.error('[SessionSync] Failed to verify shared chat:', err);
    // On DB errors, fail closed — don't forward.
    hasSharedChat = false;
  }

  if (!hasSharedChat) {
    console.warn(
      `[SessionSync] Sender ${senderUserId} has no shared chat with target ${payload.userId} — dropping`,
    );
    sender.send({
      type: 'error',
      payload: { code: 'SENDER_MISMATCH', message: 'Sender identity mismatch' },
      timestamp: Date.now(),
      id: crypto.randomUUID(),
    });
    return;
  }

  // Find recipient and forward session sync
  const recipientClient = manager.getClientByUserId(payload.userId);

  if (recipientClient) {
    recipientClient.send({
      type: 'session_sync',
      payload,
      timestamp: Date.now(),
      id: crypto.randomUUID()
    });
    console.log(`[SessionSync] Forwarded session_sync to ${payload.userId}`);
  } else {
    console.log(`[SessionSync] Recipient ${payload.userId} not online, session sync will be handled on next connection`);
  }

  // Acknowledge receipt
  sender.send({
    type: 'session_sync_ack',
    success: true,
    timestamp: Date.now()
  });
}

/**
 * Handle sync request from a new device
 * New device requests history from active devices of the same user
 * Server routes the request to online devices, stores for offline devices
 *
 * Two-phase sync: If targetDeviceId is specified, only route to that specific device
 */
export async function handleSyncRequest(
  payload: SyncRequestPayload,
  client: WebSocketClient,
  manager: WebSocketManager
): Promise<void> {
  const userId = client.getUserId();
  const requestingDeviceId = payload.requestingDeviceId;
  const targetDeviceId = (payload as any).targetDeviceId; // For two-phase sync

  console.log('[SyncRequest] Received from:', requestingDeviceId, 'target:', targetDeviceId || 'all');

  try {
    // Verify the requesting device belongs to this user
    const device = await prisma.device.findFirst({
      where: {
        deviceId: requestingDeviceId,
        userId,
        isActive: true
      }
    });

    if (!device) {
      client.send({
        type: 'error',
        payload: { code: 403, message: 'Device not authorized for sync' },
        timestamp: Date.now(),
        id: crypto.randomUUID()
      });
      return;
    }

    // Get Signal device ID for the requesting device
    const requestingSignalDeviceId = device.signalDeviceId;

    // Two-phase sync: If targetDeviceId is specified, only route to that device
    if (targetDeviceId) {
      const targetClient = manager.getClientsByUserId(userId)
        .find(c => c.getDeviceId() === targetDeviceId);

      if (targetClient) {
        console.log('[SyncRequest] Forwarding to specific target device:', targetDeviceId);
        targetClient.send({
          type: 'sync_request',
          payload: {
            requestingDeviceId,
            requestingSignalDeviceId,
            vectorClock: payload.vectorClock,
            requestingDeviceName: device.name || 'New Device'
          },
          timestamp: Date.now(),
          id: crypto.randomUUID()
        });

        // Acknowledge the sync request
        client.send({
          type: 'sync_request_ack',
          payload: {
            status: 'forwarded',
            onlineDevicesCount: 1,
            offlineDevicesCount: 0,
            targetDeviceId
          },
          timestamp: Date.now(),
          id: crypto.randomUUID()
        });
      } else {
        console.log('[SyncRequest] Target device not online:', targetDeviceId);
        client.send({
          type: 'sync_response',
          payload: {
            status: 'target_offline',
            message: 'Target device is not online'
          },
          timestamp: Date.now(),
          id: crypto.randomUUID()
        });
      }
      return;
    }

    // Legacy mode: Get all other devices of this user
    const otherDevices = await prisma.device.findMany({
      where: {
        userId,
        isActive: true,
        deviceId: { not: requestingDeviceId }
      },
      select: { deviceId: true, name: true }
    });

    if (otherDevices.length === 0) {
      client.send({
        type: 'sync_response',
        payload: {
          status: 'no_devices',
          message: 'No other devices available for sync'
        },
        timestamp: Date.now(),
        id: crypto.randomUUID()
      });
      return;
    }

    // Find online devices (excluding the requesting device)
    const onlineDevices = manager.getClientsByUserId(userId)
      .filter(c => c.getDeviceId() !== requestingDeviceId);

    // Forward sync request to all online devices
    for (const onlineClient of onlineDevices) {
      onlineClient.send({
        type: 'sync_request',
        payload: {
          requestingDeviceId,
          requestingSignalDeviceId,
          vectorClock: payload.vectorClock,
          requestingDeviceName: device.name || 'New Device'
        },
        timestamp: Date.now(),
        id: crypto.randomUUID()
      });
    }

    // Store sync request for offline devices
    const offlineDeviceIds = otherDevices
      .filter(d => !onlineDevices.some(c => c.getDeviceId() === d.deviceId))
      .map(d => d.deviceId);

    if (offlineDeviceIds.length > 0) {
      // Store as a special sync event that will be processed when device comes online
      await prisma.syncEvent.createMany({
        data: offlineDeviceIds.map(deviceId => ({
          userId,
          deviceId: requestingDeviceId,  // Who is requesting
          seq: 0,
          entity: 'sync_request',
          entityId: requestingDeviceId,
          op: 'sync_request',
          version: 0,
          payloadCiphertext: JSON.stringify({
            requestingDeviceId,
            vectorClock: payload.vectorClock,
            targetDeviceId: deviceId
          })
        }))
      });
    }

    // Acknowledge the sync request
    client.send({
      type: 'sync_request_ack',
      payload: {
        status: 'forwarded',
        onlineDevicesCount: onlineDevices.length,
        offlineDevicesCount: offlineDeviceIds.length
      },
      timestamp: Date.now(),
      id: crypto.randomUUID()
    });

  } catch (error) {
    console.error('[SyncRequest] Error handling sync request:', error);
    client.send({
      type: 'error',
      payload: { code: 500, message: 'Failed to process sync request' },
      timestamp: Date.now(),
      id: crypto.randomUUID()
    });
  }
}

/**
 * Handle sync history response from an active device
 * Active device sends encrypted history to the requesting device
 * Server only routes the encrypted envelope (zero-knowledge)
 */
export async function handleSyncHistory(
  payload: SyncHistoryPayload,
  sender: WebSocketClient,
  manager: WebSocketManager
): Promise<void> {
  const senderUserId = sender.getUserId();
  const senderDeviceId = payload.senderDeviceId;
  const targetDeviceId = payload.targetDeviceId;

  console.log(`[SyncHistory] Device ${senderDeviceId} sends history to ${targetDeviceId}`);
  console.log(`[SyncHistory] Encrypted payload size: ${payload.encryptedHistory?.length || 0} bytes`);

  try {
    // Verify sender owns this device
    const senderDevice = await prisma.device.findFirst({
      where: {
        deviceId: senderDeviceId,
        userId: senderUserId,
        isActive: true
      }
    });

    if (!senderDevice) {
      sender.send({
        type: 'error',
        payload: { code: 403, message: 'Device not authorized' },
        timestamp: Date.now(),
        id: crypto.randomUUID()
      });
      return;
    }

    // Verify target device belongs to same user
    const targetDevice = await prisma.device.findFirst({
      where: {
        deviceId: targetDeviceId,
        userId: senderUserId,
        isActive: true
      }
    });

    if (!targetDevice) {
      sender.send({
        type: 'error',
        payload: { code: 404, message: 'Target device not found' },
        timestamp: Date.now(),
        id: crypto.randomUUID()
      });
      return;
    }

    // Find target device client (if online)
    const targetClient = manager.getClient(targetDeviceId);

    if (targetClient && targetClient.isOpen()) {
      // Target is online - forward the encrypted history
      targetClient.send({
        type: 'sync_history',
        payload: {
          senderDeviceId,
          senderSignalDeviceId: payload.senderSignalDeviceId || senderDevice.signalDeviceId,
          senderDeviceName: senderDevice.name || 'Device',
          encryptedHistory: payload.encryptedHistory,
          vectorClock: payload.vectorClock
        },
        timestamp: Date.now(),
        id: crypto.randomUUID()
      });

      // Acknowledge to sender
      sender.send({
        type: 'sync_history_ack',
        payload: {
          targetDeviceId,
          status: 'delivered'
        },
        timestamp: Date.now(),
        id: crypto.randomUUID()
      });
    } else {
      // Target is offline - store for later delivery
      await prisma.syncEvent.create({
        data: {
          userId: senderUserId,
          deviceId: senderDeviceId,
          seq: Math.floor(Date.now() / 1000), // Use timestamp in seconds as sequence for sync history
          entity: 'sync_history',
          entityId: targetDeviceId,
          op: 'sync_history',
          version: 0,
          payloadCiphertext: JSON.stringify({
            senderDeviceId,
            encryptedHistory: payload.encryptedHistory,
            vectorClock: payload.vectorClock
          })
        }
      });

      // Acknowledge to sender
      sender.send({
        type: 'sync_history_ack',
        payload: {
          targetDeviceId,
          status: 'stored'
        },
        timestamp: Date.now(),
        id: crypto.randomUUID()
      });
    }

  } catch (error) {
    console.error('[SyncHistory] Error handling sync history:', error);
    sender.send({
      type: 'error',
      payload: { code: 500, message: 'Failed to process sync history' },
      timestamp: Date.now(),
      id: crypto.randomUUID()
    });
  }
}

/**
 * Handle sync acknowledgment from receiving device
 * Confirms successful receipt and application of history
 */
export async function handleSyncAck(
  payload: SyncAckPayload,
  client: WebSocketClient,
  manager: WebSocketManager
): Promise<void> {
  const userId = client.getUserId();
  const deviceId = payload.deviceId;

  try {
    // Verify device belongs to this user
    const device = await prisma.device.findFirst({
      where: {
        deviceId,
        userId,
        isActive: true
      }
    });

    if (!device) {
      return;
    }

    // Delete delivered sync events (sync history stored for this device)
    await prisma.syncEvent.deleteMany({
      where: {
        userId,
        entityId: deviceId,
        op: 'sync_history'
      }
    });

    // Delete sync requests from this device
    await prisma.syncEvent.deleteMany({
      where: {
        userId,
        deviceId,
        op: 'sync_request'
      }
    });

    // Notify other devices that sync completed
    const otherDevices = manager.getClientsByUserId(userId)
      .filter(c => c.getDeviceId() !== deviceId);

    for (const otherClient of otherDevices) {
      otherClient.send({
        type: 'sync_complete',
        payload: {
          deviceId,
          vectorClock: payload.newVectorClock
        },
        timestamp: Date.now(),
        id: crypto.randomUUID()
      });
    }

    // Acknowledge
    client.send({
      type: 'sync_ack_ack',
      payload: { status: 'confirmed' },
      timestamp: Date.now(),
      id: crypto.randomUUID()
    });

  } catch (error) {
    console.error('[SyncAck] Error handling sync ack:', error);
  }
}

/**
 * Handle device online notification
 * Notifies other devices about new device coming online
 * Also checks for pending sync requests
 */
export async function handleDeviceOnline(
  payload: DeviceOnlinePayload,
  client: WebSocketClient,
  manager: WebSocketManager
): Promise<void> {
  const userId = client.getUserId();
  const deviceId = payload.deviceId;

  try {
    // Verify device belongs to this user
    const device = await prisma.device.findFirst({
      where: {
        deviceId,
        userId,
        isActive: true
      }
    });

    if (!device) {
      return;
    }

    // Notify other devices about this device coming online
    const otherDevices = manager.getClientsByUserId(userId)
      .filter(c => c.getDeviceId() !== deviceId);

    for (const otherClient of otherDevices) {
      otherClient.send({
        type: 'device_online',
        payload: {
          userId,
          deviceId,
          signalDeviceId: device.signalDeviceId,
          deviceName: device.name || 'Device'
        },
        timestamp: Date.now(),
        id: crypto.randomUUID()
      });
    }

    // Check for pending sync requests for this device
    const pendingSyncRequests = await prisma.syncEvent.findMany({
      where: {
        userId,
        entityId: deviceId,
        op: 'sync_request'
      }
    });

    if (pendingSyncRequests.length > 0) {
      // Notify this device about pending sync requests
      for (const request of pendingSyncRequests) {
        const requestData = JSON.parse(request.payloadCiphertext);
        client.send({
          type: 'sync_request',
          payload: {
            requestingDeviceId: requestData.requestingDeviceId,
            vectorClock: requestData.vectorClock
          },
          timestamp: Date.now(),
          id: crypto.randomUUID()
        });
      }
    }

    // Check for pending sync history for this device
    const pendingSyncHistory = await prisma.syncEvent.findMany({
      where: {
        userId,
        entityId: deviceId,
        op: 'sync_history'
      }
    });

    if (pendingSyncHistory.length > 0) {
      for (const history of pendingSyncHistory) {
        const historyData = JSON.parse(history.payloadCiphertext);
        client.send({
          type: 'sync_history',
          payload: {
            senderDeviceId: historyData.senderDeviceId,
            encryptedHistory: historyData.encryptedHistory,
            vectorClock: historyData.vectorClock
          },
          timestamp: Date.now(),
          id: crypto.randomUUID()
        });
      }
    }

    // Check for pending messages for this device
    // Pending messages are stored with encrypted=true and metadata.pendingDeviceId
    const pendingMessages = await prisma.message.findMany({
      where: {
        encrypted: true,
        metadata: {
          not: Prisma.JsonNull
        }
      },
      orderBy: { createdAt: 'asc' }
    });

    // Filter messages that have pendingDeviceId matching this device
    const messagesForThisDevice = pendingMessages.filter(msg => {
      const metadata = msg.metadata as Record<string, unknown> | null;
      return metadata && metadata['pendingDeviceId'] === deviceId;
    });

    if (messagesForThisDevice.length > 0) {
      console.log(`[DeviceOnline] Found ${messagesForThisDevice.length} pending messages for device ${deviceId}`);
      
      for (const message of pendingMessages) {
        const metadata = message.metadata as Record<string, unknown>;
        // FIX: recipientDeviceId is stored as a number (see
        // multi-device-handlers.ts:345 where `encryptedMsg.deviceId` is
        // a number), not a string. Cast correctly and silence the
        // unused-var warning by prefixing with underscore.
        const _recipientDeviceId = metadata['recipientDeviceId'] as number;
        void _recipientDeviceId;
        const senderDeviceId = metadata['senderDeviceId'] as number;
        const originalMessageId = metadata['originalMessageId'] as string;
        const isSelfDelivery = metadata['isSelfDelivery'] as boolean;
        
        // Send the pending message to the device
        client.send({
          type: 'message',
          payload: {
            chatId: message.chatId,
            senderId: message.authorId,
            senderUsername: '', // Will be resolved by frontend
            senderDeviceId: senderDeviceId,
            content: message.content,
            messageId: originalMessageId,
            timestamp: message.createdAt.getTime(),
            messageType: metadata['messageType'] as number,
            replyTo: metadata['replyTo'],
            attachments: metadata['attachments'],
            unreadCount: 1,
            isSelfDelivery: isSelfDelivery,
            isPending: true,
            metadata: metadata
          },
          timestamp: Date.now(),
          id: crypto.randomUUID()
        });
        
        console.log(`[DeviceOnline] Sent pending message ${originalMessageId} to device ${deviceId}`);
      }
      
      // Delete delivered pending messages
      await prisma.message.deleteMany({
        where: {
          id: { in: messagesForThisDevice.map(m => m.id) }
        }
      });
      
      console.log(`[DeviceOnline] Deleted ${messagesForThisDevice.length} delivered pending messages`);
    }

  } catch (error) {
    console.error('[DeviceOnline] Error handling device online:', error);
  }
}

/**
 * Notify other devices when a device comes online
 * Called automatically from handleConnection
 */
export async function notifyDeviceOnline(
  client: WebSocketClient,
  manager: WebSocketManager
): Promise<void> {
  const userId = client.getUserId();
  const deviceId = client.getDeviceId();
  const signalDeviceId = client.getSignalDeviceId();

  try {
    // Get device info
    const device = await prisma.device.findFirst({
      where: {
        deviceId,
        userId,
        isActive: true
      }
    });

    if (!device) {
      return;
    }

    // Notify other devices of the same user
    const otherDevices = manager.getClientsByUserId(userId)
      .filter(c => c.getDeviceId() !== deviceId);

    for (const otherClient of otherDevices) {
      otherClient.send({
        type: 'device_online',
        payload: {
          userId,
          deviceId,
          signalDeviceId,
          deviceName: device.name || 'Device'
        },
        timestamp: Date.now(),
        id: crypto.randomUUID()
      });
    }

    // Check for pending sync requests FOR this device (other devices want history from it)
    const pendingRequestsForDevice = await prisma.syncEvent.findMany({
      where: {
        userId,
        entityId: deviceId,
        op: 'sync_request'
      }
    });

    if (pendingRequestsForDevice.length > 0) {
      for (const request of pendingRequestsForDevice) {
        const requestData = JSON.parse(request.payloadCiphertext);
        client.send({
          type: 'sync_request',
          payload: {
            requestingDeviceId: requestData.requestingDeviceId,
            vectorClock: requestData.vectorClock
          },
          timestamp: Date.now(),
          id: crypto.randomUUID()
        });
      }
    }

    // Check for pending sync history FOR this device (this device requested history)
    const pendingHistoryForDevice = await prisma.syncEvent.findMany({
      where: {
        userId,
        entityId: deviceId,
        op: 'sync_history'
      }
    });

    if (pendingHistoryForDevice.length > 0) {
      for (const history of pendingHistoryForDevice) {
        const historyData = JSON.parse(history.payloadCiphertext);
        client.send({
          type: 'sync_history',
          payload: {
            senderDeviceId: historyData.senderDeviceId,
            encryptedHistory: historyData.encryptedHistory,
            vectorClock: historyData.vectorClock
          },
          timestamp: Date.now(),
          id: crypto.randomUUID()
        });
      }
    }

  } catch (error) {
    console.error('[DeviceOnline] Error notifying device online:', error);
  }
}

/**
 * Handle client ready notification
 * Called when frontend ChatContext has subscribed to WebSocket events
 * This fixes race condition where pending messages were sent before subscription
 *
 * RC-8 fix: Added isProcessingReady flag to prevent duplicate calls
 */
export async function handleClientReady(
  client: WebSocketClient,
  sendPendingMessagesFn: (client: WebSocketClient) => Promise<void>
): Promise<void> {
  // RC-8 fix: Prevent duplicate calls
  if (client.isProcessingReady) {
    console.log(`[handleClientReady] Client ${client.getDeviceId()} already processing ready, skipping`);
    return;
  }

  client.isProcessingReady = true;
  try {
    console.log(`[handleClientReady] Client ${client.getDeviceId()} is ready, sending pending messages`);
    await sendPendingMessagesFn(client);
  } finally {
    client.isProcessingReady = false;
  }
}

/**
 * Send pending messages that were queued while user was offline
 * Supports Sesame self-delivery: messages can be for this user as recipient OR as sender
 */
export async function sendPendingMessages(
  client: WebSocketClient,
  _manager: WebSocketManager
): Promise<void> {
  const userId = client.getUserId();
  const deviceId = client.getDeviceId();

  console.log(`[sendPendingMessages] START - userId: ${userId}, deviceId: ${deviceId}`);
  console.log(`[sendPendingMessages] Client socket state:`, client.isOpen());

  try {
    // Find all chats where user is a participant
    const userChats = await prisma.chatUser.findMany({
      where: { userId },
      select: { chatId: true }
    });

    const chatIds = userChats.map(uc => uc.chatId);

    console.log(`[sendPendingMessages] Found ${chatIds.length} chats for user`);

    if (chatIds.length === 0) {
      console.log(`[sendPendingMessages] No chats found, returning`);
      return;
    }

    // Find messages in user's chats that need to be delivered
    // Two cases per Sesame:
    // 1. Messages where this user is the recipient (recipientId matches)
    // 2. Messages where this user is the sender (self-delivery to other devices)
    // 3. System messages with pendingDeviceId (for offline delivery)
    // We fetch all messages and filter in memory for simplicity
    const allMessages = await prisma.message.findMany({
      where: {
        chatId: { in: chatIds },
      },
      include: {
        author: {
          select: { username: true }
        }
      },
      orderBy: { createdAt: 'asc' },
      take: 100 // Limit to prevent overwhelming the client
    });

    console.log(`[sendPendingMessages] Found ${allMessages.length} encrypted messages`);

    // Filter messages that haven't been delivered to this device
    const pendingMessages = allMessages.filter(msg => {
      const metadata = msg.metadata as Record<string, unknown> | null;
      const recipientId = metadata?.['recipientId'] as string | undefined;
      const deliveredTo = (metadata?.['deliveredTo'] as string[]) || [];
      const pendingDeviceId = metadata?.['pendingDeviceId'] as string | undefined;
      const isSelfDelivery = metadata?.['isSelfDelivery'] as boolean | undefined;
      const isGroupPending = metadata?.['isGroupPending'] as boolean | undefined;
      const isSystem = metadata?.['isSystem'] as boolean | undefined;

      // DEBUG: Log each message's metadata
      console.log(`[sendPendingMessages] Message ${msg.id}:`, {
        pendingDeviceId,
        deviceId,
        match: pendingDeviceId === deviceId,
        deliveredTo,
        notDelivered: !deliveredTo.includes(deviceId),
        recipientId,
        userId,
        isSelfDelivery,
        isGroupPending,
        isSystem,
        authorId: msg.authorId
      });

      // Check if this specific device is the intended recipient of this pending message
      // pendingDeviceId contains the UUID of the device this message is stored for
      if (pendingDeviceId === deviceId && !deliveredTo.includes(deviceId)) {
        // Case 1: Regular encrypted message to this user
        if (recipientId === userId && !isSelfDelivery && !isSystem) {
          console.log(`[sendPendingMessages] ✓ Message ${msg.id} matched as regular message`);
          return true;
        }
        // Case 2: Self-delivery (this user is the sender, message for their other device)
        if (isSelfDelivery && msg.authorId === userId) {
          console.log(`[sendPendingMessages] ✓ Message ${msg.id} matched as self-delivery`);
          return true;
        }
        // Case 3: Group message for this user's device
        if (isGroupPending) {
          console.log(`[sendPendingMessages] ✓ Message ${msg.id} matched as group message`);
          return true;
        }
        // Case 4: System message (non-encrypted, for device-specific delivery)
        if (isSystem && msg.encrypted === false) {
          console.log(`[sendPendingMessages] ✓ Message ${msg.id} matched as system message`);
          return true;
        }
      }

      return false;
    });

    console.log(`[sendPendingMessages] Filtered: ${pendingMessages.length} pending messages for device ${deviceId}`);

    // Send each pending message
    for (const msg of pendingMessages) {
      console.log(`[sendPendingMessages] PROCESSING message ${msg.id} to device ${deviceId}`);
      const metadata = msg.metadata as Record<string, unknown> | null;
      const messageType = metadata?.['messageType'] as number | undefined;
      const senderDeviceId = metadata?.['senderDeviceId'] as number | undefined;
      const msgIsSelfDelivery = metadata?.['isSelfDelivery'] as boolean | undefined;
      const isGroupPending = metadata?.['isGroupPending'] as boolean | undefined;
      const senderKeyDistribution = metadata?.['senderKeyDistribution'] as string | undefined;
      const isSystem = metadata?.['isSystem'] as boolean | undefined;
      // Get author username from included author relation
      const authorUsername = (msg as any).author?.username || 'ZeroChat';

      // Determine message type based on metadata
      const isGroupMessage = isGroupPending || messageType === 4; // 4 = SenderKey message type

      // Get current unread count for the chat
      const chatUser = await prisma.chatUser.findUnique({
        where: {
          chatId_userId: {
            chatId: msg.chatId,
            userId: userId
          }
        },
        select: { unreadCount: true }
      });
      const unreadCount = chatUser?.unreadCount ?? 1;

      let sentMessage: { type: string; payload: unknown; timestamp: number; id: string };

        if (isGroupMessage) {
          // Send as group_message
          // Use msg.authorId as senderUserId (stored as authorId in the message)
          const senderUserId = msg.authorId;
          const msgIsSelfDelivery = metadata?.['isSelfDelivery'] as boolean | undefined;
          sentMessage = {
            type: 'group_message',
            payload: {
              chatId: msg.chatId,
              senderUserId: senderUserId,
              senderDeviceId: senderDeviceId || 0,
              content: msg.content,
              messageId: msg.id,
              timestamp: msg.createdAt.getTime(),
              senderKeyId: metadata?.['senderKeyId'] || '',
              senderKeyDistribution: senderKeyDistribution,
              isPending: true, // Flag to indicate this is a pending message
              isSelfDelivery: msgIsSelfDelivery || false, // Flag for self-delivery
              unreadCount: msgIsSelfDelivery ? 0 : unreadCount,
              // Include client-provided metadata (e.g., forwardedFrom, replyTo)
              metadata: metadata as Record<string, unknown> | null
            },
            timestamp: Date.now(),
            id: crypto.randomUUID()
          };
        } else if (isSystem) {
         // Send as system message (non-encrypted)
         sentMessage = {
           type: 'message',
           payload: {
             chatId: msg.chatId,
             senderId: msg.authorId,
             senderUsername: authorUsername,
             senderDeviceId: 0, // System bot has no device
             content: msg.content,
             messageId: msg.id,
             timestamp: msg.createdAt.getTime(),
             messageType: 0, // Text message
             encrypted: false,
             metadata: metadata as Record<string, unknown>,
             isPending: true,
             isSystem: true,
             unreadCount: unreadCount
           },
           timestamp: Date.now(),
           id: crypto.randomUUID()
         };
        } else {
          // Send as regular encrypted message
          sentMessage = {
            type: 'message',
            payload: {
              chatId: msg.chatId,
              senderId: msg.authorId,
              senderUsername: authorUsername,
              senderDeviceId: senderDeviceId || 0,
              content: msg.content,
              messageId: msg.id,
              timestamp: msg.createdAt.getTime(),
              messageType: messageType || 2,
              isPending: true, // Flag to indicate this is a pending message
              isSelfDelivery: msgIsSelfDelivery || false, // Flag for self-delivery (Sesame protocol)
              unreadCount: msgIsSelfDelivery ? 0 : unreadCount,
              // Include client-provided metadata (e.g., forwardedFrom, replyTo)
              metadata: metadata as Record<string, unknown> | null
            },
            timestamp: Date.now(),
            id: crypto.randomUUID()
          };
        }

      console.log(`[sendPendingMessages] Prepared message:`, {
        messageId: msg.id,
        type: sentMessage.type,
        senderId: (sentMessage.payload as any).senderId,
        senderUsername: (sentMessage.payload as any).senderUsername,
        hasContent: !!(sentMessage.payload as any).content
      });

      // ACK-based delivery: mark message as "delivering" by adding
      // deviceId to `deliveredTo` array in metadata. The message is
      // NOT deleted yet — deletion happens only when the client
      // sends `message_ack` after successfully decrypting + storing
      // the message in IndexedDB.
      //
      // This prevents message loss if:
      //   - WS connection drops between send() and client processing
      //   - Client fails to decrypt (Signal session broken)
      //   - Client IndexedDB write fails (quota exceeded)
      //   - Client JS crashes during message handling
      //
      // On the next reconnect, `sendPendingMessages` skips messages
      // where `deliveredTo` already contains this deviceId (see filter
      // at line ~832: `!deliveredTo.includes(deviceId)`).
      try {
        const deliveredTo = (metadata?.['deliveredTo'] as string[]) || [];
        if (!deliveredTo.includes(deviceId)) {
          deliveredTo.push(deviceId);
        }
        await prisma.message.update({
          where: { id: msg.id },
          data: {
            metadata: {
              ...metadata,
              deliveredTo,
              deliveredAt: Date.now(),
            } as any,
          },
        });
        console.log(`[sendPendingMessages] Marked message ${msg.id} as delivering to ${deviceId}`);
      } catch (e: unknown) {
        const prismaError = e as { code?: string };
        if (prismaError.code === 'P2025') {
          // Already deleted by another parallel call — skip
          console.log(`[sendPendingMessages] Message ${msg.id} already claimed, skipping`);
          continue;
        }
        throw e;
      }

      // Now send — message is claimed (deliveredTo updated) but NOT deleted.
      // Client will send `message_ack` after successful processing.
      const sent = client.send(sentMessage);
      if (!sent) {
        console.warn(`[sendPendingMessages] Client ${deviceId} socket closed after marking message ${msg.id}`);
        // Message stays in DB with deliveredTo=[deviceId]. On next
        // reconnect, the filter `!deliveredTo.includes(deviceId)` will
        // SKIP it (already "delivered"). This is a trade-off: we'd
        // rather risk a duplicate (if client DID receive it just before
        // socket closed) than lose the message entirely.
        //
        // To handle the "socket closed before client received" case,
        // we RESET deliveredTo on reconnect (see handleClientReady
        // below — messages with stale deliveredAt timestamp are
        // re-delivered).
      } else {
        console.log(`[sendPendingMessages] Delivered pending message ${msg.id} to device ${deviceId}`);
      }
    }

    // Notify client about pending messages count
    if (pendingMessages.length > 0) {
      client.send({
        type: 'pending_messages',
        payload: {
          count: pendingMessages.length
        },
        timestamp: Date.now(),
        id: crypto.randomUUID()
      });
    }

    // Send pending commands (for offline command delivery)
    const pendingCommands = await prisma.pendingCommand.findMany({
      where: {
        userId: client.getUserId(),
        deviceId: client.getDeviceId()
      },
      orderBy: {
        createdAt: 'asc'
      },
      take: 100 // Limit to prevent overwhelming the client
    });

    console.log(`[sendPendingMessages] Found ${pendingCommands.length} pending commands for device ${deviceId}`);

    for (const cmd of pendingCommands) {
      try {
        // Extract issuer from metadata or fallback to stored userId/deviceId
        let issuer: { userId: string; deviceId: string };
        if (cmd.metadata && typeof cmd.metadata === 'object' && 'issuer' in cmd.metadata) {
          issuer = (cmd.metadata as any).issuer;
        } else {
          issuer = { userId: cmd.userId, deviceId: cmd.deviceId };
        }

        // Send command event
        client.send({
          type: 'command_event',
          payload: {
            commandId: cmd.id.startsWith('cmd-') ? cmd.id.substring(4) : cmd.id, // Remove 'cmd-' prefix
            commandType: cmd.commandType,
            issuer,
            timestamp: Date.now(),
            payload: cmd.payload,
            result: null
          },
          timestamp: Date.now(),
          id: crypto.randomUUID()
        });

        // Delete pending command (claim it)
        await prisma.pendingCommand.delete({
          where: { id: cmd.id }
        });
        console.log(`[sendPendingMessages] Delivered pending command ${cmd.id} to device ${deviceId}`);
      } catch (error) {
        console.error(`[sendPendingMessages] Failed to deliver pending command ${cmd.id}:`, error);
      }
    }

    // Notify client about pending commands count
    if (pendingCommands.length > 0) {
      client.send({
        type: 'pending_commands',
        payload: {
          count: pendingCommands.length
        },
        timestamp: Date.now(),
        id: crypto.randomUUID()
      });
    }

  } catch (error) {
    console.error('[WS] Error sending pending messages:', error);
  }
}

/**
 * Handle `message_ack` — client confirms successful receipt + processing
 * of a pending message. Server deletes the pending message from DB.
 *
 * ACK flow:
 *   1. Server sends pending message via WS, marks `deliveredTo=[deviceId]`
 *   2. Client receives, decrypts, stores in IndexedDB
 *   3. Client sends `message_ack { messageId }` back to server
 *   4. Server receives ACK → deletes pending message from DB
 *
 * If ACK never arrives (client crashed, WS dropped), the message stays
 * in DB with `deliveredTo=[deviceId]`. On next reconnect:
 *   - If `deliveredAt` is older than ACK_TIMEOUT_MS (5 min), reset
 *     `deliveredTo` and re-deliver (see `resetStaleDelivering` below).
 *   - If recent, skip (client likely already processed it, ACK was lost).
 *
 * SECURITY: Only the device that the message was addressed to
 * (`metadata.pendingDeviceId`) can ACK it. Verified via `sender.getDeviceId()`.
 */
const ACK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export async function handleMessageAck(
  payload: { messageId?: string },
  sender: WebSocketClient,
  _manager: WebSocketManager
): Promise<void> {
  const { messageId } = payload;
  if (!messageId) {
    console.warn('[MessageAck] Missing messageId in payload');
    return;
  }

  const deviceId = sender.getDeviceId();
  const userId = sender.getUserId();

  try {
    // Find the pending message
    const message = await prisma.message.findUnique({
      where: { id: messageId },
      select: { id: true, metadata: true, authorId: true },
    });

    if (!message) {
      // Already deleted (duplicate ACK) — no-op
      console.log(`[MessageAck] Message ${messageId} not found (already ACKed or never existed)`);
      return;
    }

    const metadata = message.metadata as Record<string, unknown> | null;
    if (!metadata) {
      console.warn(`[MessageAck] Message ${messageId} has no metadata — deleting anyway`);
      await prisma.message.delete({ where: { id: messageId } });
      return;
    }

    // SECURITY: Only the device that the message was addressed to can ACK it
    const pendingDeviceId = metadata['pendingDeviceId'] as string | undefined;
    if (pendingDeviceId && pendingDeviceId !== deviceId) {
      console.warn(`[MessageAck] Device ${deviceId} tried to ACK message ${messageId} addressed to ${pendingDeviceId} — rejected`);
      return;
    }

    // Delete the pending message — client confirmed receipt
    await prisma.message.delete({ where: { id: messageId } });
    console.log(`[MessageAck] Deleted pending message ${messageId} (ACKed by device ${deviceId}, user ${userId})`);
  } catch (error) {
    const prismaError = error as { code?: string };
    if (prismaError.code === 'P2025') {
      // Already deleted — duplicate ACK, no-op
      console.log(`[MessageAck] Message ${messageId} already deleted (duplicate ACK)`);
      return;
    }
    console.error(`[MessageAck] Error processing ACK for ${messageId}:`, error);
  }
}

/**
 * Reset `deliveredTo` for messages that were marked as "delivering" but
 * never ACKed within ACK_TIMEOUT_MS. Called on each reconnect to ensure
 * stale delivering messages are re-delivered.
 *
 * This handles the case where:
 *   - Server sent message, marked deliveredTo=[deviceId]
 *   - Client never received it (WS dropped right after send)
 *   - Client reconnects
 *   - Without this reset, the message would be stuck forever
 *
 * Strategy: messages with `deliveredAt` older than ACK_TIMEOUT_MS get
 * their `deliveredTo` array cleared (removed deviceId), so they become
 * eligible for re-delivery on the next sendPendingMessages call.
 */
export async function resetStaleDelivering(deviceId: string): Promise<void> {
  const cutoff = Date.now() - ACK_TIMEOUT_MS;

  try {
    // Find messages where deliveredTo contains this deviceId AND
    // deliveredAt is older than cutoff
    const staleMessages = await prisma.message.findMany({
      where: {
        encrypted: true,
        metadata: { not: Prisma.JsonNull },
      },
      select: { id: true, metadata: true },
    });

    for (const msg of staleMessages) {
      const metadata = msg.metadata as Record<string, unknown> | null;
      if (!metadata) continue;

      const deliveredTo = (metadata['deliveredTo'] as string[]) || [];
      const deliveredAt = metadata['deliveredAt'] as number | undefined;

      if (deliveredTo.includes(deviceId) && deliveredAt && deliveredAt < cutoff) {
        // Reset: remove this deviceId from deliveredTo
        const newDeliveredTo = deliveredTo.filter(id => id !== deviceId);
        await prisma.message.update({
          where: { id: msg.id },
          data: {
            metadata: {
              ...metadata,
              deliveredTo: newDeliveredTo,
              deliveredAt: null,
            } as any,
          },
        });
        console.log(`[resetStaleDelivering] Reset stale delivery for message ${msg.id} (device ${deviceId})`);
      }
    }
  } catch (error) {
    console.error('[resetStaleDelivering] Error:', error);
  }
}
