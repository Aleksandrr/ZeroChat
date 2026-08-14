import { WebSocketManager } from '../../manager';
import type { WebSocketClient } from '../client';
import {
  WSMessage,
  CommandMessage,
  CommandType,
  CommandPayload,
  CommandAckPayload,
  CommandEventPayload,
  CommandErrorPayload,
  MessageDeletePayload,
  MessageEditPayload,
  MessagePinPayload,
  MessageUnpinPayload,
  MessageReactPayload,
  MessageUnreactPayload,
  MessageReplyPayload,
  ChatDeletePayload,
  ChatLeavePayload,
  ChatUpdatePayload,
  ChatMutePayload,
  ChatUnmutePayload,
  ChatPinPayload,
  ChatUnpinPayload,
  ChatArchivePayload,
  ChatUnarchivePayload,
  FolderCreatePayload,
  FolderUpdatePayload,
  FolderDeletePayload,
  FolderAddChatPayload,
  FolderRemoveChatPayload,
  FolderReorderPayload,
  ParticipantAddPayload,
  ParticipantRemovePayload,
  ParticipantRoleUpdatePayload,
  SystemClearChatPayload,
  SystemExportChatPayload,
  SystemReportMessagePayload,
} from '../../types';
import { UserRole } from '../../../types';
import { prisma } from '../../../prisma/client';
import { checkPermission } from '../permissions';
import { z } from 'zod';
import { getRedisClient } from '../../../redis/client';
import pino from 'pino';
import {
  commandTotal,
  commandLatency,
  commandErrors,
  replayAttacks,
  rateLimited,
  pendingCommands,
} from '../../../metrics/command-bus-metrics';

// Structured logging
const loggerOptions: pino.LoggerOptions = {
  level: process.env['LOG_LEVEL'] || 'info',
  timestamp: pino.stdTimeFunctions.isoTime,
};
if (process.env['NODE_ENV'] !== 'production') {
  loggerOptions.transport = {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'HH:MM:ss Z',
      ignore: 'pid,hostname',
    },
  };
}
const logger = pino(loggerOptions);

// ==================== Rate Limiting ====================

class RateLimiter {
  private readonly defaultLimit = 20;
  private readonly defaultWindowMs = 60 * 1000; // 1 minute
  private readonly heavyLimit = 20;
  private readonly heavyWindowMs = 60 * 60 * 1000; // 1 hour
  
  async checkLimit(userId: string, command: CommandType, limit?: number, windowMs?: number): Promise<boolean> {
    const redis = getRedisClient();
    const limitToUse = limit || this.defaultLimit;
    const window = windowMs || this.defaultWindowMs;
    
    if (redis) {
      try {
        // Redis-based rate limiting with sliding window
        const key = `rate-limit:cmd:${userId}:${command}:${Math.floor(Date.now() / window)}`;
        const count = await redis.incr(key);
        
        if (count === 1) {
          await redis.pexpire(key, window);
        }
        
        return count <= limitToUse;
      } catch (error) {
        // Redis connection error - fallback to in-memory to avoid blocking commands
        console.error('[RateLimiter] Redis error, falling back to in-memory:', error instanceof Error ? error.message : error);
        return this.checkLimitInMemory(userId, command, limitToUse, window);
      }
    } else {
      // Fallback to in-memory (for development/Redis unavailable)
      return this.checkLimitInMemory(userId, command, limitToUse, window);
    }
  }
  
  async checkHeavyCommandLimit(userId: string): Promise<boolean> {
    const redis = getRedisClient();
    
    if (redis) {
      try {
        const key = `rate-limit:heavy:${userId}:${Math.floor(Date.now() / this.heavyWindowMs)}`;
        const count = await redis.incr(key);
        
        if (count === 1) {
          await redis.pexpire(key, this.heavyWindowMs);
        }
        
        return count <= this.heavyLimit;
      } catch (error) {
        // Redis connection error - fallback to in-memory to avoid blocking commands
        console.error('[RateLimiter] Redis error (heavy), falling back to in-memory:', error instanceof Error ? error.message : error);
        return this.checkHeavyCommandLimitInMemory(userId);
      }
    } else {
      return this.checkHeavyCommandLimitInMemory(userId);
    }
  }
  
  // In-memory fallback methods
  private memoryStore = new Map<string, { count: number; resetTime: number }>();
  
  private checkLimitInMemory(userId: string, command: CommandType, limit: number, windowMs: number): boolean {
    const key = `${userId}:${command}`;
    const now = Date.now();
    const record = this.memoryStore.get(key);
    
    if (!record || now > record.resetTime) {
      this.memoryStore.set(key, { count: 1, resetTime: now + windowMs });
      return true;
    }
    
    if (record.count >= limit) return false;
    record.count++;
    return true;
  }
  
  private checkHeavyCommandLimitInMemory(userId: string): boolean {
    const now = Date.now();
    const hourKey = `${userId}:heavy:hour`;
    const record = this.memoryStore.get(hourKey);
    
    if (!record || now > record.resetTime) {
      this.memoryStore.set(hourKey, { count: 1, resetTime: now + this.heavyWindowMs });
      return true;
    }
    
    if (record.count >= this.heavyLimit) return false;
    record.count++;
    return true;
  }
}

const rateLimiter = new RateLimiter();

// ==================== Replay Attack Protection ====================

class ReplayProtection {
  private commandTimestamps: Map<string, number> = new Map();
  private readonly TTL = 24 * 60 * 60 * 1000; // 24 hours
  private readonly MAX_SIZE = 10000;

  /**
   * C6 (Redis SETNX): In multi-process deployments the in-memory Map
   * is useless — each worker has its own. We use Redis SETNX with a
   * TTL when Redis is configured; otherwise we fall back to the
   * in-memory Map (dev only).
   *
   * Returns true if the commandId has been seen within the TTL.
   */
  async isDuplicate(commandId: string): Promise<boolean> {
    const redis = getRedisClient();
    if (!redis) {
      // Fallback to in-memory (dev only)
      return this.isDuplicateInMemory(commandId);
    }
    try {
      const result = await redis.set(
        `replay:${commandId}`,
        '1',
        'EX', // TTL in seconds
        Math.floor(this.TTL / 1000), // 86400
        'NX', // Only set if not exists
      );
      // ioredis returns 'OK' on success, null when the key already
      // existed (NX refused) — null means we have a duplicate.
      return result === null;
    } catch (err) {
      logger.error({ err }, '[ReplayProtection] Redis error, falling back to in-memory');
      return this.isDuplicateInMemory(commandId);
    }
  }

  /**
   * In-memory fallback. O(1) eviction: when the map is full we clear
   * it wholesale instead of scanning for the oldest entry —
   * acceptable for the dev-only fallback where losing some replay
   * protection state is tolerable.
   */
  private isDuplicateInMemory(commandId: string): boolean {
    if (this.commandTimestamps.has(commandId)) {
      return true;
    }
    if (this.commandTimestamps.size >= this.MAX_SIZE) {
      this.commandTimestamps.clear();
    }
    this.commandTimestamps.set(commandId, Date.now());
    return false;
  }

  clear(): void { this.commandTimestamps.clear(); }
}

const replayProtection = new ReplayProtection();

// ==================== Zod Schemas ====================

