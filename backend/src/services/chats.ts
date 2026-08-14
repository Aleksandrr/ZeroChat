/**
 * Chat Service - Бизнес-логика для управления чатами
 *
 * Включает:
 * - Создание приватных и групповых чатов
 * - Управление участниками
 * - Права доступа и роли
 * - Системные чаты
 */

import { prisma } from '../prisma/client';
import { Prisma } from '@prisma/client';
import crypto from 'crypto';

// F8: `wsManager` is a live binding — it's `undefined` at module-eval
// time (because ws/index.ts hasn't run setupWebSocketRoutes yet) but
// populated by the time any HTTP route handler calls createGroupChat.
// `broadcastSystemEvent` accepts `manager: WebSocketManager | null`
// and gracefully degrades to "store as pending" for offline delivery
// when manager is null/undefined.
import { wsManager } from '../ws';
import { broadcastSystemEvent } from '../ws/handler/handlers/command-handlers';

// ==================== Constants ====================

export const CHAT_LIMITS = {
  MAX_CHATS_PER_USER: 1000,
  MAX_GROUP_NAME_LENGTH: 100,
  MAX_MESSAGE_LENGTH: 10000,
  MAX_PARTICIPANTS_IN_BATCH: 100,
  DEFAULT_INVITE_EXPIRY_HOURS: 24,
  MAX_INVITE_EXPIRY_HOURS: 168, // 7 days
} as const;

export const CHAT_CONSTANTS = {
  RATE_LIMIT_WINDOW: '1 minute',
  RATE_LIMIT_MAX: 20,
} as const;

// ==================== Types ====================

export type ChatRole = 'OWNER' | 'ADMIN' | 'MODERATOR' | 'MEMBER';
export type ChatType = 'PRIVATE' | 'GROUP' | 'CHANNEL' | 'SYSTEM' | 'FAVORITES';
export type HistoryAccess = 'ALL' | 'FROM_NOW' | 'NONE';

// ==================== Favorites Chat ====================

/**
 * Получить или создать чат избранного для пользователя
 * Чат избранного создаётся автоматически при регистрации
 */
export async function getOrCreateFavoritesChat(userId: string): Promise<ChatInfo> {
  // Ищем существующий чат избранного
  const existingChat = await prisma.chat.findFirst({
    where: {
      type: 'FAVORITES',
      chatUsers: {
        some: { userId },
      },
    },
    include: {
      chatUsers: {
        include: {
          user: {
            select: {
              id: true,
              username: true,
              displayName: true,
              avatar: true,
              status: true,
              lastSeen: true,
            },
          },
        },
      },
    },
  });

  if (existingChat) {
    return {
      id: existingChat.id,
      name: existingChat.name,
      type: 'FAVORITES',
      avatar: existingChat.avatar,
      isGroup: false,
      isSystem: false,
      createdAt: existingChat.createdAt,
      updatedAt: existingChat.updatedAt,
      createdById: existingChat.createdById,
      participants: existingChat.chatUsers.map((cu) => ({
        userId: cu.user.id,
        username: cu.user.username,
        displayName: cu.user.displayName ?? null,
        avatar: cu.user.avatar ?? null,
        status: cu.user.status.toLowerCase(),
        lastSeen: cu.user.lastSeen?.toISOString() ?? null,
        deviceId: '',
        needsSession: false,
        role: cu.role as ChatRole,
        joinedAt: cu.joinedAt,
      })),
    };
  }

  // Создаём новый чат избранного
  return createFavoritesChat(userId);
}

/**
 * Создать чат избранного для пользователя
 * Вызывается при регистрации пользователя
 */
export async function createFavoritesChat(userId: string): Promise<ChatInfo> {
  const chat = await prisma.chat.create({
    data: {
      type: 'FAVORITES',
      name: 'Избранное',
      isGroup: false,
      createdById: userId,
      chatUsers: {
        create: [
          { userId, role: 'OWNER' },
        ],
      },
    },
    include: {
      chatUsers: {
        include: {
          user: {
            select: {
              id: true,
              username: true,
              displayName: true,
              avatar: true,
              status: true,
              lastSeen: true,
            },
          },
        },
      },
    },
  });

  return {
    id: chat.id,
    name: chat.name,
    type: 'FAVORITES',
    avatar: chat.avatar,
    isGroup: false,
    isSystem: false,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    createdById: chat.createdById,
    participants: chat.chatUsers.map((cu) => ({
      userId: cu.user.id,
      username: cu.user.username,
      displayName: cu.user.displayName ?? null,
      avatar: cu.user.avatar ?? null,
      status: cu.user.status.toLowerCase(),
      lastSeen: cu.user.lastSeen?.toISOString() ?? null,
      deviceId: '',
      needsSession: false,
      role: cu.role as ChatRole,
      joinedAt: cu.joinedAt,
    })),
  };
}

/**
 * Проверить, является ли чат избранным
 */
export async function isFavoritesChat(chatId: string): Promise<boolean> {
  const chat = await prisma.chat.findUnique({
    where: { id: chatId },
    select: { type: true },
  });
  return chat?.type === 'FAVORITES';
}

export interface ChatParticipant {
  userId: string;
  username: string;
  displayName?: string | null;
  avatar?: string | null;
  status?: string;
  lastSeen?: string | null;
  deviceId: string;
  needsSession: boolean;
  role?: ChatRole;
  joinedAt?: Date;
}

export interface ChatInfo {
  id: string;
  name?: string | null;
  type: ChatType;
  avatar?: string | null;
  isGroup: boolean;
  isSystem?: boolean;
  createdAt: Date;
  updatedAt: Date;
  createdById?: string | null;
  requireApproval?: boolean;
  historyAccess?: HistoryAccess;
  inviteCode?: string | null;
  inviteCodeExpiresAt?: Date | null;
  participants: ChatParticipant[];
}

export interface CreatePrivateChatInput {
  currentUserId: string;
  contactUsername: string;
}

