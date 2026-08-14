import { prisma } from '../../../prisma/client';
import type { MultiDeviceMessagePayload, FavoritesMessagePayload, FileRateLimitErrorDetails, PayloadSizeErrorDetails } from '../../types';
import { WebSocketClient } from '../client';
import { WebSocketManager } from '../../manager';
import { checkQuotaForBatch, getUserStorageQuota, formatBytes } from '../../../services/storage-quota';
import {
  checkFileRateLimit,
  hasAttachments,
  getMessageSize,
  FILE_RATE_LIMITS
} from '../../../middleware/message-validation';
import { config } from '../../../config';

/**
 * Handle multi-device message (Sesame protocol)
 * Each device receives its own encrypted copy of the message
 */
export async function handleMultiDeviceMessage(
  payload: MultiDeviceMessagePayload,
  sender: WebSocketClient,
  manager: WebSocketManager,
  _sendDeliveryStatus: (
    client: WebSocketClient,
    messageId: string,
    chatId: string,
    status: 'sent' | 'delivered' | 'read' | 'failed',
    deviceId?: number | string
  ) => void
): Promise<void> {
  try {
    if (!payload || !payload.chatId || !payload.recipientId || !payload.recipientMessages?.length) {
      console.warn('[WS] Invalid multi_device_message payload:', payload);
      return;
    }

     const senderUserId = sender.getUserId();

     // SECURITY: Sender & recipient must BOTH be participants of
     // payload.chatId. Without this check, a malicious user could
     // send multi-device messages into chats they don't belong to
     // (or impersonate other users by setting an arbitrary
     // recipientId). We use the authoritative senderUserId from the
     // authenticated WS session, NOT a client-supplied field.
     const [senderMembership, recipientMembership] = await Promise.all([
       prisma.chatUser.findUnique({
         where: { chatId_userId: { chatId: payload.chatId, userId: senderUserId } },
         select: { userId: true },
       }),
       prisma.chatUser.findUnique({
         where: { chatId_userId: { chatId: payload.chatId, userId: payload.recipientId } },
         select: { userId: true },
       }),
     ]);
     if (!senderMembership || !recipientMembership) {
       console.warn(
         `[handleMultiDeviceMessage] Membership check failed — sender=${senderUserId} in chat=${payload.chatId}: ${!!senderMembership}; recipient=${payload.recipientId}: ${!!recipientMembership}`,
       );
       sender.send({
         type: 'error',
         payload: { code: 'SENDER_MISMATCH', message: 'Sender identity mismatch' },
         timestamp: Date.now(),
         id: crypto.randomUUID(),
       });
       return;
     }

     // Log incoming file message
     const payloadHasAttachments = payload.attachments && payload.attachments.length > 0;
     console.log(`[FILE-BACKEND] Received multi_device_message:`, {
       chatId: payload.chatId,
       senderId: senderUserId,
       recipientId: payload.recipientId,
       hasAttachments: payloadHasAttachments,
       attachmentCount: payload.attachments?.length || 0,
       recipientMessagesCount: payload.recipientMessages.length,
       senderMessagesCount: payload.senderMessages?.length || 0,
       totalSize: payload.recipientMessages.reduce((sum, msg) => sum + (msg.content?.length || 0), 0) +
                 (payload.senderMessages?.reduce((sum, msg) => sum + (msg.content?.length || 0), 0) || 0),
     });

    // ========== MESSAGE SIZE VALIDATION ==========
    // Calculate total payload size from all encrypted messages
    let totalPayloadSize = 0;
    for (const msg of payload.recipientMessages) {
      totalPayloadSize += getMessageSize(msg.content);
    }
    if (payload.senderMessages) {
      for (const msg of payload.senderMessages) {
        totalPayloadSize += getMessageSize(msg.content);
      }
    }

    // Check max message size
    if (totalPayloadSize > FILE_RATE_LIMITS.maxPayloadSize) {
      const errorDetails: PayloadSizeErrorDetails = {
        code: 'PAYLOAD_TOO_LARGE',
        actualSize: totalPayloadSize,
        maxSize: FILE_RATE_LIMITS.maxPayloadSize
      };
      sender.send({
        type: 'error',
        payload: {
          code: 'PAYLOAD_TOO_LARGE',
          message: `Message payload too large: ${formatBytes(totalPayloadSize)} exceeds maximum ${formatBytes(FILE_RATE_LIMITS.maxPayloadSize)}`,
          details: errorDetails
        },
        timestamp: Date.now(),
        id: crypto.randomUUID()
      });
      return;
    }

    // Check file rate limits for messages with attachments
    if (hasAttachments(payload.attachments)) {
      const rateLimitCheck = await checkFileRateLimit(senderUserId, totalPayloadSize);
      if (!rateLimitCheck.allowed) {
        const errorDetails: FileRateLimitErrorDetails = {
          code: rateLimitCheck.reason || 'RATE_LIMIT_MESSAGES',
          retryAfter: rateLimitCheck.retryAfter || 60,
          currentMessages: rateLimitCheck.currentMessages || 0,
          currentBytes: rateLimitCheck.currentBytes || 0,
          limitMessages: config.fileRateLimits.messagesPerMinute,
          limitBytes: config.fileRateLimits.bytesPerHour
        };
        sender.send({
          type: 'error',
          payload: {
            code: 'RATE_LIMIT_EXCEEDED',
            message: `File message rate limit exceeded. ${rateLimitCheck.reason === 'RATE_LIMIT_MESSAGES'
              ? `Maximum ${config.fileRateLimits.messagesPerMinute} messages per minute.`
              : `Maximum ${formatBytes(config.fileRateLimits.bytesPerHour)} per hour.`}`,
            details: errorDetails
          },
          timestamp: Date.now(),
          id: crypto.randomUUID()
        });
        return;
      }
    }
     // ========== END MESSAGE SIZE VALIDATION ==========

     // Use client-provided messageId if available, otherwise generate one
     const messageId = payload.messageId || crypto.randomUUID();

     // Get sender's username
    const senderUser = await prisma.user.findUnique({
      where: { id: senderUserId },
      select: { username: true }
    });

    // Get all recipient's devices for tracking delivery
    const recipientDevices = await prisma.device.findMany({
      where: { userId: payload.recipientId, isActive: true },
      select: { deviceId: true, signalDeviceId: true }
    });

    // Get all sender's devices for tracking self-delivery
    const senderDevices = await prisma.device.findMany({
      where: { userId: senderUserId, isActive: true },
      select: { deviceId: true, signalDeviceId: true }
    });

    // Track delivery
    const recipientOnlineClients = manager.getClientsByUserId(payload.recipientId);
    const senderOnlineClients = manager.getClientsByUserId(senderUserId)
      .filter(c => c.getDeviceId() !== sender.getDeviceId());

    const deliveredToDeviceIds: string[] = [];

    // Always increment unreadCount in database
    // Frontend handles active chat case locally (resets to 0)
    // This ensures consistency even if recipient comes online at the same time
    await prisma.chatUser.updateMany({
      where: {
        chatId: payload.chatId,
        userId: payload.recipientId
      },
      data: {
        unreadCount: { increment: 1 }
      }
    });
    console.log(`[handleMultiDeviceMessage] Incremented unreadCount for recipient ${payload.recipientId}`);

    // Get new unreadCount value to send to recipient
    const updatedChatUser = await prisma.chatUser.findUnique({
      where: {
        chatId_userId: {
          chatId: payload.chatId,
          userId: payload.recipientId
        }
      },
      select: { unreadCount: true }
    });
    const newUnreadCount = updatedChatUser?.unreadCount ?? 1;

    // Update chat's updatedAt timestamp
    await prisma.chat.update({
      where: { id: payload.chatId },
      data: { updatedAt: new Date() }
    });

    // Deliver to recipient's online devices
    for (const client of recipientOnlineClients) {
      const clientSignalDeviceId = client.getSignalDeviceId();
      const encryptedMsg = payload.recipientMessages.find(
        m => m.deviceId === clientSignalDeviceId
      );

      // RC-2 fix: send() returns boolean, only track delivery on success
      // This avoids TOCTOU race where socket closes between isOpen() check and send()
      if (encryptedMsg) {
        const sent = client.send({
          type: 'message',
          payload: {
            chatId: payload.chatId,
            senderId: senderUserId,
            senderUsername: senderUser?.username || senderUserId,
            senderDeviceId: sender.getSignalDeviceId(),
            content: encryptedMsg.content,
            messageId,
            timestamp: Date.now(),
            messageType: encryptedMsg.messageType,
            replyTo: payload.replyTo,
            attachments: payload.attachments,
            unreadCount: newUnreadCount,
            metadata: payload.metadata
          },
          timestamp: Date.now(),
          id: crypto.randomUUID()
        });

        if (sent) {
          deliveredToDeviceIds.push(client.getDeviceId());
        }
      }
    }

    // Deliver to sender's other devices (Sesame self-delivery)
    for (const client of senderOnlineClients) {
      const clientSignalDeviceId = client.getSignalDeviceId();
      const encryptedMsg = payload.senderMessages?.find(
        m => m.deviceId === clientSignalDeviceId
      );

      // RC-2 fix: send() returns boolean, only track delivery on success
      if (encryptedMsg) {
        const sent = client.send({
          type: 'message',
          payload: {
            chatId: payload.chatId,
            senderId: senderUserId,
            senderUsername: senderUser?.username || senderUserId,
            senderDeviceId: sender.getSignalDeviceId(),
            content: encryptedMsg.content,
            messageId,
            timestamp: Date.now(),
            messageType: encryptedMsg.messageType,
            replyTo: payload.replyTo,
            attachments: payload.attachments,
            unreadCount: 0,  // Self-delivery: own message, no unread
            isSelfDelivery: true,
            metadata: payload.metadata
          },
          timestamp: Date.now(),
          id: crypto.randomUUID()
        });

        if (sent) {
          deliveredToDeviceIds.push(client.getDeviceId());
        }
      }
    }

    // Store messages for offline devices
    const allRecipientDeviceIds = recipientDevices.map(d => d.deviceId);
    const allSenderDeviceIds = senderDevices.map(d => d.deviceId);
    const allOfflineRecipientDevices = allRecipientDeviceIds.filter(
      id => !deliveredToDeviceIds.includes(id)
    );
    const allOfflineSenderDevices = allSenderDeviceIds.filter(
      id => !deliveredToDeviceIds.includes(id) && id !== sender.getDeviceId()
    );

    console.log(`[handleMultiDeviceMessage] Delivery status:`, {
      messageId,
      recipientOnline: recipientOnlineClients.length,
      recipientTotal: recipientDevices.length,
      senderOnline: senderOnlineClients.length,
      senderTotal: senderDevices.length,
      deliveredToDeviceIds,
      allRecipientDeviceIds,
      allSenderDeviceIds,
      allOfflineRecipientDevices,
      allOfflineSenderDevices
    });

    if (allOfflineRecipientDevices.length > 0 || allOfflineSenderDevices.length > 0) {
      // ========== STORAGE QUOTA CHECK ==========
      // Calculate total payload size for all pending messages
      const totalOfflineDevices = allOfflineRecipientDevices.length + allOfflineSenderDevices.length;
      // Estimate size: use first recipient message as baseline or average
      const estimatedMessageSize = payload.recipientMessages.length > 0
        ? payload.recipientMessages.reduce((sum, msg) => sum + (msg.content?.length || 0), 0) / payload.recipientMessages.length
        : 0;
      const estimatedTotalSize = Math.ceil(estimatedMessageSize * totalOfflineDevices * 0.75); // 0.75 factor for base64 overhead

      // Check quota before storing
      const quotaCheck = await checkQuotaForBatch(senderUserId, estimatedTotalSize);
      if (!quotaCheck.allowed) {
        const quota = await getUserStorageQuota(senderUserId);
        console.warn(`[handleMultiDeviceMessage] Storage quota exceeded for user ${senderUserId}:`, {
          used: formatBytes(quota.usedBytes),
          max: formatBytes(quota.maxBytes),
          required: formatBytes(estimatedTotalSize),
          exceededBy: formatBytes(quotaCheck.exceededBy || 0)
        });

        // Send error to sender
        sender.send({
          type: 'error',
          payload: {
            code: 'STORAGE_QUOTA_EXCEEDED',
            message: `Storage quota exceeded. Used: ${formatBytes(quota.usedBytes)} of ${formatBytes(quota.maxBytes)}. ` +
                     `Required: ${formatBytes(estimatedTotalSize)} more.`,
            details: {
              code: 'STORAGE_QUOTA_EXCEEDED',
              usedBytes: quota.usedBytes,
              maxBytes: quota.maxBytes,
              availableBytes: quota.availableBytes,
              percentUsed: quota.percentUsed,
              requiredBytes: estimatedTotalSize
            }
          },
          timestamp: Date.now(),
          id: crypto.randomUUID()
        });

        // Don't store messages, but message was already delivered to online devices
        // Return to indicate processing completed (with error)
        return;
      }
      // ========== END STORAGE QUOTA CHECK ==========

      // Get all device IDs for metadata (needed for pending message lookup)
      // Bug 4 fix: Filter out null signalDeviceId values - devices without Signal registration cannot receive encrypted messages
      const allRecipientSignalDeviceIds = recipientDevices
        .map(d => d.signalDeviceId)
        .filter((id): id is number => id !== null);
      const allSenderSignalDeviceIds = senderDevices
        .map(d => d.signalDeviceId)
        .filter((id): id is number => id !== null);

      // Store encrypted messages for each offline device
      for (const encryptedMsg of payload.recipientMessages) {
        const device = recipientDevices.find(d => d.signalDeviceId === encryptedMsg.deviceId);
        if (device && allOfflineRecipientDevices.includes(device.deviceId)) {
          console.log(`[handleMultiDeviceMessage] Storing message for offline recipient device:`, {
            messageId: `${messageId}-${encryptedMsg.deviceId}`,
            deviceId: device.deviceId,
            signalDeviceId: encryptedMsg.deviceId,
            pendingDeviceId: device.deviceId
          });

          await prisma.message.create({
            data: {
              id: `${messageId}-${encryptedMsg.deviceId}`,
              chatId: payload.chatId,
              authorId: senderUserId,
              content: encryptedMsg.content,
              type: 'TEXT',
              encrypted: true,
               metadata: {
                 recipientId: payload.recipientId,
                 recipientDeviceId: encryptedMsg.deviceId,
                 senderDeviceId: sender.getSignalDeviceId(),
                 messageType: encryptedMsg.messageType,
                 deliveredTo: deliveredToDeviceIds,
                 pendingDeviceId: device.deviceId,
                 originalMessageId: messageId,
                 // Add device lists for pending message lookup
                 recipientDevices: allRecipientSignalDeviceIds,
                 senderDevices: allSenderSignalDeviceIds,
                 // Include forwardedFrom only if explicitly present in payload.metadata
                 ...(payload.metadata?.['forwardedFrom'] ? { forwardedFrom: payload.metadata['forwardedFrom'] } : {}),
                 // Store replyTo from payload.replyTo
                 ...(payload.replyTo ? { replyTo: payload.replyTo } : {}),
                 // Store replyToOriginalSenderId if present
                 ...(payload.metadata?.['replyTo']?.originalSenderId ? { replyToOriginalSenderId: payload.metadata['replyTo'].originalSenderId } : {})
               }
            }
          });
        }
      }

      // Store sender's self-delivery messages for offline sender devices
      if (payload.senderMessages) {
        console.log(`[handleMultiDeviceMessage] Processing senderMessages:`, {
          senderMessagesCount: payload.senderMessages.length,
          senderMessages: payload.senderMessages.map(m => ({ deviceId: m.deviceId, messageType: m.messageType })),
          senderDevices: senderDevices.map(d => ({ deviceId: d.deviceId, signalDeviceId: d.signalDeviceId })),
          allOfflineSenderDevices
        });

        for (const encryptedMsg of payload.senderMessages) {
          const device = senderDevices.find(d => d.signalDeviceId === encryptedMsg.deviceId);
          console.log(`[handleMultiDeviceMessage] Checking sender device:`, {
            signalDeviceId: encryptedMsg.deviceId,
            foundDevice: device ? { deviceId: device.deviceId, signalDeviceId: device.signalDeviceId } : null,
            isOffline: device ? allOfflineSenderDevices.includes(device.deviceId) : false
          });

          if (device && allOfflineSenderDevices.includes(device.deviceId)) {
            console.log(`[handleMultiDeviceMessage] Storing self-delivery for offline sender device:`, {
              messageId: `${messageId}-sender-${encryptedMsg.deviceId}`,
              deviceId: device.deviceId,
              signalDeviceId: encryptedMsg.deviceId,
              pendingDeviceId: device.deviceId
            });

            await prisma.message.create({
              data: {
                id: `${messageId}-sender-${encryptedMsg.deviceId}`,
                chatId: payload.chatId,
                authorId: senderUserId,
                content: encryptedMsg.content,
                type: 'TEXT',
                encrypted: true,
                 metadata: {
                   recipientId: senderUserId, // Self-delivery
                   recipientDeviceId: encryptedMsg.deviceId,
                   senderDeviceId: sender.getSignalDeviceId(),
                   messageType: encryptedMsg.messageType,
                   deliveredTo: deliveredToDeviceIds,
                   pendingDeviceId: device.deviceId,
                   originalMessageId: messageId,
                   isSelfDelivery: true,
                   // Add device lists for pending message lookup
                   recipientDevices: allRecipientSignalDeviceIds,
                   senderDevices: allSenderSignalDeviceIds,
                   // Include forwardedFrom only if explicitly present in payload.metadata
                   ...(payload.metadata?.['forwardedFrom'] ? { forwardedFrom: payload.metadata['forwardedFrom'] } : {}),
                   // Store replyTo from payload.replyTo
                   ...(payload.replyTo ? { replyTo: payload.replyTo } : {}),
                   // Store replyToOriginalSenderId if present
                   ...(payload.metadata?.['replyTo']?.originalSenderId ? { replyToOriginalSenderId: payload.metadata['replyTo'].originalSenderId } : {})
                 }
              }
            });
          }
        }
      }
    }

  } catch (error) {
    console.error('[WS] Multi-device message handling error:', error);
  }
}