export const commandSchemas: Record<CommandType, z.ZodSchema<any>> = {
  'message.delete': z.object({
    messageId: z.string().min(1),
    chatId: z.string().min(1),
    deleteForEveryone: z.boolean(),
  }),
  'message.edit': z.object({
    messageId: z.string().min(1),
    chatId: z.string().min(1),
    content: z.string().max(10000),
    editTimestamp: z.number().int(),
    // Forward-compat: client may include the expected author so the
    // server can reject edits to messages the issuer did not author.
    // For delivered messages (not stored on server) ownership is
    // additionally verified on the receiving client by comparing
    // issuer.userId with the message's senderId.
    expectedAuthorId: z.string().min(1).optional(),
  }),
  'message.pin': z.object({
    messageId: z.string().min(1),
    chatId: z.string().min(1),
    pinTimestamp: z.number().int(),
  }),
  'message.unpin': z.object({
    messageId: z.string().min(1),
    chatId: z.string().min(1),
  }),
  'message.react': z.object({
    messageId: z.string().min(1),
    chatId: z.string().min(1),
    emoji: z.string().max(10),
    add: z.boolean(),
    // C3 (spoofing fix): optional for backward compat. When present,
    // the permission layer verifies `userId === issuerId`. Newer
    // clients should omit this field — the server uses the
    // authenticated issuer instead.
    userId: z.string().min(1).optional(),
  }),
  'message.unreact': z.object({
    messageId: z.string().min(1),
    chatId: z.string().min(1),
    emoji: z.string().max(10),
    userId: z.string().min(1), // ID пользователя, чью реакцию снимаем
  }),
  'message.reply': z.object({
    messageId: z.string().min(1),
    chatId: z.string().min(1),
    replyToMessageId: z.string().min(1),
  }),
  
  'chat.delete': z.object({
    chatId: z.string().min(1),
    deleteMessages: z.boolean(),
  }),
  'chat.leave': z.object({
    chatId: z.string().min(1),
    userId: z.string().min(1),
  }),
  'chat.update': z.object({
    chatId: z.string().min(1),
    updates: z.object({
      name: z.string().max(100).optional(),
      avatar: z.string().url().optional().or(z.string().length(0)),
      description: z.string().max(500).optional(),
    }),
  }),
  'chat.mute': z.object({
    chatId: z.string().min(1),
    mutedUntil: z.string().datetime().optional().or(z.null()),
  }),
  'chat.unmute': z.object({ chatId: z.string().min(1) }),
  'chat.pin': z.object({ chatId: z.string().min(1) }),
  'chat.unpin': z.object({ chatId: z.string().min(1) }),
  'chat.archive': z.object({ chatId: z.string().min(1) }),
  'chat.unarchive': z.object({ chatId: z.string().min(1) }),
  
  'folder.create': z.object({
    name: z.string().max(50),
    color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
    order: z.number().int().min(0),
  }),
  'folder.update': z.object({
    folderId: z.string().min(1),
    updates: z.object({
      name: z.string().max(50).optional(),
      color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional().or(z.string().length(0)),
      order: z.number().int().min(0).optional(),
    }),
  }),
  'folder.delete': z.object({
    folderId: z.string().min(1),
    moveChatsTo: z.string().min(1).optional().or(z.null()),
  }),
  'folder.add_chat': z.object({
    folderId: z.string().min(1),
    chatId: z.string().min(1),
  }),
  'folder.remove_chat': z.object({
    folderId: z.string().min(1),
    chatId: z.string().min(1),
  }),
  'folder.reorder': z.object({
    folderId: z.string().min(1),
    newOrder: z.number().int().min(0),
  }),
  
  'participant.add': z.object({
    chatId: z.string().min(1),
    userId: z.string().min(1),
    role: z.nativeEnum(UserRole).optional(),
  }),
  'participant.remove': z.object({
    chatId: z.string().min(1),
    userId: z.string().min(1),
  }),
  'participant.role_update': z.object({
    chatId: z.string().min(1),
    userId: z.string().min(1),
    newRole: z.nativeEnum(UserRole),
  }),
  
  'system.clear_chat': z.object({
    chatId: z.string().min(1),
    clearFor: z.enum(['me', 'everyone']),
  }),
  'system.export_chat': z.object({
    chatId: z.string().min(1),
    format: z.enum(['json', 'txt', 'pdf']),
    includeMedia: z.boolean().optional(),
  }),
  'system.report_message': z.object({
    messageId: z.string().min(1),
    chatId: z.string().min(1),
    reason: z.enum(['spam', 'abuse', 'inappropriate', 'other']),
    description: z.string().max(1000).optional(),
  }),
  
  'system.participant_joined': z.object({
    chatId: z.string().min(1),
    userId: z.string().min(1),
    username: z.string().min(1),
    joinedAt: z.number().int(),
    inviterId: z.string().min(1).optional(),
  }),
  'system.participant_left': z.object({
    chatId: z.string().min(1),
    userId: z.string().min(1),
    username: z.string().min(1),
    leftAt: z.number().int(),
    reason: z.enum(['left_voluntarily', 'removed_by_admin', 'banned']),
    removedBy: z.string().min(1).optional(),
  }),
  'system.role_changed': z.object({
    chatId: z.string().min(1),
    userId: z.string().min(1),
    username: z.string().min(1),
    oldRole: z.nativeEnum(UserRole),
    newRole: z.nativeEnum(UserRole),
    changedBy: z.string().min(1),
    changedAt: z.number().int(),
  }),
  'system.chat_created': z.object({
    chatId: z.string().min(1),
    chatType: z.enum(['PRIVATE', 'GROUP']),
    name: z.string().max(100).optional(),
    createdBy: z.object({
      userId: z.string().min(1),
      username: z.string().min(1),
    }),
    createdAt: z.number().int(),
  }),

  'device.verification_request': z.object({
    newDeviceId: z.string().min(1),
    newDeviceName: z.string().max(100).optional(),
  }),
};

// ==================== Command Handler ====================

