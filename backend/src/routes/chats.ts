/**
 * Chats Routes
 * 
 * API для управления чатами - приватными и групповыми.
 * Все endpoints требуют аутентификации.
 * 
 * NOTE: Messages are sent via WebSocket only (multi_message).
 * REST API for messages was removed - messages stored in IndexedDB on client.
 */

import { FastifyInstance } from 'fastify';
import { authenticate } from '../middleware/auth';
import {
  createPrivateChat,
  getChatById,
  getUserChats,
  markAsRead,
  createGroupChat,
  getGroupInfo,
  addParticipants,
  removeParticipant,
  updateParticipantRole,
  leaveGroup,
  createInviteLink,
  joinByInvite,
  getOrCreateFavoritesChat,
  deleteChat,
  ChatError,
  CHAT_CONSTANTS,
  CHAT_LIMITS,
  ChatRole,
  HistoryAccess,
} from '../services/chats';
import { getOrCreateSystemChat } from '../services/system-chat';
import { prisma } from '../prisma/client';

// ==================== Schema Definitions ====================

const createChatSchema = {
  body: {
    type: 'object',
    required: ['contactUsername'],
    properties: {
      contactUsername: {
        type: 'string',
        minLength: 2,
        description: 'Username контакта для создания 1:1 чата',
      },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        data: {
          type: 'object',
          properties: {
            chatId: { type: 'string' },
            chatType: { type: 'string', enum: ['PRIVATE'] },
            participants: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  userId: { type: 'string' },
                  username: { type: 'string' },
                  deviceId: { type: 'string' },
                  needsSession: { type: 'boolean' },
                },
              },
            },
            x3dhStatus: {
              type: 'string',
              enum: ['initiated', 'completed', 'pending'],
            },
            requiresPreKeyFetch: { type: 'boolean' },
          },
        },
      },
    },
  },
};

const createGroupSchema = {
  body: {
    type: 'object',
    required: ['name', 'participants'],
    properties: {
      name: { type: 'string', minLength: 1, maxLength: CHAT_LIMITS.MAX_GROUP_NAME_LENGTH },
      participants: { 
        type: 'array', 
        items: { type: 'string' }, 
        minItems: 1,
        maxItems: CHAT_LIMITS.MAX_PARTICIPANTS_IN_BATCH,
      },
      requireApproval: { type: 'boolean' },
      historyAccess: { type: 'string', enum: ['ALL', 'FROM_NOW', 'NONE'] },
      avatar: { type: 'string' },
    },
  },
};