/**
 * Handle favorites/saved message (multi-device to self)
 *
 * Key differences from regular multi-device message:
 * - recipientId = senderUserId (sending to yourself)
 * - NO echo to sending device (local echo handled by client IndexedDB)
 * - Deliver only to OTHER devices of the user (excluding senderDeviceId)
 *
 * This implements the Local Echo pattern: messages are saved locally first,
 * then sent to other devices. No need for server echo back to sender.
 */
export async function handleFavoritesMessage(
  payload: FavoritesMessagePayload,
  sender: WebSocketClient,
  manager: WebSocketManager,
  _sendDeliveryStatus: (
    client: WebSocketClient,
    messageId: string,
    chatId: string,
    status: 'sent' | 'delivered' | 'read' | 'failed',
    deviceId?: number | string
  ) => void
): Promise<void> {
  try {
    if (!payload || !payload.chatId || !Array.isArray(payload.messages)) {
      console.warn('[WS] Invalid favorites_message payload:', payload);
      return;
    }

    const senderUserId = sender.getUserId();
    const senderDeviceId = sender.getDeviceId();

    // ========== MESSAGE SIZE VALIDATION ==========
    // Calculate total payload size from all encrypted messages
    let totalPayloadSize = 0;
    for (const msg of payload.messages) {
      totalPayloadSize += getMessageSize(msg.content);
    }

    // Check max message size
    if (totalPayloadSize > FILE_RATE_LIMITS.maxPayloadSize) {
      const errorDetails: PayloadSizeErrorDetails = {
        code: 'PAYLOAD_TOO_LARGE',
        actualSize: totalPayloadSize,
        maxSize: FILE_RATE_LIMITS.maxPayloadSize
      };
      sender.send({
        type: 'error',
        payload: {
          code: 'PAYLOAD_TOO_LARGE',
          message: `Message payload too large: ${formatBytes(totalPayloadSize)} exceeds maximum ${formatBytes(FILE_RATE_LIMITS.maxPayloadSize)}`,
          details: errorDetails
        },
        timestamp: Date.now(),
        id: crypto.randomUUID()
      });
      return;
    }

    // Check file rate limits for messages with attachments
    if (hasAttachments(payload.attachments)) {
      const rateLimitCheck = await checkFileRateLimit(senderUserId, totalPayloadSize);
      if (!rateLimitCheck.allowed) {
        const errorDetails: FileRateLimitErrorDetails = {
          code: rateLimitCheck.reason || 'RATE_LIMIT_MESSAGES',
          retryAfter: rateLimitCheck.retryAfter || 60,
          currentMessages: rateLimitCheck.currentMessages || 0,
          currentBytes: rateLimitCheck.currentBytes || 0,
          limitMessages: config.fileRateLimits.messagesPerMinute,
          limitBytes: config.fileRateLimits.bytesPerHour
        };
        sender.send({
          type: 'error',
          payload: {
            code: 'RATE_LIMIT_EXCEEDED',
            message: `File message rate limit exceeded. ${rateLimitCheck.reason === 'RATE_LIMIT_MESSAGES'
              ? `Maximum ${config.fileRateLimits.messagesPerMinute} messages per minute.`
              : `Maximum ${formatBytes(config.fileRateLimits.bytesPerHour)} per hour.`}`,
            details: errorDetails
          },
          timestamp: Date.now(),
          id: crypto.randomUUID()
        });
        return;
      }
    }
     // ========== END MESSAGE SIZE VALIDATION ==========

     // Use client-provided messageId if available, otherwise generate one
     const messageId = payload.messageId || crypto.randomUUID();

     // Verify this is a favorites chat
    const chat = await prisma.chat.findUnique({
      where: { id: payload.chatId },
      select: { type: true, createdById: true }
    });

    if (!chat || chat.type !== 'FAVORITES') {
      console.warn('[WS] favorites_message sent to non-favorites chat:', payload.chatId);
      sender.send({
        type: 'error',
        payload: { code: 400, message: 'Invalid chat type for favorites message' },
        timestamp: Date.now(),
        id: crypto.randomUUID()
      });
      return;
    }

    // Verify sender is the owner of the favorites chat
    if (chat.createdById !== senderUserId) {
      console.warn('[WS] favorites_message from non-owner:', senderUserId);
      sender.send({
        type: 'error',
        payload: { code: 403, message: 'Not authorized to post in this favorites chat' },
        timestamp: Date.now(),
        id: crypto.randomUUID()
      });
      return;
    }

    // Get sender's username
    const senderUser = await prisma.user.findUnique({
      where: { id: senderUserId },
      select: { username: true }
    });

    // Get all sender's devices for tracking delivery
    const senderDevices = await prisma.device.findMany({
      where: { userId: senderUserId, isActive: true },
      select: { deviceId: true, signalDeviceId: true }
    });

    // Get online clients for this user (excluding the sending device)
    const senderOnlineClients = manager.getClientsByUserId(senderUserId)
      .filter(c => c.getDeviceId() !== senderDeviceId);

    const deliveredToDeviceIds: string[] = [];

    // Update chat's updatedAt timestamp
    await prisma.chat.update({
      where: { id: payload.chatId },
      data: { updatedAt: new Date() }
    });

    // Deliver to sender's OTHER online devices only (NOT the sending device)
    console.log('[handleFavoritesMessage] Delivery debug:', {
      senderDeviceId,
      onlineClientsCount: senderOnlineClients.length,
      onlineClients: senderOnlineClients.map(c => ({ deviceId: c.getDeviceId(), signalDeviceId: c.getSignalDeviceId() })),
      messagesInPayload: payload.messages.map(m => ({ deviceId: m.deviceId, messageType: m.messageType })),
      senderDevicesFromDB: senderDevices.map(d => ({ deviceId: d.deviceId, signalDeviceId: d.signalDeviceId }))
    });

    for (const client of senderOnlineClients) {
      const clientSignalDeviceId = client.getSignalDeviceId();
      const encryptedMsg = payload.messages.find(
        m => m.deviceId === clientSignalDeviceId
      );

      console.log(`[handleFavoritesMessage] Looking for message for device ${clientSignalDeviceId}:`, {
        found: !!encryptedMsg,
        clientDeviceId: client.getDeviceId()
      });

      if (encryptedMsg) {
        const sent = client.send({
          type: 'favorites_message',
          payload: {
            chatId: payload.chatId,
            senderId: senderUserId,
            senderUsername: senderUser?.username || senderUserId,
            senderDeviceId: sender.getSignalDeviceId(),
            content: encryptedMsg.content,
            messageId,
            timestamp: Date.now(),
            messageType: encryptedMsg.messageType,
            replyTo: payload.replyTo,
            attachments: payload.attachments,
            unreadCount: 0,  // Self-delivery: own message, no unread
            isFavorites: true,
            isSelfDelivery: true
          },
          timestamp: Date.now(),
          id: crypto.randomUUID()
        });

        if (sent) {
          deliveredToDeviceIds.push(client.getDeviceId());
        }
      }
    }

    // Store messages for offline devices (other devices, NOT the sending device)
    const allSenderDeviceIds = senderDevices.map(d => d.deviceId);
    const allOfflineSenderDevices = allSenderDeviceIds.filter(
      id => !deliveredToDeviceIds.includes(id) && id !== senderDeviceId
    );

    if (allOfflineSenderDevices.length > 0) {
      // ========== STORAGE QUOTA CHECK ==========
      // Calculate total payload size for all pending messages
      const estimatedMessageSize = payload.messages.length > 0
        ? payload.messages.reduce((sum, msg) => sum + (msg.content?.length || 0), 0) / payload.messages.length
        : 0;
      const estimatedTotalSize = Math.ceil(estimatedMessageSize * allOfflineSenderDevices.length * 0.75);

      // Check quota before storing
      const quotaCheck = await checkQuotaForBatch(senderUserId, estimatedTotalSize);
      if (!quotaCheck.allowed) {
        const quota = await getUserStorageQuota(senderUserId);
        console.warn(`[handleFavoritesMessage] Storage quota exceeded for user ${senderUserId}:`, {
          used: formatBytes(quota.usedBytes),
          max: formatBytes(quota.maxBytes),
          required: formatBytes(estimatedTotalSize),
          exceededBy: formatBytes(quotaCheck.exceededBy || 0)
        });

        // Send error to sender
        sender.send({
          type: 'error',
          payload: {
            code: 'STORAGE_QUOTA_EXCEEDED',
            message: `Storage quota exceeded. Used: ${formatBytes(quota.usedBytes)} of ${formatBytes(quota.maxBytes)}. ` +
                     `Required: ${formatBytes(estimatedTotalSize)} more.`,
            details: {
              code: 'STORAGE_QUOTA_EXCEEDED',
              usedBytes: quota.usedBytes,
              maxBytes: quota.maxBytes,
              availableBytes: quota.availableBytes,
              percentUsed: quota.percentUsed,
              requiredBytes: estimatedTotalSize
            }
          },
          timestamp: Date.now(),
          id: crypto.randomUUID()
        });

        // Don't store messages for offline devices, but continue to send ack
        // (online devices already received the message)
      } else {
      // ========== END STORAGE QUOTA CHECK ==========

      // Get all device IDs for metadata
      const allSenderSignalDeviceIds = senderDevices
        .map(d => d.signalDeviceId)
        .filter((id): id is number => id !== null);

      // Store encrypted messages for each offline device
      for (const encryptedMsg of payload.messages) {
        const device = senderDevices.find(d => d.signalDeviceId === encryptedMsg.deviceId);
        if (device && allOfflineSenderDevices.includes(device.deviceId)) {
          await prisma.message.create({
            data: {
              id: `${messageId}-${encryptedMsg.deviceId}`,
              chatId: payload.chatId,
              authorId: senderUserId,
              content: encryptedMsg.content,
              type: 'TEXT',
              encrypted: true,
              metadata: {
                recipientId: senderUserId, // Self-delivery
                recipientDeviceId: encryptedMsg.deviceId,
                senderDeviceId: sender.getSignalDeviceId(),
                messageType: encryptedMsg.messageType,
                deliveredTo: deliveredToDeviceIds,
                pendingDeviceId: device.deviceId,
                originalMessageId: messageId,
                isSelfDelivery: true,
                isFavorites: true,
                senderDevices: allSenderSignalDeviceIds,
              }
            }
          });
        }
      }
      } // Closing brace for else block (quota check passed)
    }

    // Send acknowledgment to sending device (no message content, just ack)
    sender.send({
      type: 'favorites_ack',
      payload: {
        messageId,
        chatId: payload.chatId,
        status: 'sent',
        deliveredToOtherDevices: deliveredToDeviceIds.length
      },
      timestamp: Date.now(),
      id: crypto.randomUUID()
    });

    console.log(`[handleFavoritesMessage] Message ${messageId} processed:`, {
      senderUserId,
      senderDeviceId,
      otherDevicesOnline: senderOnlineClients.length,
      deliveredToOtherDevices: deliveredToDeviceIds.length,
      offlineDevices: allOfflineSenderDevices.length
    });

  } catch (error) {
    console.error('[WS] Favorites message handling error:', error);
    sender.send({
      type: 'error',
      payload: { code: 500, message: 'Failed to process favorites message' },
      timestamp: Date.now(),
      id: crypto.randomUUID()
    });
  }
}