export async function handleCommand(
  message: WSMessage<CommandMessage>,
  client: WebSocketClient,
  manager: WebSocketManager
): Promise<void> {
  const { payload: commandMsg } = message;
  const { commandId, command, payload, metadata } = commandMsg;
  const userId = client.getUserId();
  const startTime = Date.now();

  try {
    logger.info({
      commandId,
      userId,
      command,
      encrypted: metadata.encrypted,
      priority: metadata.priority,
    }, 'Processing command');

    // Update pending commands gauge
    pendingCommands.inc();

    // 1. Replay attack protection
    if (await replayProtection.isDuplicate(commandId)) {
      logger.warn({ commandId, userId }, 'Replay attack detected');
      replayAttacks.inc();

      await sendCommandAck(client, {
        commandId,
        commandType: command,
        status: 'executed',
        executedAt: Date.now(),
        result: { fromCache: true },
      });
      pendingCommands.dec();
      return;
    }

    // 2. Rate limiting
    const isHeavyCommand = ['chat.delete', 'system.clear_chat', 'system.export_chat'].includes(command);
    const rateLimitOk = isHeavyCommand
      ? await rateLimiter.checkHeavyCommandLimit(userId)
      : await rateLimiter.checkLimit(userId, command, 20, 60 * 1000);

    if (!rateLimitOk) {
      logger.warn({ userId, command }, 'Rate limit exceeded');

      if (isHeavyCommand) {
        rateLimited.inc({ userId, commandType: command });
      }

      await sendCommandError(client, {
        commandId,
        commandType: command,
        error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Слишком много команд.' },
      });
      pendingCommands.dec();
      return;
    }

    // 3. Validate payload
    const schema = commandSchemas[command];
    if (!schema) {
      logger.error({ commandId, command }, 'Unknown command type');
      commandErrors.inc({ type: command, error: 'unknown_command' });

      await sendCommandError(client, {
        commandId,
        commandType: command,
        error: { code: 'UNKNOWN_COMMAND', message: `Неизвестная команда: ${command}` },
      });
      pendingCommands.dec();
      return;
    }

    const validationResult = schema.safeParse(payload);
    if (!validationResult.success) {
      logger.error({ commandId, command, errors: validationResult.error.issues }, 'Payload validation failed');
      commandErrors.inc({ type: command, error: 'validation_error' });

      await sendCommandError(client, {
        commandId,
        commandType: command,
        error: { code: 'VALIDATION_ERROR', message: 'Некорректные данные команды' },
      });
      pendingCommands.dec();
      return;
    }

    // 4. Check permissions (skip for system events)
    const needsPermission = !command.startsWith('system.');
    if (needsPermission) {
      const hasPermission = await checkPermission(userId, command, payload as CommandPayload);
      if (!hasPermission) {
        logger.warn({ commandId, command, userId }, 'Permission denied');
        commandErrors.inc({ type: command, error: 'permission_denied' });

        await sendCommandError(client, {
          commandId,
          commandType: command,
          error: { code: 'PERMISSION_DENIED', message: 'Недостаточно прав' },
        });
        pendingCommands.dec();
        return;
      }
    }

    // 5. Execute command
    const result = await executeCommand(command, payload, userId, manager);

    // 6. Send ack
    await sendCommandAck(client, {
      commandId,
      commandType: command,
      status: 'executed',
      executedAt: Date.now(),
      result,
    });

    // 7. Broadcast event to other devices/users
    await broadcastCommandEvent(commandMsg, result, manager);

    // Record metrics
    const latency = (Date.now() - startTime) / 1000;
    commandTotal.inc({ type: command, status: 'success' });
    // @ts-ignore - prom-client Histogram typing issue
    commandLatency.inc({ type: command }, latency);

    logger.info({
      commandId,
      command,
      latency,
      result,
    }, 'Command executed successfully');

    pendingCommands.dec();

  } catch (error) {
    const latency = (Date.now() - startTime) / 1000;
    commandTotal.inc({ type: command, status: 'error' });
    commandErrors.inc({ type: command, error: 'execution_failed' });

    logger.error({
      commandId,
      command,
      error: error instanceof Error ? error.message : 'Unknown error',
      latency,
    }, 'Command execution failed');

    await sendCommandError(client, {
      commandId,
      commandType: command,
      error: { code: 'COMMAND_FAILED', message: error instanceof Error ? error.message : 'Ошибка' },
    });
    pendingCommands.dec();
  }
}

async function executeCommand(
  command: CommandType,
  payload: CommandPayload,
  issuerId: string,
  manager: WebSocketManager
): Promise<unknown> {
  switch (command) {
    case 'message.delete': return await deleteMessage(payload as MessageDeletePayload, issuerId);
    case 'message.edit': return await editMessage(payload as MessageEditPayload, issuerId);
    case 'message.pin': return await pinMessage(payload as MessagePinPayload, issuerId);
    case 'message.unpin': return await unpinMessage(payload as MessageUnpinPayload, issuerId);
    case 'message.react': return await reactToMessage(payload as MessageReactPayload, issuerId);
    case 'message.unreact': return await unreactFromMessage(payload as MessageUnreactPayload, issuerId);
    case 'message.reply': return await setReply(payload as MessageReplyPayload, issuerId);
    
    case 'chat.delete': return await deleteChat(payload as ChatDeletePayload, issuerId);
    case 'chat.leave': return await leaveChat(payload as ChatLeavePayload, issuerId);
    case 'chat.update': return await updateChat(payload as ChatUpdatePayload, issuerId);
    case 'chat.mute': return await muteChat(payload as ChatMutePayload, issuerId);
    case 'chat.unmute': return await unmuteChat(payload as ChatUnmutePayload, issuerId);
    case 'chat.pin': return await pinChat(payload as ChatPinPayload, issuerId);
    case 'chat.unpin': return await unpinChat(payload as ChatUnpinPayload, issuerId);
    case 'chat.archive': return await archiveChat(payload as ChatArchivePayload, issuerId);
    case 'chat.unarchive': return await unarchiveChat(payload as ChatUnarchivePayload, issuerId);
    
    case 'folder.create': return await createFolder(payload as FolderCreatePayload, issuerId);
    case 'folder.update': return await updateFolder(payload as FolderUpdatePayload, issuerId);
    case 'folder.delete': return await deleteFolder(payload as FolderDeletePayload, issuerId);
    case 'folder.add_chat': return await addChatToFolder(payload as FolderAddChatPayload, issuerId);
    case 'folder.remove_chat': return await removeChatFromFolder(payload as FolderRemoveChatPayload, issuerId);
    case 'folder.reorder': return await reorderFolder(payload as FolderReorderPayload, issuerId);
    
    case 'participant.add': return await addParticipant(payload as ParticipantAddPayload, issuerId, manager);
    case 'participant.remove': return await removeParticipant(payload as ParticipantRemovePayload, issuerId);
    case 'participant.role_update': return await updateParticipantRole(payload as ParticipantRoleUpdatePayload, issuerId);
    
    case 'system.clear_chat': return await clearChat(payload as SystemClearChatPayload, issuerId);
    case 'system.export_chat': return await exportChat(payload as SystemExportChatPayload, issuerId);
    case 'system.report_message': return await reportMessage(payload as SystemReportMessagePayload, issuerId);
    
    case 'device.verification_request':
      // This command is sent to a verified device to generate a verification code
      // The device (client) should generate the code and send it to the system chat
      // The server just logs and acknowledges
      logger.info({
        userId: issuerId,
        payload
      }, 'device.verification_request received - client should generate code');
      return { success: true, message: 'Verification code request acknowledged' };
    
    default: throw new Error(`Unknown command: ${command}`);
  }
}