export interface CreateGroupChatInput {
  currentUserId: string;
  name: string;
  participantUsernames: string[];
  requireApproval?: boolean | undefined;
  historyAccess?: HistoryAccess | undefined;
  avatar?: string | undefined;
}

export interface MarkAsReadInput {
  chatId: string;
  userId: string;
  messageIds?: string[] | undefined;
}

export interface MarkAsReadResult {
  markedCount: number;
  chatId: string;
  readAt: string;
  messageIds: string[];
}

export interface InviteLinkResult {
  chatId: string;
  inviteCode: string;
  expiresAt: string;
  inviteUrl: string;
}

export interface JoinResult {
  chatId: string;
  chatName?: string | null;
  isNewChat: boolean;
  requiresApproval?: boolean;
  message: string;
}

// ==================== Errors ====================

export class ChatError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 400
  ) {
    super(message);
    this.name = 'ChatError';
  }
}

// ==================== Helper Functions ====================

/**
 * Проверить, достигнут ли лимит чатов у пользователя
 */
export async function checkChatLimit(userId: string): Promise<boolean> {
  const chatCount = await prisma.chatUser.count({
    where: { userId },
  });
  return chatCount < CHAT_LIMITS.MAX_CHATS_PER_USER;
}

/**
 * Получить роль пользователя в чате
 */
export async function getUserRole(
  chatId: string,
  userId: string
): Promise<ChatRole | null> {
  const chatUser = await prisma.chatUser.findUnique({
    where: { chatId_userId: { chatId, userId } },
    select: { role: true },
  });
  return (chatUser?.role as ChatRole) || null;
}

/**
 * Проверить, является ли пользователь участником чата
 */
export async function isChatParticipant(
  chatId: string,
  userId: string
): Promise<boolean> {
  const chatUser = await prisma.chatUser.findUnique({
    where: { chatId_userId: { chatId, userId } },
  });
  return !!chatUser;
}

/**
 * Проверить права на изменение ролей
 */
export function canChangeRoles(
  currentUserRole: ChatRole,
  targetUserRole: ChatRole
): boolean {
  if (currentUserRole !== 'OWNER') return false;
  if (targetUserRole === 'OWNER') return false;
  return true;
}

/**
 * Проверить права на удаление участника
 */
export function canRemoveParticipant(
  currentUserRole: ChatRole,
  targetUserRole: ChatRole
): boolean {
  if (currentUserRole === 'OWNER') return targetUserRole !== 'OWNER';
  if (currentUserRole === 'ADMIN') return targetUserRole === 'MEMBER';
  return false;
}

// ==================== Chat Operations ====================

/**
 * Найти существующий приватный чат между двумя пользователями
 */
export async function findExistingPrivateChat(
  userId1: string,
  userId2: string
) {
  const existingChat = await prisma.chat.findFirst({
    where: {
      type: 'PRIVATE',
      isGroup: false,
      AND: [
        { chatUsers: { some: { userId: userId1 } } },
        { chatUsers: { some: { userId: userId2 } } },
      ],
    },
    include: {
      chatUsers: {
        include: {
          user: {
            select: {
              id: true,
              username: true,
              displayName: true,
              status: true,
              lastSeen: true,
            },
          },
        },
      },
      _count: { select: { chatUsers: true } },
    },
  });

  // Возвращаем только если это точно 1:1 чат (2 участника)
  if (existingChat && existingChat._count.chatUsers === 2) {
    return existingChat;
  }
  return null;
}

/**
 * Получить информацию об устройствах пользователя
 */
export async function getUserDevicesInfo(userId: string) {
  const [deviceKeys, devices] = await Promise.all([
    prisma.deviceKeys.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.device.findMany({
      where: { userId, isActive: true },
      select: { deviceId: true, signalDeviceId: true, name: true, type: true },
    }),
  ]);

  return {
    hasKeys: !!deviceKeys,
    devices,
    primaryDevice: devices[0] || null,
  };
}

/**
 * Создать новый приватный чат
 */
export async function createPrivateChat({
  currentUserId,
  contactUsername,
}: CreatePrivateChatInput): Promise<{
  chat: ChatInfo;
  isNew: boolean;
}> {
  // Проверяем лимит
  const withinLimit = await checkChatLimit(currentUserId);
  if (!withinLimit) {
    throw new ChatError(
      `Maximum chats limit reached (${CHAT_LIMITS.MAX_CHATS_PER_USER})`,
      'CHAT_LIMIT_REACHED',
      400
    );
  }

  // Находим контакт
  const contactUser = await prisma.user.findUnique({
    where: { username: contactUsername },
    select: {
      id: true,
      username: true,
      displayName: true,
      status: true,
      lastSeen: true,
    },
  });

  if (!contactUser) {
    throw new ChatError('User not found', 'USER_NOT_FOUND', 404);
  }

  // Проверяем, что не создаём чат с самим собой
  if (contactUser.id === currentUserId) {
    throw new ChatError('Cannot create chat with yourself', 'SELF_CHAT', 400);
  }

  // Проверяем существующий чат
  const existingChat = await findExistingPrivateChat(currentUserId, contactUser.id);
  if (existingChat) {
    const contactDevices = await getUserDevicesInfo(contactUser.id);
    
    const participants: ChatParticipant[] = existingChat.chatUsers.map((cu) => {
      const isContact = cu.userId === contactUser.id;
      return {
        userId: cu.user.id,
        username: cu.user.username,
        displayName: cu.user.displayName ?? null,
        status: cu.user.status.toLowerCase(),
        lastSeen: cu.user.lastSeen?.toISOString() ?? null,
        deviceId: isContact ? contactDevices.primaryDevice?.signalDeviceId?.toString() || '' : '',
        needsSession: isContact && !contactDevices.hasKeys,
      };
    });

    return {
      chat: {
        id: existingChat.id,
        type: 'PRIVATE',
        isGroup: false,
        createdAt: existingChat.createdAt,
        updatedAt: existingChat.updatedAt,
        participants,
      },
      isNew: false,
    };
  }

  // Получаем устройства контакта
  const contactDevices = await getUserDevicesInfo(contactUser.id);

  // Создаём чат
  const newChat = await prisma.chat.create({
    data: {
      type: 'PRIVATE',
      isGroup: false,
      createdById: currentUserId,
      chatUsers: {
        create: [
          { userId: currentUserId, role: 'OWNER' },
          { userId: contactUser.id, role: 'MEMBER' },
        ],
      },
    },
    include: {
      chatUsers: {
        include: {
          user: {
            select: {
              id: true,
              username: true,
              displayName: true,
              status: true,
              lastSeen: true,
            },
          },
        },
      },
    },
  });

  // Note: Initial message creation removed - messages are not stored on server
  // Clients handle initial messages locally via IndexedDB

  const needsSession = !contactDevices.hasKeys;
  const participants: ChatParticipant[] = newChat.chatUsers.map((cu) => {
    const isContact = cu.userId === contactUser.id;
    return {
      userId: cu.user.id,
      username: cu.user.username,
        displayName: cu.user.displayName ?? null,
      status: cu.user.status.toLowerCase(),
        lastSeen: cu.user.lastSeen?.toISOString() ?? null,
      deviceId: isContact ? contactDevices.primaryDevice?.signalDeviceId?.toString() || '' : '',
      needsSession: isContact && needsSession,
    };
  });

  return {
    chat: {
      id: newChat.id,
      type: 'PRIVATE',
      isGroup: false,
      createdAt: newChat.createdAt,
      updatedAt: newChat.updatedAt,
      participants,
    },
    isNew: true,
  };
}