const markAsReadSchema = {
  params: {
    type: 'object',
    required: ['chatId'],
    properties: {
      chatId: { type: 'string' },
    },
  },
  body: {
    type: 'object',
    properties: {
      messageIds: {
        type: 'array',
        items: { type: 'string' },
        maxItems: 100,
      },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        data: {
          type: 'object',
          properties: {
            markedCount: { type: 'number' },
            chatId: { type: 'string' },
            readAt: { type: 'string' },
            messageIds: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  },
};

const inviteLinkSchema = {
  body: {
    type: 'object',
    properties: {
      expiresInHours: { 
        type: 'number', 
        minimum: 1, 
        maximum: CHAT_LIMITS.MAX_INVITE_EXPIRY_HOURS,
      },
    },
  },
};

// ==================== Error Handler ====================

function handleChatError(error: unknown, reply: any, log: any): { success: false; message: string; code?: string } {
  if (error instanceof ChatError) {
    // Set the status code on reply and return the body — Fastify sends
    // the returned value. Do NOT call reply.send() here as well, or
    // Fastify throws "Reply was already sent" on every error path
    // (e.g. GET /chats/:chatId/group-info on a private chat).
    reply.code(error.statusCode);
    return {
      success: false as const,
      message: error.message,
      code: error.code,
    };
  }

  log.error({ error: 'Chat operation failed', details: error });
  reply.code(500);
  return {
    success: false as const,
    message: 'Internal server error',
  };
}

// ==================== Routes ====================

export const chatRoutes = async (fastify: FastifyInstance) => {
  // Rate limit для создания чатов
  const createChatRateLimit = {
    timeWindow: CHAT_CONSTANTS.RATE_LIMIT_WINDOW,
    max: CHAT_CONSTANTS.RATE_LIMIT_MAX,
    keyGenerator: (request: any) => `${request.ip}:${request.url}`,
  };

  // ==================== CREATE CHAT ====================
  fastify.post('/chats', {
    schema: createChatSchema,
    preHandler: authenticate,
    config: { rateLimit: createChatRateLimit },
    handler: async (request, reply) => {
      try {
        const { contactUsername } = request.body as {
          contactUsername: string;
        };
        const currentUserId = request.user!.userId;

        const { chat } = await createPrivateChat({
          currentUserId,
          contactUsername,
        });

        const contactParticipant = chat.participants.find(
          (p) => p.userId !== currentUserId
        );

        return {
          success: true,
          data: {
            chatId: chat.id,
            chatType: 'PRIVATE' as const,
            participants: chat.participants,
            x3dhStatus: contactParticipant?.needsSession ? 'pending' : 'initiated',
            requiresPreKeyFetch: contactParticipant?.needsSession ?? false,
          },
        };
      } catch (error) {
        return handleChatError(error, reply, fastify.log);
      }
    },
  });

  // ==================== GET CHAT BY ID ====================
  fastify.get('/chats/:chatId', {
    preHandler: authenticate,
    handler: async (request, reply) => {
      try {
        const { chatId } = request.params as { chatId: string };
        const currentUserId = request.user!.userId;

        const chat = await getChatById(chatId, currentUserId);

        return {
          success: true,
          data: {
            id: chat.id,
            name: chat.name,
            type: chat.type,
            avatar: chat.avatar,
            isGroup: chat.isGroup,
            createdAt: chat.createdAt,
            updatedAt: chat.updatedAt,
            participants: chat.chatUsers.map((cu) => ({
              userId: cu.user.id,
              username: cu.user.username,
              displayName: cu.user.displayName,
              avatar: cu.user.avatar,
              status: cu.user.status.toLowerCase(),
              lastSeen: cu.user.lastSeen,
              role: cu.role,
              joinedAt: cu.joinedAt,
            })),
            lastMessages: chat.messages,
          },
        };
      } catch (error) {
        return handleChatError(error, reply, fastify.log);
      }
    },
  });

  // ==================== GET USER CHATS ====================
  fastify.get('/chats', {
    preHandler: authenticate,
    handler: async (request, reply) => {
      try {
        const currentUserId = request.user!.userId;
        const chats = await getUserChats(currentUserId);

        return {
          success: true,
          data: chats,
        };
      } catch (error) {
        return handleChatError(error, reply, fastify.log);
      }
    },
  });

  // ==================== MARK AS READ ====================
  fastify.post('/chats/:chatId/read', {
    schema: markAsReadSchema,
    preHandler: authenticate,
    handler: async (request, reply) => {
      try {
        const { chatId } = request.params as { chatId: string };
        const { messageIds } = request.body as { messageIds?: string[] };
        const userId = request.user!.userId;

        const result = await markAsRead({ chatId, userId, messageIds });

        return {
          success: true,
          data: result,
        };
      } catch (error) {
        return handleChatError(error, reply, fastify.log);
      }
    },
  });

  // ==================== GET SYSTEM CHAT ====================
  fastify.get('/chats/system', {
    preHandler: authenticate,
    handler: async (request, reply) => {
      try {
        const currentUserId = request.user!.userId;

        const systemChat = await getOrCreateSystemChat(currentUserId);

        const chat = await prisma.chat.findUnique({
          where: { id: systemChat.id },
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
              where: { encrypted: false },
              include: {
                author: {
                  select: { id: true, username: true },
                },
              },
            },
          },
        });

        if (!chat) {
          return reply.code(404).send({
            success: false,
            message: 'System chat not found',
          });
        }

        return {
          success: true,
          data: {
            id: chat.id,
            name: chat.name,
            type: chat.type,
            avatar: chat.avatar,
            isGroup: chat.isGroup,
            isSystem: true,
            createdAt: chat.createdAt,
            updatedAt: chat.updatedAt,
            participants: chat.chatUsers.map((cu) => ({
              userId: cu.user.id,
              username: cu.user.username,
              displayName: cu.user.displayName,
              avatar: cu.user.avatar,
              status: cu.user.status,
              role: cu.role,
              joinedAt: cu.joinedAt,
            })),
            lastMessages: chat.messages.reverse(),
          },
        };
      } catch (error) {
        return handleChatError(error, reply, fastify.log);
      }
    },
  });

  // ==================== GET FAVORITES CHAT ====================
  fastify.get('/chats/favorites', {
    preHandler: authenticate,
    handler: async (request, reply) => {
      try {
        const currentUserId = request.user!.userId;

        const favoritesChat = await getOrCreateFavoritesChat(currentUserId);

        return {
          success: true,
          data: {
            id: favoritesChat.id,
            name: favoritesChat.name,
            type: favoritesChat.type,
            avatar: favoritesChat.avatar,
            isGroup: favoritesChat.isGroup,
            isFavorites: true,
            createdAt: favoritesChat.createdAt,
            updatedAt: favoritesChat.updatedAt,
            participants: favoritesChat.participants,
          },
        };
      } catch (error) {
        return handleChatError(error, reply, fastify.log);
      }
    },
  });

  // ==================== DELETE CHAT ====================
  fastify.delete('/chats/:chatId', {
    preHandler: authenticate,
    handler: async (request, reply) => {
      try {
        const { chatId } = request.params as { chatId: string };
        const currentUserId = request.user!.userId;

        await deleteChat(chatId, currentUserId);

        return { success: true, message: 'Chat deleted successfully' };
      } catch (error) {
        return handleChatError(error, reply, fastify.log);
      }
    },
  });

  // ==================== CREATE GROUP CHAT ====================
  fastify.post('/chats/group', {
    schema: createGroupSchema,
    preHandler: authenticate,
    handler: async (request, reply) => {
      try {
        const { name, participants, requireApproval, historyAccess, avatar } =
          request.body as {
            name: string;
            participants: string[];
            requireApproval?: boolean;
            historyAccess?: HistoryAccess;
            avatar?: string;
          };
        const currentUserId = request.user!.userId;

        const group = await createGroupChat({
          currentUserId,
          name,
          participantUsernames: participants,
          requireApproval,
          historyAccess,
          avatar,
        });

        return {
          success: true,
          data: {
            chatId: group.id,
            name: group.name,
            type: group.type,
            isGroup: group.isGroup,
            requireApproval: group.requireApproval,
            historyAccess: group.historyAccess,
            participants: group.participants.map((p) => ({
              userId: p.userId,
              username: p.username,
              displayName: p.displayName,
              role: p.role,
              joinedAt: p.joinedAt,
            })),
          },
        };
      } catch (error) {
        return handleChatError(error, reply, fastify.log);
      }
    },
  });

  // ==================== GET GROUP INFO ====================
  fastify.get('/chats/:chatId/group-info', {
    preHandler: authenticate,
    handler: async (request, reply) => {
      try {
        const { chatId } = request.params as { chatId: string };
        const currentUserId = request.user!.userId;

        const info = await getGroupInfo(chatId, currentUserId);

        return {
          success: true,
          data: info,
        };
      } catch (error) {
        return handleChatError(error, reply, fastify.log);
      }
    },
  });

  // ==================== ADD PARTICIPANTS ====================
  fastify.post('/chats/:chatId/participants', {
    schema: {
      body: {
        type: 'object',
        required: ['usernames'],
        properties: {
          usernames: { 
            type: 'array', 
            items: { type: 'string' }, 
            minItems: 1,
            maxItems: CHAT_LIMITS.MAX_PARTICIPANTS_IN_BATCH,
          },
        },
      },
    },
    preHandler: authenticate,
    handler: async (request, reply) => {
      try {
        const { chatId } = request.params as { chatId: string };
        const { usernames } = request.body as { usernames: string[] };
        const currentUserId = request.user!.userId;

        const result = await addParticipants(chatId, currentUserId, usernames);

        return {
          success: true,
          data: result,
        };
      } catch (error) {
        return handleChatError(error, reply, fastify.log);
      }
    },
  });

  // ==================== REMOVE PARTICIPANT ====================
  fastify.delete('/chats/:chatId/participants/:userId', {
    preHandler: authenticate,
    handler: async (request, reply) => {
      try {
        const { chatId, userId } = request.params as { chatId: string; userId: string };
        const currentUserId = request.user!.userId;

        await removeParticipant(chatId, userId, currentUserId);

        return { success: true, message: 'Participant removed' };
      } catch (error) {
        return handleChatError(error, reply, fastify.log);
      }
    },
  });

  // ==================== UPDATE PARTICIPANT ROLE ====================
  fastify.patch('/chats/:chatId/participants/:userId/role', {
    schema: {
      body: {
        type: 'object',
        required: ['role'],
        properties: {
          role: { type: 'string', enum: ['ADMIN', 'MODERATOR', 'MEMBER'] },
        },
      },
    },
    preHandler: authenticate,
    handler: async (request, reply) => {
      try {
        const { chatId, userId } = request.params as { chatId: string; userId: string };
        const { role } = request.body as { role: ChatRole };
        const currentUserId = request.user!.userId;

        await updateParticipantRole(chatId, userId, currentUserId, role);

        return { success: true, message: `Role updated to ${role}` };
      } catch (error) {
        return handleChatError(error, reply, fastify.log);
      }
    },
  });

  // ==================== LEAVE GROUP ====================
  fastify.post('/chats/:chatId/leave', {
    preHandler: authenticate,
    handler: async (request, reply) => {
      try {
        const { chatId } = request.params as { chatId: string };
        const currentUserId = request.user!.userId;

        await leaveGroup(chatId, currentUserId);

        return { success: true, message: 'You have left the group' };
      } catch (error) {
        return handleChatError(error, reply, fastify.log);
      }
    },
  });

  // ==================== CREATE INVITE LINK ====================
  fastify.post('/chats/:chatId/invite-link', {
    schema: inviteLinkSchema,
    preHandler: authenticate,
    handler: async (request, reply) => {
      try {
        const { chatId } = request.params as { chatId: string };
        const { expiresInHours } = request.body as { expiresInHours?: number };
        const currentUserId = request.user!.userId;

        const result = await createInviteLink(chatId, currentUserId, expiresInHours);

        return {
          success: true,
          data: result,
        };
      } catch (error) {
        return handleChatError(error, reply, fastify.log);
      }
    },
  });

  // ==================== JOIN BY INVITE LINK ====================
  fastify.get('/chats/invite/:code', {
    preHandler: authenticate,
    handler: async (request, reply) => {
      try {
        const { code } = request.params as { code: string };
        const currentUserId = request.user!.userId;

        const result = await joinByInvite(code, currentUserId);

        return {
          success: true,
          data: result,
        };
      } catch (error) {
        return handleChatError(error, reply, fastify.log);
      }
    },
  });
};