async function broadcastCommandEvent(
  commandMsg: CommandMessage,
  result: unknown,
  manager: WebSocketManager
): Promise<void> {
  const { command, payload, metadata } = commandMsg;
  
  // Allow command handlers to provide explicit affected users (for chat.delete before cascade delete)
  let targetUserIds: string[];
  if (result && typeof result === 'object' && 'affectedUserIds' in (result as any)) {
    targetUserIds = (result as any).affectedUserIds as string[];
  } else {
    targetUserIds = await getAffectedUsers(command, payload, metadata.issuer.userId);
  }
  
  const eventPayload: CommandEventPayload = {
    commandId: commandMsg.commandId,
    commandType: command,
    issuer: metadata.issuer,
    timestamp: Date.now(),
    payload: commandMsg.payload,
    result,
  };
  
  for (const targetUserId of targetUserIds) {
    // Get ALL active devices for the target user from database
    const userDevices = await prisma.device.findMany({
      where: {
        userId: targetUserId,
        isActive: true
      },
      select: { deviceId: true }
    });
    
    for (const device of userDevices) {
      const deviceId = device.deviceId;
      
      // Skip sender's device — the sender already has the local echo.
      if (deviceId === metadata.issuer.deviceId) {
        continue;
      }
      
      const targetClient = manager.getClient(deviceId);
      if (targetClient && targetClient.isOpen()) {
        // Online: send immediately
        targetClient.send({
          type: 'command_event',
          payload: eventPayload,
          timestamp: Date.now(),
          id: crypto.randomUUID(),
        });
      } else {
        // Offline: store as pending command for later delivery
        try {
          await prisma.pendingCommand.create({
            data: {
              id: `cmd-${commandMsg.commandId}-${deviceId}`,
              userId: targetUserId,
              deviceId: deviceId,
              commandType: command,
              payload: commandMsg.payload as any,
              metadata: commandMsg.metadata as any,
              expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days TTL
            },
          });
          pendingCommands.inc(); // Track pending commands metric
        } catch (error) {
          logger.error({
            commandId: commandMsg.commandId,
            deviceId,
            error: error instanceof Error ? error.message : 'Unknown error'
          }, 'Failed to store pending command');
        }
      }
    }
  }
}

async function sendCommandAck(
  client: WebSocketClient,
  payload: CommandAckPayload
): Promise<void> {
  client.send({
    type: 'command_ack',
    payload,
    timestamp: Date.now(),
    id: crypto.randomUUID(),
  });
}

async function sendCommandError(
  client: WebSocketClient,
  payload: Omit<CommandErrorPayload, 'timestamp'>
): Promise<void> {
  client.send({
    type: 'command_error',
    payload: { ...payload, timestamp: Date.now() },
    timestamp: Date.now(),
    id: crypto.randomUUID(),
  });
}

// ==================== Command Implementations ====================

async function deleteMessage(
  payload: MessageDeletePayload,
  issuerId: string,
): Promise<{ deletedCount: number; affectedUserIds?: string[] }> {
  const { messageId, deleteForEveryone } = payload;

  if (deleteForEveryone) {
    // Only allow deleting pending messages (offline delivery queue)
    // Delivered messages are not stored on server - clients manage their own IndexedDB
    // We delete messages that have pendingDeviceId in metadata (offline queue)
    const deleted = await prisma.$queryRaw<{ id: string }[]>`
      DELETE FROM messages
      WHERE id = ${messageId}
        AND metadata ? 'pendingDeviceId'
      RETURNING id
    `;

    // Also delete any pending commands for this message (if any)
    await prisma.pendingCommand.deleteMany({
      where: {
        commandType: 'message.delete',
        payload: {
          path: ['messageId'],
          equals: messageId,
        },
      },
    });

    // Broadcast goes to all chat participants — getAffectedUsers will
    // resolve them via chatId. We don't pre-compute here because the
    // chat may already be empty, but chatUsers still has rows.
    return { deletedCount: deleted.length };
  }

  // deleteForMe: only the issuer's OTHER devices need to sync —
  // we must NOT broadcast to other chat participants. We override
  // affectedUserIds so broadcastCommandEvent skips everyone except
  // the issuer.
  return { deletedCount: 0, affectedUserIds: [issuerId] };
}

async function editMessage(payload: MessageEditPayload, issuerId: string): Promise<{ edited: boolean }> {
  // C2 (ownership validation): Delivered messages are NOT stored on
  // the server (clients manage their own IndexedDB). However, the
  // server DOES store PENDING messages (offline delivery queue) —
  // those we can authoritatively check.
  //
  // For pending messages: the issuer MUST be the message's author.
  // For delivered messages: ownership is verified client-side when
  // the edit event arrives (issuer.userId in metadata must equal
  // the message's senderId). We additionally support an opt-in
  // `expectedAuthorId` field in the payload: if present and the
  // pending message exists, we verify it matches the stored author
  // AND the issuer.
  const pendingMsg = await prisma.message.findUnique({
    where: { id: payload.messageId },
    select: { authorId: true },
  });
  if (pendingMsg) {
    if (pendingMsg.authorId !== issuerId) {
      throw new Error('Можно редактировать только свои сообщения');
    }
    if (payload.expectedAuthorId && payload.expectedAuthorId !== pendingMsg.authorId) {
      throw new Error('Можно редактировать только свои сообщения');
    }
  } else if (payload.expectedAuthorId && payload.expectedAuthorId !== issuerId) {
    // Delivered message (not on server) — if the client declared an
    // expected author that does not match the issuer, reject. The
    // receiving client will additionally verify against its local
    // copy of the message.
    throw new Error('Можно редактировать только свои сообщения');
  }
  return { edited: true };
}

async function pinMessage(payload: MessagePinPayload, issuerId: string): Promise<{ pinned: boolean }> {
  // Verify user is chat participant (permission check)
  await verifyChatParticipant(payload.chatId, issuerId);
  // No DB operation - clients handle pin state locally via command broadcast
  return { pinned: true };
}

async function unpinMessage(payload: MessageUnpinPayload, issuerId: string): Promise<{ unpinned: boolean }> {
  // Verify user is chat participant (permission check)
  await verifyChatParticipant(payload.chatId, issuerId);
  // No DB operation - clients handle pin state locally via command broadcast
  return { unpinned: true };
}

async function reactToMessage(payload: MessageReactPayload, issuerId: string): Promise<{ reacted: boolean }> {
  await verifyChatParticipant(payload.chatId, issuerId);
  return { reacted: true };
}

async function unreactFromMessage(payload: MessageUnreactPayload, issuerId: string): Promise<{ unreacted: boolean }> {
  await verifyChatParticipant(payload.chatId, issuerId);
  return { unreacted: true };
}

async function setReply(_payload: MessageReplyPayload, _issuerId: string): Promise<{ replySet: boolean }> {
  // No DB operation - clients handle reply state locally via command broadcast
  // Validation (message existence, same chat) is done on client side
  return { replySet: true };
}