/**
 * Получить информацию о чате
 */
export async function getChatById(chatId: string, userId: string) {
  const chat = await prisma.chat.findUnique({
    where: { id: chatId },
    include: {
      chatUsers: {
        include: {
          user: {
            select: {
              id: true,
              username: true,
              displayName: true,
              avatar: true,
              status: true,
              lastSeen: true,
            },
          },
        },
      },
      messages: {
        take: 50,
        orderBy: { createdAt: 'desc' },
        include: {
          author: {
            select: { id: true, username: true },
          },
        },
      },
    },
  });

  if (!chat) {
    throw new ChatError('Chat not found', 'CHAT_NOT_FOUND', 404);
  }

  const isParticipant = chat.chatUsers.some((cu) => cu.userId === userId);
  if (!isParticipant) {
    throw new ChatError('Access denied', 'ACCESS_DENIED', 403);
  }

  return {
    ...chat,
    isSystem: chat.type === 'SYSTEM', // Добавляем флаг системного чата
    messages: chat.messages.reverse(),
  };
}

/**
 * Получить список чатов пользователя
 */
export async function getUserChats(userId: string) {
  const chats = await prisma.chat.findMany({
    where: {
      chatUsers: {
        some: { userId },
      },
      // Exclude SYSTEM chats - they are fetched via /chats/system endpoint
      type: { not: 'SYSTEM' },
    },
    include: {
      chatUsers: {
        include: {
          user: {
            select: {
              id: true,
              username: true,
              displayName: true,
              avatar: true,
              status: true,
              lastSeen: true,
            },
          },
        },
      },
      messages: {
        take: 1,
        orderBy: { createdAt: 'desc' },
        where: { encrypted: false },
        include: {
          author: {
            select: { id: true, username: true },
          },
        },
      },
    },
    orderBy: [
      { type: 'asc' },  // FAVORITES first (alphabetically before GROUP, PRIVATE, SYSTEM)
      { updatedAt: 'desc' }
    ],
  });


  // Move FAVORITES chat to the top if exists (extra safety)
  const favoritesChat = chats.find(c => c.type === 'FAVORITES');
  const otherChats = chats.filter(c => c.type !== 'FAVORITES');
  const sortedChats = favoritesChat
    ? [favoritesChat, ...otherChats.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())]
    : chats;

  // Получаем устройства всех участников
  const userIds = sortedChats.flatMap((c) => c.chatUsers.map((cu) => cu.user.id));
  const devices = await prisma.device.findMany({
    where: { userId: { in: userIds }, isActive: true },
    select: { userId: true, deviceId: true, signalDeviceId: true },
  });

  const deviceMap = new Map<string, number | null>();
  devices.forEach((d) => deviceMap.set(d.userId, d.signalDeviceId));

  // Получаем непрочитанные сообщения
  const chatUserData = await prisma.chatUser.findMany({
    where: {
      userId,
      chatId: { in: sortedChats.map((c) => c.id) },
    },
    select: { chatId: true, unreadCount: true },
  });
  const unreadMap = new Map(chatUserData.map((cu) => [cu.chatId, cu.unreadCount]));

  return sortedChats.map((chat) => {
    const otherParticipant = !chat.isGroup && chat.chatUsers.length === 2
      ? chat.chatUsers.find((cu) => cu.userId !== userId)
      : null;

    const lastMessage = chat.messages[0];

    // Build participants array - for group chats include all members
    const participants = chat.isGroup
      ? chat.chatUsers.map((cu) => ({
          userId: cu.user.id,
          username: cu.user.username,
          displayName: cu.user.displayName,
          avatar: cu.user.avatar,
          status: cu.user.status.toLowerCase(),
          lastSeen: cu.user.lastSeen?.toISOString() || null,
          deviceId: deviceMap.get(cu.user.id)?.toString() || '',
          needsSession: false,
          role: cu.role,
          joinedAt: cu.joinedAt?.toISOString() || null,
        }))
      : otherParticipant
        ? [{
            userId: otherParticipant.user.id,
            username: otherParticipant.user.username,
            displayName: otherParticipant.user.displayName,
            avatar: otherParticipant.user.avatar,
            status: otherParticipant.user.status.toLowerCase(),
            lastSeen: otherParticipant.user.lastSeen?.toISOString() || null,
            deviceId: deviceMap.get(otherParticipant.user.id)?.toString() || '',
            needsSession: false,
          }]
        : [];

    // For favorites chat, always use the chat name
    const chatName = chat.type === 'FAVORITES'
      ? chat.name || 'Избранное'
      : chat.name || otherParticipant?.user.displayName || otherParticipant?.user.username || 'Unknown';

    return {
      id: chat.id,
      name: chatName,
      type: chat.type,
      avatar: chat.avatar || otherParticipant?.user.avatar,
      description: chat.description,
      isGroup: chat.isGroup,
      isSystem: chat.type === 'SYSTEM', // Добавляем флаг системного чата
      otherParticipant: otherParticipant
        ? {
            userId: otherParticipant.user.id,
            username: otherParticipant.user.username,
            displayName: otherParticipant.user.displayName,
            avatar: otherParticipant.user.avatar,
            status: otherParticipant.user.status.toLowerCase(),
            lastSeen: otherParticipant.user.lastSeen?.toISOString() || null,
            deviceId: deviceMap.get(otherParticipant.user.id)?.toString() || '',
            needsSession: false,
          }
        : null,
      participants,
      lastMessage: lastMessage
        ? {
            id: lastMessage.id,
            content: lastMessage.content,
            textPreview: lastMessage.content
              ? lastMessage.content.substring(0, 50) +
                (lastMessage.content.length > 50 ? '...' : '')
              : '',
            type: lastMessage.type,
            senderId: lastMessage.authorId, // Используем senderId для консистентности с Message
            senderUsername: lastMessage.author.username,
            createdAt: lastMessage.createdAt,
          }
        : null,
      updatedAt: chat.updatedAt,
      unreadCount: unreadMap.get(chat.id) || 0,
    };
  });
}

