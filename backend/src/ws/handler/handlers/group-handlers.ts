import { prisma } from '../../../prisma/client';
import { encryptAtRest } from '../../../utils/crypto-at-rest';
import type {
  GroupMessagePayload,
  GroupKeyUpdateRequestPayload,
  GroupKeyUpdatePayload,
  GroupSyncPayload,
  GroupMessageAckPayload,
  SenderKeyDistributionPayload,
  FileRateLimitErrorDetails,
  PayloadSizeErrorDetails
} from '../../types';
import { WebSocketClient } from '../client';
import { WebSocketManager } from '../../manager';
import {
  checkFileRateLimit,
  hasAttachments,
  getMessageSize,
  FILE_RATE_LIMITS
} from '../../../middleware/message-validation';
import { config } from '../../../config';
import { formatBytes } from '../../../services/storage-quota';

/**
 * Handle group message
 * Receives encrypted group message and broadcasts to all group members
 */
export async function handleGroupMessage(
  payload: GroupMessagePayload,
  sender: WebSocketClient,
  manager: WebSocketManager
): Promise<void> {
  const { chatId, senderUserId, content, senderKeyId, replyTo, attachments, senderKeyDistribution, metadata } = payload;
  // Use client-provided messageId, fallback to generated UUID for safety
  const messageId = payload.messageId || crypto.randomUUID();

  // SECURITY: Sender identity verification — must be the very first
  // check. The authenticated WS user must equal `senderUserId` in
  // the payload, otherwise a malicious user could spoof group
  // messages on behalf of someone else.
  if (senderUserId !== sender.getUserId()) {
    sender.send({
      type: 'error',
      payload: { code: 'SENDER_MISMATCH', message: 'Sender identity mismatch' },
      timestamp: Date.now(),
      id: crypto.randomUUID(),
    });
    return;
  }

  console.log(`[GroupMessage] Received from ${senderUserId} in chat ${chatId}`);

  // Log incoming group file message
  const hasAttachmentFiles = attachments && attachments.length > 0;
  console.log(`[FILE-BACKEND] Received group_message:`, {
    chatId,
    senderId: senderUserId,
    hasAttachments: hasAttachmentFiles,
    attachmentCount: attachments?.length || 0,
    contentLength: content.length,
    messageId,
    timestamp: Date.now(),
  });

  try {
    // ========== MESSAGE SIZE VALIDATION ==========
    // Calculate payload size from content (base64 encoded encrypted message)
    const payloadSize = getMessageSize(content);

    // Check max message size
    if (payloadSize > FILE_RATE_LIMITS.maxPayloadSize) {
      const errorDetails: PayloadSizeErrorDetails = {
        code: 'PAYLOAD_TOO_LARGE',
        actualSize: payloadSize,
        maxSize: FILE_RATE_LIMITS.maxPayloadSize
      };
      sender.send({
        type: 'error',
        payload: {
          code: 'PAYLOAD_TOO_LARGE',
          message: `Message payload too large: ${formatBytes(payloadSize)} exceeds maximum ${formatBytes(FILE_RATE_LIMITS.maxPayloadSize)}`,
          details: errorDetails
        },
        timestamp: Date.now(),
        id: crypto.randomUUID()
      });
      return;
    }

    // Check file rate limits for messages with attachments
    if (hasAttachments(attachments)) {
      const rateLimitCheck = await checkFileRateLimit(senderUserId, payloadSize);
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

    // Verify sender is a member of the group
    const chatUser = await prisma.chatUser.findFirst({
      where: {
        chatId,
        userId: senderUserId
      }
    });

    if (!chatUser) {
      console.warn(`[GroupMessage] Sender ${senderUserId} is not a member of chat ${chatId}`);
      return;
    }

    // Get all chat members with their devices
    const chatMembers = await prisma.chatUser.findMany({
      where: { chatId },
      select: { userId: true }
    });

    // Get all devices of all members from DB
    const memberUserIds = chatMembers.map(m => m.userId);
    const allMemberDevices = await prisma.device.findMany({
      where: {
        userId: { in: memberUserIds },
        isActive: true
      },
      select: { deviceId: true, userId: true, signalDeviceId: true }
    });

    // First, increment unreadCount and get values BEFORE sending messages
    const memberUnreadCounts = new Map<string, number>();
    
    for (const member of chatMembers) {
      if (member.userId === senderUserId) continue; // Skip sender
      
      // Get all devices of this member
      const memberDevices = allMemberDevices.filter(d => d.userId === member.userId);
      const memberOnlineDeviceIds = new Set<string>();
      
      for (const client of manager.getClientsByUserId(member.userId)) {
        if (client.isOpen()) {
          memberOnlineDeviceIds.add(client.getDeviceId());
        }
      }
      
      // Check if member has any online devices
      const hasOnlineDevice = memberDevices.some(d => memberOnlineDeviceIds.has(d.deviceId));
      
      // Always increment unreadCount - frontend handles active chat locally
      await prisma.chatUser.updateMany({
        where: {
          chatId,
          userId: member.userId
        },
        data: {
          unreadCount: { increment: 1 }
        }
      });
      console.log(`[GroupMessage] Incremented unreadCount for member ${member.userId} (online: ${hasOnlineDevice})`);
      
      // Get new unreadCount value for this member
      const updatedChatUser = await prisma.chatUser.findUnique({
        where: {
          chatId_userId: { chatId, userId: member.userId }
        },
        select: { unreadCount: true }
      });
      memberUnreadCounts.set(member.userId, updatedChatUser?.unreadCount ?? 1);
    }

    // Now send to all online members (except sender's current device)
    const senderDeviceId = sender.getSignalDeviceId();

    const onlineDeviceIds = new Set<string>();

    for (const member of chatMembers) {
      // Get all devices of this member
      const memberClients = manager.getClientsByUserId(member.userId);
      for (const client of memberClients) {
        // Skip sender's current device (compare signal device IDs)
        if (member.userId === senderUserId && client.getSignalDeviceId() === senderDeviceId) {
          continue;
        }
        if (client.isOpen()) {
          // Get unreadCount for this member (0 for sender, actual count for others)
          const unreadCount = member.userId === senderUserId ? 0 : (memberUnreadCounts.get(member.userId) ?? 1);
          client.send({
            type: 'group_message',
            payload: {
              chatId,
              content,
              senderUserId,
              senderDeviceId,
              messageId,
              timestamp: Date.now(),
              senderKeyId,
              replyTo,
              attachments,
              senderKeyDistribution,
              unreadCount,
              metadata
            },
            timestamp: Date.now(),
            id: messageId
          });
          onlineDeviceIds.add(client.getDeviceId());
        }
      }
    }

    // Store messages for offline devices (multi-device support)
    // Include both:
    // 1. Other members' offline devices (standard pending messages)
    // 2. Sender's other offline devices (self-delivery for multi-device sync)
    const offlineOtherMemberDevices = allMemberDevices.filter(
      d => !onlineDeviceIds.has(d.deviceId) && d.userId !== senderUserId
    );
    
    // Get sender's other devices (for self-delivery)
    const senderDevices = allMemberDevices.filter(
      d => d.userId === senderUserId && !onlineDeviceIds.has(d.deviceId) && d.signalDeviceId !== senderDeviceId
    );
    
    const offlineDevices = [...offlineOtherMemberDevices, ...senderDevices];

    // Only save message to database if there are offline devices
    if (offlineDevices.length > 0) {
      console.log(`[GroupMessage] Saving message for ${offlineOtherMemberDevices.length} offline member device(s) and ${senderDevices.length} sender device(s)`);
      
      // Save only pending messages for offline devices (like in 1:1 pipeline)
      for (const device of offlineOtherMemberDevices) {
        await prisma.message.create({
          data: {
            id: `${messageId}-pending-${device.deviceId}`, // Use client-provided messageId
            chatId,
            authorId: senderUserId,
            content,
            type: 'TEXT' as any,
             encrypted: true,
             metadata: {
               senderKeyId,
               senderDeviceId,
               messageType: 'sender_key',
               pendingDeviceId: device.deviceId,
               isGroupPending: true,
               senderKeyDistribution,
                 // Include all metadata fields (forwardedFrom, replyTo, etc.) directly
                 ...(metadata || {}),
                 // Ensure replyTo is present if provided (overwrites if already in metadata)
                 ...(replyTo ? { replyTo } : {})
             }
          }
        });
      }
      
      for (const device of senderDevices) {
        await prisma.message.create({
          data: {
            id: `${messageId}-pending-${device.deviceId}`, // Use client-provided messageId
            chatId,
            authorId: senderUserId,
            content,
            type: 'TEXT' as any,
            encrypted: true,
            metadata: {
              senderKeyId,
              senderDeviceId,
              messageType: 'sender_key',
              pendingDeviceId: device.deviceId,
              isGroupPending: true,
               isSelfDelivery: true,
               senderKeyDistribution,
                 // Include all metadata fields (forwardedFrom, replyTo, etc.) directly
                 ...(metadata || {}),
                 // Ensure replyTo is present if provided (overwrites if already in metadata)
                 ...(replyTo ? { replyTo } : {})
             }
          }
        });
      }
    } else {
      console.log(`[GroupMessage] All devices online, not saving message to database`);
    }

    // Send acknowledgment to sender
    sender.send({
      type: 'group_message_ack',
      payload: {
        messageId,
        chatId,
        status: 'received'
      } as GroupMessageAckPayload,
      timestamp: Date.now(),
      id: crypto.randomUUID()
    });

  } catch (error) {
    console.error('[GroupMessage] Error handling group message:', error);
  }
}

/**
 * Handle group key update request
 * Triggered when member joins/leaves or admin changes
 */
export async function handleGroupKeyUpdate(
  payload: GroupKeyUpdateRequestPayload,
  sender: WebSocketClient,
  manager: WebSocketManager
): Promise<void> {
  const { chatId, requestingUserId, requestingDeviceId, reason } = payload;

  // SECURITY: Sender identity verification — must be the very first
  // check. The authenticated WS user must equal `requestingUserId`
  // in the payload, otherwise a malicious user could trigger a key
  // rotation on behalf of someone else.
  if (requestingUserId !== sender.getUserId()) {
    sender.send({
      type: 'error',
      payload: { code: 'SENDER_MISMATCH', message: 'Sender identity mismatch' },
      timestamp: Date.now(),
      id: crypto.randomUUID(),
    });
    return;
  }

  console.log(`[GroupKeyUpdate] Request from ${requestingUserId} in chat ${chatId}, reason: ${reason}`);

  try {
    // Verify sender is admin or the chat exists
    const chat = await prisma.chat.findUnique({
      where: { id: chatId },
      include: {
        chatUsers: {
          where: { userId: requestingUserId },
          select: { role: true }
        }
      }
    });

    if (!chat) {
      console.warn(`[GroupKeyUpdate] Chat ${chatId} not found`);
      return;
    }

    // Check if sender is admin for non-manual requests
    if (reason !== 'manual_request') {
      const senderRole = chat.chatUsers[0]?.role;
      if (senderRole !== 'ADMIN' && senderRole !== 'OWNER') {
        console.warn(`[GroupKeyUpdate] User ${requestingUserId} is not admin in chat ${chatId}`);
        return;
      }
    }

    // Get all chat members who need the update
    const chatMembers = await prisma.chatUser.findMany({
      where: { chatId },
      select: { userId: true }
    });

    // Notify all members to update their Sender Keys
    const keyUpdatePayload: GroupKeyUpdatePayload = {
      chatId,
      senderUserId: requestingUserId,
      senderDeviceId: requestingDeviceId,
      senderKeyId: crypto.randomUUID(), // New key ID
      senderKey: '', // Empty - clients will request actual key from sender
      reason: reason as 'member_joined' | 'member_left' | 'admin_changed'
    };

    for (const member of chatMembers) {
      // Get all devices of this member
      const memberClients = manager.getClientsByUserId(member.userId);
      for (const client of memberClients) {
        if (client.isOpen()) {
          client.send({
            type: 'group_key_update',
            payload: keyUpdatePayload,
            timestamp: Date.now(),
            id: crypto.randomUUID()
          });
        }
      }
    }

  } catch (error) {
    console.error('[GroupKeyUpdate] Error handling group key update:', error);
  }
}

/**
 * Handle group sync
 * Syncs Sender Keys between user's own devices
 */
export async function handleGroupSync(
  payload: GroupSyncPayload,
  sender: WebSocketClient,
  manager: WebSocketManager
): Promise<void> {
  const { chatId, senderUserId, senderKeyId, senderKey, senderKeySignature, signatureKeyPub, signatureKeyPriv } = payload;
  const userId = sender.getUserId();

  console.log(`[GroupSync] Sync for chat ${chatId} from device ${sender.getDeviceId()}`);

  try {
    // Verify the sender is the same user
    if (senderUserId !== userId) {
      console.warn(`[GroupSync] User mismatch: ${senderUserId} != ${userId}`);
      return;
    }

    // C4 (signature-key storage): The Sender Key signature mechanism
    // requires a signing keypair per (chat, device). When the client
    // provides one, we persist it (encrypting the private key at
    // rest). When neither is provided, we cannot verify Sender Key
    // signatures server-side — log a warning so operators can detect
    // clients that haven't been upgraded yet. We still store the
    // chainKey so message delivery works; signature verification is
    // the client's responsibility via the SKDM channel.
    if (!signatureKeyPub && !signatureKeyPriv) {
      console.warn(
        `[GroupSync] Missing signatureKeyPub/Priv for chat=${chatId} user=${senderUserId} device=${sender.getDeviceId()} — SenderKey signatures will not be verifiable server-side`,
      );
    }
    if (!senderKeySignature) {
      console.warn(
        `[GroupSync] Missing senderKeySignature for chat=${chatId} user=${senderUserId} device=${sender.getDeviceId()} — recipients cannot verify the chainKey`,
      );
    }

    const sigPubToStore = signatureKeyPub ?? '';
    const sigPrivToStore = signatureKeyPriv ?? '';

    // Save/update Sender Key in database
    await prisma.senderKeyDistribution.upsert({
      where: {
        chatId_senderUserId_deviceId: {
          chatId,
          senderUserId,
          deviceId: sender.getDeviceId()
        }
      },
      update: {
        chainKey: senderKey,
        // Only overwrite signing keys when the client provided fresh
        // ones — otherwise we'd wipe out a previously-stored pair on
        // a no-op sync.
        ...(signatureKeyPub !== undefined ? { signatureKeyPub: sigPubToStore } : {}),
        ...(signatureKeyPriv !== undefined ? { signatureKeyPriv: encryptAtRest(sigPrivToStore) } : {}),
        updatedAt: new Date()
      },
      create: {
        chatId,
        senderUserId,
        deviceId: sender.getDeviceId(),
        chainKey: senderKey,
        signatureKeyPub: sigPubToStore,
        signatureKeyPriv: encryptAtRest(sigPrivToStore)
      }
    });

    // Send to other devices of the same user
    const syncClients = manager.getClientsByUserId(userId)
      .filter(c => c.getDeviceId() !== sender.getDeviceId() && c.isOpen());

    for (const client of syncClients) {
      client.send({
        type: 'group_sync',
        payload: {
          chatId,
          senderUserId,
          senderKeyId,
          senderKey,
          senderKeySignature,
          // Forward signing keys to other devices so they can verify
          // Sender Key signatures without re-fetching from the server.
          ...(signatureKeyPub !== undefined ? { signatureKeyPub } : {}),
          ...(signatureKeyPriv !== undefined ? { signatureKeyPriv } : {}),
        },
        timestamp: Date.now(),
        id: crypto.randomUUID()
      });
    }

  } catch (error) {
    console.error('[GroupSync] Error handling group sync:', error);
  }
}

/**
 * Handle Sender Key distribution message
 * Distributes sender keys to group members
 */
export async function handleSenderKeyDistribution(
  payload: SenderKeyDistributionPayload,
  sender: WebSocketClient,
  manager: WebSocketManager
): Promise<void> {
  const {
    chatId,
    senderUserId,
    senderDeviceId,
    receiverUserId,
    receiverDeviceId,
    distributionId,
    message
  } = payload;
  const userId = sender.getUserId();

  console.log(`[SenderKeyDistribution] Received from ${senderUserId} for chat ${chatId}, receiver: ${receiverUserId}`);

  try {
    // Verify the sender
    if (senderUserId !== userId) {
      console.warn(`[SenderKeyDistribution] User mismatch: ${senderUserId} != ${userId}`);
      sender.send({
        type: 'error',
        payload: { code: 'SENDER_MISMATCH', message: 'Sender identity mismatch' },
        timestamp: Date.now(),
        id: crypto.randomUUID(),
      });
      return;
    }

    // SECURITY: Sender and receiver must BOTH be participants of chatId.
    // Otherwise a malicious user could use SenderKeyDistribution to
    // probe who is in chats they don't belong to, or to deliver
    // forged sender keys to arbitrary users.
    const [senderMembership, receiverMembership] = await Promise.all([
      prisma.chatUser.findUnique({
        where: { chatId_userId: { chatId, userId: senderUserId } },
        select: { userId: true },
      }),
      prisma.chatUser.findUnique({
        where: { chatId_userId: { chatId, userId: receiverUserId } },
        select: { userId: true },
      }),
    ]);
    if (!senderMembership || !receiverMembership) {
      console.warn(
        `[SenderKeyDistribution] Membership check failed — sender=${senderUserId} in chat=${chatId}: ${!!senderMembership}; receiver=${receiverUserId}: ${!!receiverMembership}`,
      );
      sender.send({
        type: 'error',
        payload: { code: 'SENDER_MISMATCH', message: 'Sender identity mismatch' },
        timestamp: Date.now(),
        id: crypto.randomUUID(),
      });
      return;
    }

    // Forward to the target receiver's devices
    const receiverClients = manager.getClientsByUserId(receiverUserId);
    for (const client of receiverClients) {
      if (client.isOpen()) {
        client.send({
          type: 'sender_key_distribution_message',
          payload: {
            chatId,
            senderUserId,
            senderDeviceId,
            receiverUserId,
            receiverDeviceId,
            distributionId,
            message
          },
          timestamp: Date.now(),
          id: crypto.randomUUID()
        });
      }
    }

  } catch (error) {
    console.error('[SenderKeyDistribution] Error handling sender key distribution:', error);
  }
}