async function deleteChat(payload: ChatDeletePayload, issuerId: string): Promise<{ deleted: boolean; affectedUserIds: string[] }> {
  // Проверяем, что пользователь участник чата
  const chatUser = await prisma.chatUser.findUnique({
    where: { chatId_userId: { chatId: payload.chatId, userId: issuerId } },
    select: { role: true, chat: { select: { type: true } } },
  });

  if (!chatUser) {
    throw new Error('Вы не являетесь участником этого чата');
  }

  // Защита специальных чатов: FAVOURITES и SYSTEM нельзя удалить.
  // Они создаются автоматически и не имеют UI для удаления.
  if (['FAVORITES', 'SYSTEM'].includes(chatUser.chat.type)) {
    throw new Error('Этот чат нельзя удалить');
  }

  // Для групповых чатов требуются права OWNER/ADMIN
  if (chatUser.chat.type === 'GROUP' || chatUser.chat.type === 'CHANNEL') {
    if (!['OWNER', 'ADMIN'].includes(chatUser.role)) {
      throw new Error('Только владелец или админ может удалить групповой чат');
    }
  }
  // Для приватных чатов любой участник может удалить чат для всех

  // 1. Получить всех участников чата ДО удаления (для broadcast)
  const chatUsers = await prisma.chatUser.findMany({
    where: { chatId: payload.chatId },
    select: { userId: true },
  });
  const affectedUserIds = chatUsers.map(cu => cu.userId);
  
  // 2. Получить все сообщения чата (включая связанные файлы)
  const messages = await prisma.message.findMany({
    where: { chatId: payload.chatId },
    select: { id: true, file: { select: { id: true } } },
  });
  
  // 3. Собрать ID файлов
  const fileIds = messages
    .map(m => m.file?.id)
    .filter((id): id is string => id !== null && id !== undefined);
  
  // 4. Удалить физические файлы с диска (если есть)
  const fs = await import('fs');
  
  if (fileIds.length > 0) {
    const files = await prisma.file.findMany({
      where: { id: { in: fileIds } },
      select: { id: true, path: true },
    });
    
    for (const file of files) {
      try {
        if (file.path && fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
          logger.info({ fileId: file.id, filePath: file.path }, 'File deleted from disk');
        }
      } catch (error) {
        logger.error({ fileId: file.id, error: error instanceof Error ? error.message : String(error) }, 'Failed to delete file from disk');
        // Продолжаем, даже если не удалось удалить файл
      }
    }
    
    // 5. Удалить записи файлов из БД
    await prisma.file.deleteMany({
      where: { id: { in: fileIds } },
    });
  }
  
  // 6. Удалить все сообщения чата
  await prisma.message.deleteMany({
    where: { chatId: payload.chatId },
  });
  
  // 7. Удалить всех участников чата (включая инициатора)
  await prisma.chatUser.deleteMany({
    where: { chatId: payload.chatId },
  });
  
  // 8. Удалить сам чат
  await prisma.chat.delete({
    where: { id: payload.chatId },
  });
  
  logger.info({ chatId: payload.chatId, deletedBy: issuerId, messageCount: messages.length, fileCount: fileIds.length, affectedUserIds }, 'Chat deleted with all messages and files');
  
  return { deleted: true, affectedUserIds };
}

async function leaveChat(payload: ChatLeavePayload, issuerId: string): Promise<{ left: boolean; affectedUserIds: string[] }> {
  if (payload.userId !== issuerId) throw new Error('Нельзя выгнать другого через leaveChat');

  // Получаем тип чата и роль уходящего — нужны для guard-проверок.
  const chatWithRole = await prisma.chat.findUnique({
    where: { id: payload.chatId },
    select: {
      type: true,
      isGroup: true,
      chatUsers: {
        where: { userId: issuerId },
        select: { role: true },
      },
    },
  });

  if (!chatWithRole) throw new Error('Чат не найден');
  if (chatWithRole.chatUsers.length === 0) {
    throw new Error('Вы не являетесь участником этого чата');
  }

  // Защита специальных чатов: FAVOURITES и SYSTEM нельзя покинуть.
  if (['FAVORITES', 'SYSTEM'].includes(chatWithRole.type)) {
    throw new Error('Этот чат нельзя покинуть');
  }

  const issuerRole = chatWithRole.chatUsers[0]!.role;

  // Capture all chat participants BEFORE deleting the issuer's ChatUser
  // row — otherwise broadcastCommandEvent won't find the issuer in
  // chatUsers and their OTHER devices won't receive the leave event.
  const allParticipants = await prisma.chatUser.findMany({
    where: { chatId: payload.chatId },
    select: { userId: true },
  });
  const affectedUserIds = allParticipants.map(p => p.userId);
  // Ensure the issuer is included (they may already be in the list).
  if (!affectedUserIds.includes(issuerId)) {
    affectedUserIds.push(issuerId);
  }

  // Ownership protection: OWNER не может покинуть GROUP-чат напрямую.
  // Если участников ≥2 — овнер должен сначала передать ownership (тогда
  // он перестанет быть овнером и сможет уйти). Если остался один —
  // удаляем чат целиком (нечего покидать).
  if (issuerRole === 'OWNER' && chatWithRole.isGroup) {
    const remainingCount = allParticipants.length;
    if (remainingCount > 1) {
      throw new Error(
        'Владелец не может покинуть группу — сначала передайте ownership другому участнику',
      );
    }
    // Один участник — просто удаляем чат целиком.
    await prisma.chat.delete({ where: { id: payload.chatId } });
    return { left: true, affectedUserIds };
  }

  await prisma.chatUser.delete({
    where: { chatId_userId: { chatId: payload.chatId, userId: issuerId } },
  });

  // Если после выхода участников не осталось — удаляем чат.
  if (chatWithRole.isGroup) {
    const remainingUsers = await prisma.chatUser.count({ where: { chatId: payload.chatId } });
    if (remainingUsers === 0) {
      await prisma.chat.delete({ where: { id: payload.chatId } });
    }
  }

  // Cleanup pending commands for the leaving user — иначе их другие
  // устройства получат stale events для чата, который они покинули.
  await cleanupPendingDataForUserInChat(issuerId, payload.chatId);

  return { left: true, affectedUserIds };
}

async function updateChat(payload: ChatUpdatePayload, issuerId: string): Promise<{ updated: boolean }> {
  // Только GROUP/CHANNEL-чаты можно редактировать (rename/avatar/description).
  // PRIVATE получает имя из участников, FAVOURITES/SYSTEM защищены.
  const chat = await prisma.chat.findUnique({
    where: { id: payload.chatId },
    select: { type: true },
  });
  if (!chat) throw new Error('Чат не найден');
  if (!['GROUP', 'CHANNEL'].includes(chat.type)) {
    throw new Error('Этот чат нельзя редактировать');
  }

  const chatUser = await prisma.chatUser.findUnique({
    where: { chatId_userId: { chatId: payload.chatId, userId: issuerId } },
    select: { role: true },
  });

  if (!chatUser || !['OWNER', 'ADMIN'].includes(chatUser.role)) {
    throw new Error('Только владелец или админ может изменять настройки чата');
  }

  await prisma.chat.update({
    where: { id: payload.chatId },
    data: payload.updates,
  });

  return { updated: true };
}

async function muteChat(payload: ChatMutePayload, issuerId: string): Promise<{ muted: boolean }> {
  await verifyChatParticipant(payload.chatId, issuerId);
  return { muted: true };
}

async function unmuteChat(payload: ChatUnmutePayload, issuerId: string): Promise<{ unmuted: boolean }> {
  await verifyChatParticipant(payload.chatId, issuerId);
  return { unmuted: true };
}

async function pinChat(payload: ChatPinPayload, issuerId: string): Promise<{ pinned: boolean }> {
  await verifyChatParticipant(payload.chatId, issuerId);
  return { pinned: true };
}

async function unpinChat(payload: ChatUnpinPayload, issuerId: string): Promise<{ unpinned: boolean }> {
  await verifyChatParticipant(payload.chatId, issuerId);
  return { unpinned: true };
}

async function archiveChat(payload: ChatArchivePayload, issuerId: string): Promise<{ archived: boolean }> {
  await verifyChatParticipant(payload.chatId, issuerId);
  return { archived: true };
}