/**
 * Отметить сообщения как прочитанные
 */
export async function markAsRead({
  chatId,
  userId,
  messageIds,
}: MarkAsReadInput): Promise<MarkAsReadResult> {
  // Проверяем участие в чате
  const chatUser = await prisma.chatUser.findUnique({
    where: { chatId_userId: { chatId, userId } },
  });

  if (!chatUser) {
    throw new ChatError('Not a participant of this chat', 'NOT_PARTICIPANT', 403);
  }

  // Формируем условие поиска сообщений
  const whereClause: Prisma.MessageWhereInput = messageIds
    ? {
        id: { in: messageIds },
        chatId,
        authorId: { not: userId },
      }
    : {
        chatId,
        authorId: { not: userId },
        readStatuses: { none: { userId } },
      };

  const unreadMessages = await prisma.message.findMany({
    where: whereClause,
    select: { id: true, authorId: true },
  });

  if (unreadMessages.length === 0) {
    return {
      markedCount: 0,
      chatId,
      readAt: new Date().toISOString(),
      messageIds: [],
    };
  }

  const now = new Date();
  const markedMessageIds = unreadMessages.map((m) => m.id);

  // Создаём записи о прочтении
  await prisma.messageReadStatus.createMany({
    data: unreadMessages.map((m) => ({
      messageId: m.id,
      userId,
      readAt: now,
    })),
    skipDuplicates: true,
  });

  // Обновляем счётчик непрочитанных
  await prisma.chatUser.update({
    where: { chatId_userId: { chatId, userId } },
    data: {
      lastReadAt: now,
      unreadCount: 0,
    },
  });

  return {
    markedCount: markedMessageIds.length,
    chatId,
    readAt: now.toISOString(),
    messageIds: markedMessageIds,
  };
}

// ==================== Group Chat Operations ====================

/**
 * Создать групповой чат
 */
export async function createGroupChat({
  currentUserId,
  name,
  participantUsernames,
  requireApproval = false,
  historyAccess = 'ALL',
  avatar,
}: CreateGroupChatInput): Promise<ChatInfo> {
  // Проверяем лимит
  const withinLimit = await checkChatLimit(currentUserId);
  if (!withinLimit) {
    throw new ChatError(
      `Maximum chats limit reached (${CHAT_LIMITS.MAX_CHATS_PER_USER})`,
      'CHAT_LIMIT_REACHED',
      400
    );
  }

  // Находим пользователей
  const users = await prisma.user.findMany({
    where: { username: { in: participantUsernames } },
    select: { id: true, username: true },
  });

  const foundUsernames = users.map((u) => u.username);
  const notFound = participantUsernames.filter((u) => !foundUsernames.includes(u));
  if (notFound.length > 0) {
    throw new ChatError(`Users not found: ${notFound.join(', ')}`, 'USERS_NOT_FOUND', 404);
  }

  // Создаём группу
  const group = await prisma.chat.create({
    data: {
      name,
      type: 'GROUP',
      isGroup: true,
      avatar: avatar || null,
      requireApproval,
      historyAccess,
      createdById: currentUserId,
      chatUsers: {
        create: [
          { userId: currentUserId, role: 'OWNER' },
          ...users
            .filter((u) => u.id !== currentUserId)
            .map((u) => ({ userId: u.id, role: 'MEMBER' as const })),
        ],
      },
    },
    include: {
      chatUsers: {
        include: {
          user: {
            select: { id: true, username: true, displayName: true, avatar: true },
          },
        },
      },
    },
  });

  // F8: broadcast `system.chat_created` to all participants (including
  // the creator). Best-effort — failures are logged inside
  // `broadcastSystemEvent` and don't fail the createGroupChat call.
  // We pass `wsManager` directly (may be undefined during cold-start
  // testing — broadcastSystemEvent handles null gracefully by always
  // storing as pending command, which the clients will pick up on
  // next reconnect).
  try {
    const creator = await prisma.user.findUnique({
      where: { id: currentUserId },
      select: { username: true },
    });
    if (creator) {
      const participantIds = group.chatUsers.map(cu => cu.user.id);
      await broadcastSystemEvent(
        'system.chat_created',
        {
          chatId: group.id,
          chatType: 'GROUP',
          name: group.name ?? undefined,
          createdBy: {
            userId: currentUserId,
            username: creator.username,
          },
          createdAt: Date.now(),
        },
        participantIds,
        wsManager ?? null,
      );
    }
  } catch (err) {
    // Don't fail the createGroupChat call if the system-event
    // broadcast fails — the chat itself is already created and the
    // HTTP response should still return success.
    console.error('[createGroupChat] F8: failed to broadcast system.chat_created:', err);
  }

  return {
    id: group.id,
    name: group.name,
    type: 'GROUP',
    isGroup: true,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
    createdById: group.createdById,
    requireApproval: group.requireApproval,
    historyAccess: group.historyAccess as HistoryAccess,
    participants: group.chatUsers.map((cu) => ({
      userId: cu.user.id,
      username: cu.user.username,
        displayName: cu.user.displayName ?? null,
      avatar: cu.user.avatar ?? null,
      status: 'offline',
      deviceId: '',
      needsSession: false,
      role: cu.role as ChatRole,
      joinedAt: cu.joinedAt,
    })),
  };
}

/**
 * Получить информацию о группе
 */
export async function getGroupInfo(chatId: string, userId: string) {
  const chat = await prisma.chat.findUnique({
    where: { id: chatId },
    include: {
      chatUsers: {
        include: {
          user: {
            select: {
              id: true,
              username: true,
              displayName: true,
              avatar: true,
              status: true,
            },
          },
        },
      },
      createdBy: { select: { id: true, username: true } },
    },
  });

  if (!chat) {
    throw new ChatError('Chat not found', 'CHAT_NOT_FOUND', 404);
  }

  if (!chat.isGroup) {
    throw new ChatError('Chat is not a group', 'NOT_A_GROUP', 400);
  }

  const isParticipant = chat.chatUsers.some((cu) => cu.userId === userId);
  if (!isParticipant) {
    throw new ChatError('Access denied', 'ACCESS_DENIED', 403);
  }

  return {
    id: chat.id,
    name: chat.name,
    avatar: chat.avatar,
    description: chat.description,
    isGroup: chat.isGroup,
    requireApproval: chat.requireApproval,
    historyAccess: chat.historyAccess,
    createdAt: chat.createdAt,
    createdBy: { id: chat.createdBy.id, username: chat.createdBy.username },
    inviteCode: chat.inviteCode,
    inviteCodeExpiresAt: chat.inviteCodeExpiresAt,
    participants: chat.chatUsers.map((cu) => ({
      userId: cu.user.id,
      username: cu.user.username,
      displayName: cu.user.displayName,
      avatar: cu.user.avatar,
      status: cu.user.status,
      role: cu.role,
      joinedAt: cu.joinedAt,
    })),
  };
}

/**
 * Добавить участников в группу
 */
export async function addParticipants(
  chatId: string,
  currentUserId: string,
  usernames: string[]
): Promise<{
  added: string[];
  requiresApproval: boolean;
  message: string;
}> {
  const chat = await prisma.chat.findUnique({
    where: { id: chatId },
    include: { chatUsers: true },
  });

  if (!chat || !chat.isGroup) {
    throw new ChatError('Group not found', 'GROUP_NOT_FOUND', 404);
  }

  const currentUserRole = chat.chatUsers.find((cu) => cu.userId === currentUserId)?.role;
  if (!currentUserRole || !['OWNER', 'ADMIN'].includes(currentUserRole)) {
    throw new ChatError('Insufficient permissions', 'INSUFFICIENT_PERMISSIONS', 403);
  }

  const users = await prisma.user.findMany({
    where: { username: { in: usernames } },
    select: { id: true, username: true },
  });

  const existingUserIds = chat.chatUsers.map((cu) => cu.userId);
  const newUsers = users.filter((u) => !existingUserIds.includes(u.id));

  if (newUsers.length === 0) {
    throw new ChatError('All users are already in the group', 'ALREADY_MEMBERS', 400);
  }

  if (chat.requireApproval) {
    await prisma.chatJoinRequest.createMany({
      data: newUsers.map((u) => ({ chatId, userId: u.id, status: 'PENDING' })),
      skipDuplicates: true,
    });
  } else {
    await prisma.chatUser.createMany({
      data: newUsers.map((u) => ({ chatId, userId: u.id, role: 'MEMBER' })),
      skipDuplicates: true,
    });
  }

  return {
    added: newUsers.map((u) => u.username),
    requiresApproval: chat.requireApproval,
    message: chat.requireApproval ? 'Join requests created' : 'Users added to group',
  };
}

/**
 * Удалить участника из группы
 */
export async function removeParticipant(
  chatId: string,
  targetUserId: string,
  currentUserId: string
): Promise<void> {
  const chat = await prisma.chat.findUnique({
    where: { id: chatId },
    include: { chatUsers: true },
  });

  if (!chat || !chat.isGroup) {
    throw new ChatError('Group not found', 'GROUP_NOT_FOUND', 404);
  }

  const currentUserRole = chat.chatUsers.find((cu) => cu.userId === currentUserId)
    ?.role as ChatRole;
  const targetUserRole = chat.chatUsers.find((cu) => cu.userId === targetUserId)
    ?.role as ChatRole;

  if (!canRemoveParticipant(currentUserRole, targetUserRole)) {
    throw new ChatError('Insufficient permissions', 'INSUFFICIENT_PERMISSIONS', 403);
  }

  if (targetUserId === currentUserId) {
    throw new ChatError('Use /leave to leave the group', 'USE_LEAVE_ENDPOINT', 400);
  }

  await prisma.chatUser.deleteMany({
    where: { chatId, userId: targetUserId },
  });
}

/**
 * Обновить роль участника
 */