async function unarchiveChat(payload: ChatUnarchivePayload, issuerId: string): Promise<{ unarchived: boolean }> {
  await verifyChatParticipant(payload.chatId, issuerId);
  return { unarchived: true };
}

async function createFolder(payload: FolderCreatePayload, issuerId: string): Promise<{ folderId: string }> {
  const folder = await prisma.userFolder.create({
    data: {
      id: crypto.randomUUID(),
      userId: issuerId,
      name: payload.name,
      color: payload.color ?? null,
      order: payload.order,
    },
  });
  return { folderId: folder.id };
}

async function updateFolder(payload: FolderUpdatePayload, issuerId: string): Promise<{ updated: boolean }> {
  const folder = await prisma.userFolder.findUnique({ where: { id: payload.folderId } });
  if (!folder || folder.userId !== issuerId) throw new Error('Папка не найдена или доступ запрещен');
  
  await prisma.userFolder.update({
    where: { id: payload.folderId },
    data: payload.updates,
  });
  
  return { updated: true };
}

async function deleteFolder(payload: FolderDeletePayload, issuerId: string): Promise<{ deleted: boolean }> {
  const folder = await prisma.userFolder.findUnique({ where: { id: payload.folderId } });
  if (!folder || folder.userId !== issuerId) throw new Error('Папка не найдена или доступ запрещен');
  
  if (payload.moveChatsTo) {
    await prisma.chatFolderItem.updateMany({
      where: { folderId: payload.folderId },
      data: { folderId: payload.moveChatsTo },
    });
  }
  
  await prisma.userFolder.delete({ where: { id: payload.folderId } });
  return { deleted: true };
}

async function addChatToFolder(payload: FolderAddChatPayload, issuerId: string): Promise<{ added: boolean }> {
  const folder = await prisma.userFolder.findUnique({ where: { id: payload.folderId } });
  if (!folder || folder.userId !== issuerId) throw new Error('Папка не найдена или доступ запрещен');
  
  const chatUser = await prisma.chatUser.findUnique({
    where: { chatId_userId: { chatId: payload.chatId, userId: issuerId } },
  });
  if (!chatUser) throw new Error('Чат не найден или вы не участник');
  
  await prisma.chatFolderItem.upsert({
    where: { folderId_chatId: { folderId: payload.folderId, chatId: payload.chatId } },
    update: {},
    create: { id: crypto.randomUUID(), folderId: payload.folderId, chatId: payload.chatId },
  });
  
  return { added: true };
}

async function removeChatFromFolder(payload: FolderRemoveChatPayload, issuerId: string): Promise<{ removed: boolean }> {
  const folder = await prisma.userFolder.findUnique({ where: { id: payload.folderId } });
  if (!folder || folder.userId !== issuerId) throw new Error('Папка не найдена или доступ запрещен');
  
  await prisma.chatFolderItem.delete({
    where: { folderId_chatId: { folderId: payload.folderId, chatId: payload.chatId } },
  });
  
  return { removed: true };
}

async function reorderFolder(payload: FolderReorderPayload, issuerId: string): Promise<{ reordered: boolean }> {
  const folder = await prisma.userFolder.findUnique({ where: { id: payload.folderId } });
  if (!folder || folder.userId !== issuerId) throw new Error('Папка не найдена или доступ запрещен');
  
  await prisma.userFolder.update({
    where: { id: payload.folderId },
    data: { order: payload.newOrder },
  });
  
  return { reordered: true };
}

async function addParticipant(payload: ParticipantAddPayload, issuerId: string, manager: WebSocketManager): Promise<{ added: boolean }> {
  // GROUP-type guard: участник можно добавить только в GROUP/CHANNEL.
  // PRIVATE-чаты создаются через REST createPrivateChat, FAVOURITES/SYSTEM —
  // системные.
  const chat = await prisma.chat.findUnique({
    where: { id: payload.chatId },
    select: { type: true },
  });
  if (!chat) throw new Error('Чат не найден');
  if (!['GROUP', 'CHANNEL'].includes(chat.type)) {
    throw new Error('Участников можно добавлять только в групповой чат');
  }

  const chatUser = await prisma.chatUser.findUnique({
    where: { chatId_userId: { chatId: payload.chatId, userId: issuerId } },
    select: { role: true },
  });

  if (!chatUser || !['OWNER', 'ADMIN'].includes(chatUser.role)) {
    throw new Error('Только владелец или админ может добавлять участников');
  }

  const existing = await prisma.chatUser.findUnique({
    where: { chatId_userId: { chatId: payload.chatId, userId: payload.userId } },
  });
  if (existing) throw new Error('Пользователь уже в чате');

  await prisma.chatUser.create({
    data: {
      id: crypto.randomUUID(),
      chatId: payload.chatId,
      userId: payload.userId,
      role: payload.role ?? 'MEMBER',
      joinedAt: new Date(),
    },
  });

  // F8: broadcast `system.participant_joined` to all current participants
  // (including the newly-added user — they need it to know they were
  // added, since their client doesn't otherwise get a notification
  // about their own addition). Best-effort: errors are logged inside
  // `broadcastSystemEvent` and don't fail the parent command.
  try {
    // Fetch the added user's username + all current participant IDs.
    const [addedUser, allParticipants] = await Promise.all([
      prisma.user.findUnique({
        where: { id: payload.userId },
        select: { username: true },
      }),
      prisma.chatUser.findMany({
        where: { chatId: payload.chatId },
        select: { userId: true },
      }),
    ]);

    if (addedUser) {
      await broadcastSystemEvent(
        'system.participant_joined',
        {
          chatId: payload.chatId,
          userId: payload.userId,
          username: addedUser.username,
          joinedAt: Date.now(),
          inviterId: issuerId,
        },
        allParticipants.map(p => p.userId),
        manager,
      );
    }
  } catch (err) {
    logger.error(
      {
        chatId: payload.chatId,
        addedUserId: payload.userId,
        issuerId,
        error: err instanceof Error ? err.message : String(err),
      },
      'addParticipant: failed to broadcast system.participant_joined',
    );
  }

  return { added: true };
}

async function removeParticipant(payload: ParticipantRemovePayload, issuerId: string): Promise<{ removed: boolean }> {
  // GROUP-type guard
  const chat = await prisma.chat.findUnique({
    where: { id: payload.chatId },
    select: { type: true },
  });
  if (!chat) throw new Error('Чат не найден');
  if (!['GROUP', 'CHANNEL'].includes(chat.type)) {
    throw new Error('Участников можно исключать только из группового чата');
  }

  const chatUser = await prisma.chatUser.findUnique({
    where: { chatId_userId: { chatId: payload.chatId, userId: issuerId } },
    select: { role: true },
  });

  if (!chatUser || !['OWNER', 'ADMIN'].includes(chatUser.role)) {
    throw new Error('Только владелец или админ может исключать участников');
  }

  // Ownership protection: никто не может исключить OWNER.
  // Владелец должен сначала передать ownership (см. updateParticipantRole),
  // либо удалить чат целиком (см. deleteChat).
  const targetRole = await prisma.chatUser.findUnique({
    where: { chatId_userId: { chatId: payload.chatId, userId: payload.userId } },
    select: { role: true },
  });
  if (!targetRole) throw new Error('Пользователь не является участником чата');
  if (targetRole.role === 'OWNER') {
    throw new Error('Владельца нельзя исключить — сначала передайте ownership другому участнику');
  }
  // Админ может исключать только MEMBER (не другого админа/модератора).
  if (chatUser.role === 'ADMIN' && targetRole.role !== 'MEMBER') {
    throw new Error('Админ может исключать только обычных участников');
  }

  await prisma.chatUser.delete({
    where: { chatId_userId: { chatId: payload.chatId, userId: payload.userId } },
  });

  // Cleanup pending commands for the removed user — иначе когда их
  // другие устройства пользователя придут онлайн, они получат stale
  // events (message.edit/pin/etc.) для чата, в котором их уже нет.
  await cleanupPendingDataForUserInChat(payload.userId, payload.chatId);

  return { removed: true };
}