export async function updateParticipantRole(
  chatId: string,
  targetUserId: string,
  currentUserId: string,
  role: ChatRole
): Promise<void> {
  const chat = await prisma.chat.findUnique({
    where: { id: chatId },
    include: { chatUsers: true },
  });

  if (!chat || !chat.isGroup) {
    throw new ChatError('Group not found', 'GROUP_NOT_FOUND', 404);
  }

  const currentUserRole = chat.chatUsers.find((cu) => cu.userId === currentUserId)
    ?.role as ChatRole;
  const targetUserRole = chat.chatUsers.find((cu) => cu.userId === targetUserId)
    ?.role as ChatRole;

  if (!canChangeRoles(currentUserRole, targetUserRole)) {
    throw new ChatError('Only owner can change roles', 'INSUFFICIENT_PERMISSIONS', 403);
  }

  await prisma.chatUser.updateMany({
    where: { chatId, userId: targetUserId },
    data: { role },
  });
}

/**
 * Покинуть группу
 */
export async function leaveGroup(chatId: string, userId: string): Promise<void> {
  const chat = await prisma.chat.findUnique({
    where: { id: chatId },
    include: { chatUsers: true },
  });

  if (!chat || !chat.isGroup) {
    throw new ChatError('Group not found', 'GROUP_NOT_FOUND', 404);
  }

  // Запрет выхода из чата избранного
  if (chat.type === 'FAVORITES') {
    throw new ChatError(
      'Cannot leave favorites chat',
      'FAVORITES_PROTECTED',
      403
    );
  }

  const currentUserRole = chat.chatUsers.find((cu) => cu.userId === userId)?.role;

  if (currentUserRole === 'OWNER') {
    throw new ChatError(
      'Owner cannot leave. Transfer ownership or delete the group.',
      'OWNER_CANNOT_LEAVE',
      400
    );
  }

  await prisma.chatUser.deleteMany({
    where: { chatId, userId },
  });
}

/**
 * Удалить чат
 * Запрещено для чатов избранного и системных чатов
 */
export async function deleteChat(
  chatId: string,
  userId: string
): Promise<void> {
  const chat = await prisma.chat.findUnique({
    where: { id: chatId },
    include: { chatUsers: true },
  });

  if (!chat) {
    throw new ChatError('Chat not found', 'CHAT_NOT_FOUND', 404);
  }

  // Запрет удаления чата избранного
  if (chat.type === 'FAVORITES') {
    throw new ChatError(
      'Cannot delete favorites chat',
      'FAVORITES_PROTECTED',
      403
    );
  }

  // Запрет удаления системного чата
  if (chat.type === 'SYSTEM') {
    throw new ChatError(
      'Cannot delete system chat',
      'SYSTEM_PROTECTED',
      403
    );
  }

  // Проверяем права: только OWNER может удалить чат
  const currentUserRole = chat.chatUsers.find((cu) => cu.userId === userId)?.role as ChatRole;
  
  if (currentUserRole !== 'OWNER') {
    throw new ChatError(
      'Only owner can delete the chat',
      'INSUFFICIENT_PERMISSIONS',
      403
    );
  }

  // Удаляем чат (каскадное удаление через onDelete: Cascade)
  await prisma.chat.delete({
    where: { id: chatId },
  });
}

// ==================== Invite Link Operations ====================

/**
 * Создать ссылку-приглашение
 */
export async function createInviteLink(
  chatId: string,
  userId: string,
  expiresInHours: number = CHAT_LIMITS.DEFAULT_INVITE_EXPIRY_HOURS
): Promise<InviteLinkResult> {
  const chat = await prisma.chat.findUnique({
    where: { id: chatId },
    include: { chatUsers: true },
  });

  if (!chat || !chat.isGroup) {
    throw new ChatError('Group not found', 'GROUP_NOT_FOUND', 404);
  }

  const isParticipant = chat.chatUsers.some((cu) => cu.userId === userId);
  if (!isParticipant) {
    throw new ChatError('Access denied', 'ACCESS_DENIED', 403);
  }

  const inviteCode = crypto.randomBytes(16).toString('hex');
  const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);

  await prisma.chat.update({
    where: { id: chatId },
    data: { inviteCode, inviteCodeExpiresAt: expiresAt },
  });

  return {
    chatId,
    inviteCode,
    expiresAt: expiresAt.toISOString(),
    inviteUrl: `/invite/${inviteCode}`,
  };
}

/**
 * Присоединиться к группе по приглашению
 */
export async function joinByInvite(
  code: string,
  userId: string
): Promise<JoinResult> {
  const chat = await prisma.chat.findUnique({
    where: { inviteCode: code },
    include: { chatUsers: true },
  });

  if (!chat) {
    throw new ChatError('Invalid invite code', 'INVALID_INVITE', 404);
  }

  if (chat.inviteCodeExpiresAt && new Date() > chat.inviteCodeExpiresAt) {
    throw new ChatError('Invite link expired', 'INVITE_EXPIRED', 400);
  }

  const isAlreadyMember = chat.chatUsers.some((cu) => cu.userId === userId);
  if (isAlreadyMember) {
    return {
      chatId: chat.id,
      chatName: chat.name,
      isNewChat: false,
      message: 'You are already a member of this group',
    };
  }

  if (chat.requireApproval) {
    const existingRequest = await prisma.chatJoinRequest.findUnique({
      where: { chatId_userId: { chatId: chat.id, userId } },
    });

    if (existingRequest?.status === 'PENDING') {
      throw new ChatError('Join request already pending', 'ALREADY_PENDING', 400);
    }

    if (!existingRequest || existingRequest.status === 'REJECTED') {
      await prisma.chatJoinRequest.create({
        data: { chatId: chat.id, userId, status: 'PENDING' },
      });
    }

    return {
      chatId: chat.id,
      chatName: chat.name,
      isNewChat: false,
      requiresApproval: true,
      message: 'Join request submitted, waiting for approval',
    };
  }

  await prisma.chatUser.create({
    data: { chatId: chat.id, userId, role: 'MEMBER' },
  });

  return {
    chatId: chat.id,
    chatName: chat.name,
    isNewChat: true,
    message: 'You have joined the group',
  };
}

// ==================== Command Bus Operations ====================

/**
 * Удалить сообщение (для команды message.delete)
 */
export async function deleteMessageCommand(
  messageId: string,
  chatId: string,
  userId: string,
  deleteForEveryone: boolean
): Promise<{ deletedCount: number }> {
  if (deleteForEveryone) {
    const role = await getUserRole(chatId, userId);
    if (role !== 'OWNER' && role !== 'ADMIN') {
      throw new ChatError('Insufficient permissions', 'PERMISSION_DENIED', 403);
    }
    
    await prisma.message.delete({ where: { id: messageId } });
    return { deletedCount: 1 };
  }
  
  return { deletedCount: 0 };
}

/**
 * Редактировать сообщение (для команды message.edit)
 */
export async function editMessageCommand(
  messageId: string,
  _chatId: string,
  userId: string,
  content: string,
  editTimestamp: number
): Promise<{ edited: boolean }> {
  const message = await prisma.message.findUnique({
    where: { id: messageId },
    select: { authorId: true, createdAt: true },
  });
  
  if (!message) {
    throw new ChatError('Message not found', 'MESSAGE_NOT_FOUND', 404);
  }
  
  if (message.authorId !== userId) {
    throw new ChatError('Can only edit own messages', 'PERMISSION_DENIED', 403);
  }
  
  const messageAge = Date.now() - new Date(message.createdAt).getTime();
  if (messageAge > 24 * 60 * 60 * 1000) {
    throw new ChatError('Editing allowed only within 24 hours', 'EDIT_EXPIRED', 400);
  }
  
  await prisma.message.update({
    where: { id: messageId },
    data: {
      content,
      updatedAt: new Date(),
      metadata: { ...(message as any).metadata, editedAt: editTimestamp, edited: true },
    },
  });
  
  return { edited: true };
}

/**
 * Закрепить сообщение (для команды message.pin)
 */
export async function pinMessageCommand(
  messageId: string,
  chatId: string,
  userId: string,
  pinTimestamp: number
): Promise<{ pinned: boolean }> {
  await isChatParticipant(chatId, userId);
  
  const message = await prisma.message.findUnique({ where: { id: messageId } });
  if (!message) {
    throw new ChatError('Message not found', 'MESSAGE_NOT_FOUND', 404);
  }
  
  await prisma.message.update({
    where: { id: messageId },
    data: {
      metadata: { ...(message as any).metadata, isPinned: true, pinnedAt: pinTimestamp },
    },
  });
  
  return { pinned: true };
}

/**
 * Открепить сообщение (для команды message.unpin)
 */
export async function unpinMessageCommand(
  messageId: string,
  chatId: string,
  userId: string
): Promise<{ unpinned: boolean }> {
  await isChatParticipant(chatId, userId);
  
  const message = await prisma.message.findUnique({ where: { id: messageId } });
  if (!message) {
    throw new ChatError('Message not found', 'MESSAGE_NOT_FOUND', 404);
  }
  
  const metadata = { ...(message as any).metadata };
  delete metadata.isPinned;
  delete metadata.pinnedAt;
  
  await prisma.message.update({
    where: { id: messageId },
    data: { metadata },
  });
  
  return { unpinned: true };
}

/**
 * Удалить чат (для команды chat.delete)
 */
export async function deleteChatCommand(
  chatId: string,
  userId: string,
  deleteMessages: boolean
): Promise<{ deleted: boolean }> {
  const role = await getUserRole(chatId, userId);
  if (role !== 'OWNER' && role !== 'ADMIN') {
    throw new ChatError('Only owner or admin can delete chat', 'PERMISSION_DENIED', 403);
  }
  
  if (deleteMessages) {
    await prisma.message.deleteMany({ where: { chatId } });
  }
  
  await prisma.chatUser.delete({
    where: { chatId_userId: { chatId, userId } },
  });
  
  const remainingUsers = await prisma.chatUser.count({ where: { chatId } });
  if (remainingUsers === 0) {
    await prisma.chat.delete({ where: { id: chatId } });
  }
  
  return { deleted: true };
}

/**
 * Покинуть чат (для команды chat.leave)
 */
export async function leaveChatCommand(
  chatId: string,
  userId: string
): Promise<{ left: boolean }> {
  await prisma.chatUser.delete({
    where: { chatId_userId: { chatId, userId } },
  });
  
  const chat = await prisma.chat.findUnique({
    where: { id: chatId },
    select: { isGroup: true },
  });
  
  if (chat?.isGroup) {
    const remainingUsers = await prisma.chatUser.count({ where: { chatId } });
    if (remainingUsers === 0) {
      await prisma.chat.delete({ where: { id: chatId } });
    }
  }
  
  return { left: true };
}

/**
 * Обновить настройки чата (для команды chat.update)
 */
export async function updateChatCommand(
  chatId: string,
  userId: string,
  updates: { name?: string; avatar?: string; description?: string }
): Promise<{ updated: boolean }> {
  const role = await getUserRole(chatId, userId);
  if (role !== 'OWNER' && role !== 'ADMIN') {
    throw new ChatError('Only owner or admin can update chat', 'PERMISSION_DENIED', 403);
  }
  
  await prisma.chat.update({
    where: { id: chatId },
    data: updates,
  });
  
  return { updated: true };
}

/**
 * Добавить участника (для команды participant.add)
 */
export async function addParticipantCommand(
  chatId: string,
  userId: string,
  targetUserId: string,
  role?: string
): Promise<{ added: boolean }> {
  const roleValue = role as 'OWNER' | 'ADMIN' | 'MEMBER' | undefined;
  
  const currentRole = await getUserRole(chatId, userId);
  if (currentRole !== 'OWNER' && currentRole !== 'ADMIN') {
    throw new ChatError('Only owner or admin can add participants', 'PERMISSION_DENIED', 403);
  }
  
  const existing = await prisma.chatUser.findUnique({
    where: { chatId_userId: { chatId, userId: targetUserId } },
  });
  if (existing) {
    throw new ChatError('User is already a participant', 'ALREADY_MEMBER', 400);
  }
  
  await prisma.chatUser.create({
    data: {
      id: crypto.randomUUID(),
      chatId,
      userId: targetUserId,
      role: roleValue ?? 'MEMBER',
      joinedAt: new Date(),
    },
  });
  
  return { added: true };
}