async function updateParticipantRole(payload: ParticipantRoleUpdatePayload, issuerId: string): Promise<{ roleUpdated: boolean }> {
  // GROUP-type guard
  const chat = await prisma.chat.findUnique({
    where: { id: payload.chatId },
    select: { type: true },
  });
  if (!chat) throw new Error('Чат не найден');
  if (!['GROUP', 'CHANNEL'].includes(chat.type)) {
    throw new Error('Роли можно менять только в групповом чате');
  }

  const chatUser = await prisma.chatUser.findUnique({
    where: { chatId_userId: { chatId: payload.chatId, userId: issuerId } },
    select: { role: true },
  });

  if (!chatUser || chatUser.role !== 'OWNER') {
    throw new Error('Только владелец может изменять роли');
  }

  // Целевой пользователь должен быть участником.
  const targetChatUser = await prisma.chatUser.findUnique({
    where: { chatId_userId: { chatId: payload.chatId, userId: payload.userId } },
    select: { role: true },
  });
  if (!targetChatUser) throw new Error('Пользователь не является участником чата');

  // Ownership transfer logic:
  // - Если newRole === 'OWNER' — это передача ownership: текущий овнер
  //   становится ADMIN, целевой пользователь становится OWNER. Атомарно.
  // - Если targetUserRole === 'OWNER' и newRole !== 'OWNER' — отказ:
  //   нельзя понизить овнера напрямую, только через передачу.
  // - Иначе — обычное обновление роли.
  if (payload.newRole === 'OWNER') {
    // Передача ownership: атомарно повышаем target до OWNER и понижаем
    // текущего овнера (issuer) до ADMIN. Без транзакции может возникнуть
    // окно с двумя овнерами или нулем овнеров.
    await prisma.$transaction([
      prisma.chatUser.update({
        where: { chatId_userId: { chatId: payload.chatId, userId: payload.userId } },
        data: { role: 'OWNER' },
      }),
      prisma.chatUser.update({
        where: { chatId_userId: { chatId: payload.chatId, userId: issuerId } },
        data: { role: 'ADMIN' },
      }),
    ]);
    return { roleUpdated: true };
  }

  if (targetChatUser.role === 'OWNER') {
    throw new Error(
      'Нельзя изменить роль владельца напрямую — используйте передачу ownership (newRole: OWNER)',
    );
  }

  await prisma.chatUser.update({
    where: { chatId_userId: { chatId: payload.chatId, userId: payload.userId } },
    data: { role: payload.newRole },
  });

  return { roleUpdated: true };
}

async function clearChat(payload: SystemClearChatPayload, issuerId: string): Promise<{ cleared: boolean }> {
  await verifyChatParticipant(payload.chatId, issuerId);
  
  if (payload.clearFor === 'everyone') {
    const chatUser = await prisma.chatUser.findUnique({
      where: { chatId_userId: { chatId: payload.chatId, userId: issuerId } },
      select: { role: true },
    });
    
    if (!chatUser || !['OWNER', 'ADMIN'].includes(chatUser.role)) {
      throw new Error('Только владелец или админ может очистить чат для всех');
    }
    
    // Only delete pending messages (offline queue)
    // Delivered messages are not stored on server
    await prisma.$executeRaw`
      DELETE FROM messages
      WHERE "chatId" = ${payload.chatId}
        AND metadata ? 'pendingDeviceId'
    `;
  }
  
  return { cleared: true };
}

async function exportChat(payload: SystemExportChatPayload, issuerId: string): Promise<{ exportUrl: string }> {
  await verifyChatParticipant(payload.chatId, issuerId);
  return { exportUrl: `/api/chats/${payload.chatId}/export?format=${payload.format}` };
}

async function reportMessage(payload: SystemReportMessagePayload, issuerId: string): Promise<{ reported: boolean }> {
  await verifyChatParticipant(payload.chatId, issuerId);
  console.log('[Command] Message reported:', payload, 'by:', issuerId);
  return { reported: true };
}

// ==================== Helper Functions ====================

function extractTargets(command: CommandType, payload: CommandPayload): { chatId?: string; userId?: string; folderId?: string } {
  // Folder commands: resolve via folderId FIRST (before chatId) so that
  // folder.add_chat / folder.remove_chat don't accidentally broadcast to
  // all chat participants — only the folder owner should receive them.
  if (command.startsWith('folder.') && 'folderId' in payload) {
    return { folderId: payload.folderId as string };
  }
  if ('chatId' in payload) return { chatId: payload.chatId as string };
  if ('userId' in payload) return { userId: payload.userId as string };
  return {};
}

/**
 * Per-user commands: these mutate the issuer's per-chat state
 * (mute/archive/pin folders). They MUST NOT be broadcast to other
 * chat participants — that would leak the issuer's per-user view
 * (e.g. Alice mutes a chat with Bob → Bob would receive a
 * `chat.mute` event and could infer Alice muted him).
 *
 * The broadcast for these commands goes ONLY to the issuer's OTHER
 * devices (for multi-device sync), never to other participants.
 */
const PER_USER_COMMANDS = new Set<CommandType>([
  'chat.mute',
  'chat.unmute',
  'chat.archive',
  'chat.unarchive',
  'chat.pin',
  'chat.unpin',
]);

async function getAffectedUsers(
  command: CommandType,
  payload: CommandPayload,
  issuerUserId?: string,
): Promise<string[]> {
  const targets = extractTargets(command, payload);
  const affectedUsers = new Set<string>();

  // PER_USER_COMMANDS short-circuit: only the issuer's other
  // devices need to sync. We deliberately skip the chatId lookup
  // (saving a SQL round-trip) and avoid leaking the issuer's
  // per-user state to other chat participants.
  if (PER_USER_COMMANDS.has(command)) {
    if (issuerUserId) {
      affectedUsers.add(issuerUserId);
    }
    return Array.from(affectedUsers);
  }

  if (targets.folderId) {
    // Folder commands are per-user: resolve folderId → userId and
    // broadcast ONLY to the folder owner's devices.
    const folder = await prisma.userFolder.findUnique({
      where: { id: targets.folderId },
      select: { userId: true },
    });
    if (folder) {
      affectedUsers.add(folder.userId);
    }
  } else if (targets.chatId) {
    const chatUsers = await prisma.chatUser.findMany({
      where: { chatId: targets.chatId },
      select: { userId: true },
    });
    chatUsers.forEach(cu => affectedUsers.add(cu.userId));
  } else if (targets.userId) {
    affectedUsers.add(targets.userId);
  }

  // Always include the issuer so their OTHER devices get the event.
  // The sender's CURRENT device is excluded in broadcastCommandEvent
  // via the deviceId check. This ensures that any command executed on
  // one device (e.g. folder.create, folder.reorder) is synced to all
  // of the issuer's other devices — even for commands without a chatId
  // or userId in the payload.
  if (issuerUserId) {
    affectedUsers.add(issuerUserId);
  }

  return Array.from(affectedUsers);
}