/**
 * Удалить участника (для команды participant.remove)
 */
export async function removeParticipantCommand(
  chatId: string,
  userId: string,
  targetUserId: string
): Promise<{ removed: boolean }> {
  if (userId === targetUserId) {
    throw new ChatError('Use leaveChat to remove yourself', 'INVALID_OPERATION', 400);
  }
  
  const currentRole = await getUserRole(chatId, userId);
  if (currentRole !== 'OWNER' && currentRole !== 'ADMIN') {
    throw new ChatError('Only owner or admin can remove participants', 'PERMISSION_DENIED', 403);
  }
  
  const targetRole = await getUserRole(chatId, targetUserId);
  if (targetRole === 'OWNER') {
    throw new ChatError('Cannot remove owner', 'CANNOT_REMOVE_OWNER', 400);
  }
  
  await prisma.chatUser.delete({
    where: { chatId_userId: { chatId, userId: targetUserId } },
  });
  
  return { removed: true };
}

/**
 * Изменить роль участника (для команды participant.role_update)
 */
export async function updateParticipantRoleCommand(
  chatId: string,
  userId: string,
  targetUserId: string,
  newRole: string
): Promise<{ roleUpdated: boolean }> {
  const currentRole = await getUserRole(chatId, userId);
  if (currentRole !== 'OWNER') {
    throw new ChatError('Only owner can change roles', 'PERMISSION_DENIED', 403);
  }
  
  if (userId === targetUserId) {
    throw new ChatError('Cannot change own role', 'INVALID_OPERATION', 400);
  }
  
  await prisma.chatUser.update({
    where: { chatId_userId: { chatId, userId: targetUserId } },
    data: { role: newRole as 'OWNER' | 'ADMIN' | 'MODERATOR' | 'MEMBER' },
  });
  
  return { roleUpdated: true };
}

/**
 * Создать папку (для команды folder.create)
 */
export async function createFolderCommand(
  userId: string,
  name: string,
  color?: string,
  order: number = 0
): Promise<{ folderId: string }> {
  const folder = await prisma.userFolder.create({
    data: {
      id: crypto.randomUUID(),
      userId,
      name,
      color: color ?? null,
      order,
    },
  });
  return { folderId: folder.id };
}

/**
 * Обновить папку (для команды folder.update)
 */
export async function updateFolderCommand(
  folderId: string,
  userId: string,
  updates: { name?: string; color?: string; order?: number }
): Promise<{ updated: boolean }> {
  const folder = await prisma.userFolder.findUnique({ where: { id: folderId } });
  if (!folder || folder.userId !== userId) {
    throw new ChatError('Folder not found or access denied', 'ACCESS_DENIED', 403);
  }
  
  await prisma.userFolder.update({
    where: { id: folderId },
    data: updates,
  });
  
  return { updated: true };
}

/**
 * Удалить папку (для команды folder.delete)
 */
export async function deleteFolderCommand(
  folderId: string,
  userId: string,
  moveChatsTo?: string | null
): Promise<{ deleted: boolean }> {
  const folder = await prisma.userFolder.findUnique({ where: { id: folderId } });
  if (!folder || folder.userId !== userId) {
    throw new ChatError('Folder not found or access denied', 'ACCESS_DENIED', 403);
  }
  
  if (moveChatsTo) {
    await prisma.chatFolderItem.updateMany({
      where: { folderId },
      data: { folderId: moveChatsTo },
    });
  }
  
  await prisma.userFolder.delete({ where: { id: folderId } });
  return { deleted: true };
}

/**
 * Добавить чат в папку (для команды folder.add_chat)
 */
export async function addChatToFolderCommand(
  folderId: string,
  userId: string,
  chatId: string
): Promise<{ added: boolean }> {
  const folder = await prisma.userFolder.findUnique({ where: { id: folderId } });
  if (!folder || folder.userId !== userId) {
    throw new ChatError('Folder not found or access denied', 'ACCESS_DENIED', 403);
  }
  
  const isParticipant = await isChatParticipant(chatId, userId);
  if (!isParticipant) {
    throw new ChatError('Chat not found or you are not a participant', 'ACCESS_DENIED', 403);
  }
  
  await prisma.chatFolderItem.upsert({
    where: { folderId_chatId: { folderId, chatId } },
    update: {},
    create: { id: crypto.randomUUID(), folderId, chatId },
  });
  
  return { added: true };
}

/**
 * Удалить чат из папки (для команды folder.remove_chat)
 */
export async function removeChatFromFolderCommand(
  folderId: string,
  userId: string,
  chatId: string
): Promise<{ removed: boolean }> {
  const folder = await prisma.userFolder.findUnique({ where: { id: folderId } });
  if (!folder || folder.userId !== userId) {
    throw new ChatError('Folder not found or access denied', 'ACCESS_DENIED', 403);
  }
  
  await prisma.chatFolderItem.delete({
    where: { folderId_chatId: { folderId, chatId } },
  });
  
  return { removed: true };
}

/**
 * Изменить порядок папки (для команды folder.reorder)
 */
export async function reorderFolderCommand(
  folderId: string,
  userId: string,
  newOrder: number
): Promise<{ reordered: boolean }> {
  const folder = await prisma.userFolder.findUnique({ where: { id: folderId } });
  if (!folder || folder.userId !== userId) {
    throw new ChatError('Folder not found or access denied', 'ACCESS_DENIED', 403);
  }
  
  await prisma.userFolder.update({
    where: { id: folderId },
    data: { order: newOrder },
  });
  
  return { reordered: true };
}