async function verifyChatParticipant(chatId: string, userId: string): Promise<void> {
  const chatUser = await prisma.chatUser.findUnique({
    where: { chatId_userId: { chatId, userId } },
  });
  
  if (!chatUser) throw new Error('Вы не являетесь участником этого чата');
}

/**
 * Cleanup pending data for a user that has been removed from (or has
 * left) a chat. When their other devices come back online, they would
 * otherwise receive stale command events (message.edit, message.pin,
 * chat.update, etc.) for a chat they no longer have access to — which
 * would either error out on the client or, worse, desync their local
 * state.
 *
 * We also delete pending MESSAGES (the encrypted blobs stored for
 * offline devices) so a removed user's devices don't decrypt a
 * message that was sent before they were removed but delivered after.
 *
 * We match on `payload->>'chatId' = $chatId` (the JSONB column is
 * indexed well enough for this volume), and only for commands that
 * target a specific chat. Commands without a chatId (folder.create,
 * etc.) are not affected.
 */
async function cleanupPendingDataForUserInChat(
  userId: string,
  chatId: string,
): Promise<void> {
  try {
    // The `payload` column is JSONB. We use a JSONB filter via Prisma's
    // `path` + `equals` predicate — this is the same pattern used by
    // deleteMessage's pending-command cleanup.
    await prisma.pendingCommand.deleteMany({
      where: {
        userId,
        OR: [
          { payload: { path: ['chatId'], equals: chatId } },
          // Some commands (e.g. message.* family) store chatId at the
          // top level of payload — handled by the path above.
          // No nested variants exist today, but the OR is here for
          // future-proofing.
        ],
      },
    });

    // Delete pending encrypted message blobs authored for this user's
    // devices in this chat. The `messages.metadata->>'pendingDeviceId'`
    // field is set by multi-device-handlers.ts / group-handlers.ts
    // when a message is queued for an offline device. We resolve the
    // user's devices via a subquery so the cleanup works even if the
    // device rows have changed since the message was queued.
    //
    // We use $executeRawUnsafe with explicit parameters to avoid any
    // issues with Prisma's tagged-template SQL parser and the
    // PostgreSQL JSONB `->>` operator.
    await prisma.$executeRawUnsafe(
      `DELETE FROM messages
       WHERE "chatId" = $1
         AND metadata->>'pendingDeviceId' IN (
           SELECT "deviceId" FROM devices WHERE "userId" = $2
         )`,
      chatId,
      userId,
    );
  } catch (error) {
    // Don't fail the parent operation (leaveChat/removeParticipant)
    // just because cleanup failed — log and move on.
    logger.error(
      {
        userId,
        chatId,
        error: error instanceof Error ? error.message : String(error),
      },
      'Failed to cleanup pending data for removed user',
    );
  }
}

// ==================== System Event Broadcast (F8) ====================

/**
 * Broadcast a SYSTEM command event (no issuer / no ack) to the given
 * target users' devices. Used by:
 *
 *   - `services/chats.ts:createGroupChat` → emits `system.chat_created`
 *     to all initial participants (including the creator).
 *   - `command-handlers.ts:addParticipant` → emits
 *     `system.participant_joined` to all current participants
 *     (including the newly-added user).
 *
 * Unlike `broadcastCommandEvent`, system events:
 *   - Have `issuer = { userId: 'system', deviceId: 'system' }` (a
 *     sentinel — no real device will match it, so we never skip any
 *     recipient on the "sender's current device" check).
 *   - Don't carry a `commandId` from a client envelope — we generate
 *     a server-side `sys-<uuid>` so the client's command-bus dedup
 *     logic (which keys on commandId) treats each one as unique.
 *   - Are best-effort persisted as `PendingCommand` rows for offline
 *     devices with a 7-day TTL (same as regular command events).
 *
 * Errors per-device are logged but do NOT abort the broadcast —
 * a failure storing one user's pending command shouldn't prevent
 * other participants from receiving the event.
 *
 * @param command The system command type (must be in `system.*` namespace)
 * @param payload The system event payload (validated against `commandSchemas[command]`)
 * @param targetUserIds User IDs to deliver to (across ALL their active devices)
 * @param manager The WebSocket manager (used to look up online clients)
 */
export async function broadcastSystemEvent(
  command: CommandType,
  payload: CommandPayload,
  targetUserIds: string[],
  manager: WebSocketManager | null,
): Promise<void> {
  // Server-side commandId — `sys-<uuid>` prefix lets clients identify
  // system-originated events if they ever need to.
  const commandId = `sys-${crypto.randomUUID()}`;
  const issuer = { userId: 'system', deviceId: 'system' };
  const eventPayload: CommandEventPayload = {
    commandId,
    commandType: command,
    issuer,
    timestamp: Date.now(),
    payload,
    result: {},
  };

  for (const targetUserId of targetUserIds) {
    // Look up the user's active devices from the DB. We need the
    // deviceId (session UUID, e.g. "dev_xxx") to find the right WS
    // client in the manager AND to store pending commands for offline
    // delivery.
    const userDevices = await prisma.device.findMany({
      where: {
        userId: targetUserId,
        isActive: true,
      },
      select: { deviceId: true },
    });

    for (const device of userDevices) {
      const deviceId = device.deviceId;
      // Skip the "system" sentinel — would never match a real device
      // anyway, but defensive.
      if (deviceId === 'system') continue;

      // Try to deliver online first.
      const targetClient = manager?.getClient(deviceId);
      if (targetClient && targetClient.isOpen()) {
        try {
          targetClient.send({
            type: 'command_event',
            payload: eventPayload,
            timestamp: Date.now(),
            id: crypto.randomUUID(),
          });
        } catch (err) {
          logger.error(
            {
              commandId,
              command,
              userId: targetUserId,
              deviceId,
              error: err instanceof Error ? err.message : String(err),
            },
            'broadcastSystemEvent: failed to send online command_event',
          );
        }
        continue;
      }

      // Offline: store as pending command for later delivery.
      try {
        await prisma.pendingCommand.create({
          data: {
            id: `${commandId}-${deviceId}`,
            userId: targetUserId,
            deviceId,
            commandType: command,
            payload: payload as any,
            metadata: {
              issuer,
              encrypted: false,
              priority: 'normal',
            } as any,
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          },
        });
        pendingCommands.inc();
      } catch (err) {
        logger.error(
          {
            commandId,
            command,
            userId: targetUserId,
            deviceId,
            error: err instanceof Error ? err.message : String(err),
          },
          'broadcastSystemEvent: failed to store pending command',
        );
      }
    }
  }
}

// ==================== Exports ====================

export {
  executeCommand,
  broadcastCommandEvent,
  sendCommandAck,
  sendCommandError,
  RateLimiter,
  ReplayProtection,
};