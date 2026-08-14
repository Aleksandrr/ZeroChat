/**
 * Users Routes
 * 
 * API для поиска пользователей и получения информации о пользователях.
 */

import { FastifyInstance } from 'fastify';
import { prisma } from '../prisma/client';
import { ZodError } from 'zod';
import { z } from 'zod';
import { authenticate } from '../middleware/auth';

// Rate limit для поиска пользователей
const searchRateLimit = {
  timeWindow: '1 minute',
  max: 30,
  keyGenerator: (request: any) => `${request.ip}:${request.url}`,
};

// Types
interface SearchQuery {
  query: string;
  limit?: number;
  cursor?: string;
}

interface UserSearchResult {
  id: string;
  username: string;
  displayName?: string;
  avatar?: string;
  status: 'online' | 'offline' | 'away';
  publicIdentityKey?: string;
  deviceId?: number;  // Signal Protocol device ID for key exchange
}

export const usersRoutes = async (fastify: FastifyInstance) => {

  // ==================== SEARCH USERS ====================
  fastify.get<{ Querystring: SearchQuery }>('/users/search', {
    schema: {
      querystring: {
        type: 'object',
        required: ['query'],
        properties: {
          query: {
            type: 'string',
            minLength: 2,
            description: 'Search query (username or email, minimum 2 characters)',
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 100,
            default: 20,
            description: 'Maximum number of results to return',
          },
          cursor: {
            type: 'string',
            description: 'Cursor for pagination',
          },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  username: { type: 'string' },
                  email: { type: 'string' },
                  avatar: { type: 'string', nullable: true },
                  status: { type: 'string', enum: ['online', 'offline', 'away'] },
                  publicIdentityKey: { type: 'string', nullable: true },
                },
              },
            },
            pagination: {
              type: 'object',
              properties: {
                nextCursor: { type: 'string', nullable: true },
                hasMore: { type: 'boolean' },
              },
            },
          },
        },
      },
    },
    preHandler: authenticate,
    config: {
      rateLimit: searchRateLimit,
    },
    handler: async (request, reply) => {
      try {
        const { query, limit = 20, cursor } = request.query;
        const currentUserId = (request as any).user.userId;

        // Validate minimum length
        if (query.length < 2) {
          return reply.code(400).send({
            success: false,
            message: 'Search query must be at least 2 characters',
          });
        }

         // Build Prisma query with OR condition for username or displayName search
         const whereClause: any = {
           OR: [
             {
               username: {
                 contains: query,
                 mode: 'insensitive',
               },
             },
             {
               displayName: {
                 contains: query,
                 mode: 'insensitive',
               },
             },
           ],
           NOT: {
             OR: [
               { id: currentUserId }, // Exclude current user
               { id: '00000000-0000-0000-0000-000000000001' } // Exclude system bot (ZeroChat)
             ]
           },
         };

        // Add cursor for pagination
        if (cursor) {
          whereClause.id = {
            gt: cursor, // Assuming cursor is user ID for forward pagination
          };
        }

        // Query users with device keys to get identity key and signalDeviceId
        const users = await prisma.user.findMany({
          where: whereClause,
          take: limit + 1, // Fetch one extra to check if there are more results
          orderBy: { username: 'asc' },
          select: {
            id: true,
            username: true,
            displayName: true,
            avatar: true,
            status: true,
            deviceKeys: {
              where: { deviceId: 'default' }, // Get primary device identity key
              select: {
                identityKeyPub: true,
              },
              take: 1,
            },
            devices: {
              where: { isActive: true },
              select: {
                signalDeviceId: true,
              },
              take: 1,
            },
          },
        });

        // Check if there are more results
        const hasMore = users.length > limit;
        const results = hasMore ? users.slice(0, limit) : users;

        // Get next cursor
        let nextCursor: string | undefined;
        if (hasMore && results.length > 0) {
          const lastResult = results[results.length - 1];
          nextCursor = lastResult ? lastResult.id : undefined;
        }

        // Format response
        const formattedResults: UserSearchResult[] = results.map((user) => ({
          id: user.id,
          username: user.username,
          displayName: user.displayName ?? '',
          avatar: user.avatar ?? '',
          status: user.status.toLowerCase() as 'online' | 'offline' | 'away',
          publicIdentityKey: user.deviceKeys[0]?.identityKeyPub || '',
          deviceId: user.devices[0]?.signalDeviceId || 0,
        }));

        return {
          success: true,
          data: formattedResults,
          pagination: {
            nextCursor: nextCursor || undefined,
            hasMore,
          },
        };
      } catch (error) {
        fastify.log.error({ error: 'User search failed', details: error });
        return reply.code(500).send({
          success: false,
          message: 'Failed to search users',
        });
      }
    },
  });

  // ==================== GET CURRENT USER DEVICES ====================
  fastify.get('/users/me/devices', {
    preHandler: authenticate,
    handler: async (request, reply) => {
      try {
        const currentUserId = (request as any).user.userId;
        const currentDeviceId = (request as any).user.deviceId;
        
        fastify.log.info({ userId: currentUserId, deviceId: currentDeviceId }, 'Fetching user devices');
        
        const devices = await prisma.device.findMany({
          where: { userId: currentUserId },
          select: {
            id: true,
            deviceId: true,
            name: true,
            type: true,
            lastSeen: true,
            isActive: true,
            createdAt: true,
          },
        });
        
        fastify.log.info({ userId: currentUserId, deviceCount: devices.length, devices }, 'User devices retrieved');

        // Mark current device
        const devicesWithCurrentFlag = devices.map(device => ({
          ...device,
          isCurrentDevice: device.deviceId === currentDeviceId,
        }));

        return {
          success: true,
          data: devicesWithCurrentFlag,
        };
      } catch (error) {
        fastify.log.error({ error: 'Failed to get user devices', details: error });
        return reply.code(500).send({
          success: false,
          message: 'Failed to get user devices',
        });
      }
    },
  });

  // ==================== UPDATE CURRENT USER PROFILE ====================
  fastify.patch<{ Body: { username?: string; displayName?: string } }>('/users/me', {
    schema: {
      body: {
        type: 'object',
        properties: {
          username: {
            type: 'string',
            minLength: 3,
            maxLength: 50,
            description: 'User username (login, optional)',
          },
          displayName: {
            type: 'string',
            minLength: 1,
            maxLength: 100,
            description: 'User display name (optional)',
          },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                username: { type: 'string' },
                displayName: { type: 'string', nullable: true },
                avatar: { type: 'string', nullable: true },
              },
            },
          },
        },
        400: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
          },
        },
        409: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
          },
        },
      },
    },
    preHandler: authenticate,
    handler: async (request, reply) => {
      try {
        const currentUserId = (request as any).user.userId;
        const { username, displayName } = request.body as { username?: string; displayName?: string };

        // Validate input using Zod
        const updateSchema = z.object({
          username: z.string().min(3).max(50).optional(),
          displayName: z.string().min(1).max(100).optional().or(z.string().length(0)),
        });

        try {
          updateSchema.parse({ username, displayName });
        } catch (error) {
          if (error instanceof ZodError) {
            return reply.code(400).send({
              success: false,
              message: 'Validation error: Username (3-50 chars) and display name (1-100 chars)',
            });
          }
        }

        // Prepare update data
        const updateData: any = {};
        if (username !== undefined && username.trim() !== '') {
          // Check if username is already taken by another user
          const existingUser = await prisma.user.findFirst({
            where: {
              username: username,
              NOT: { id: currentUserId },
            },
          });
          if (existingUser) {
            return reply.code(409).send({
              success: false,
              message: 'Username is already taken',
            });
          }
          updateData.username = username;
        }
        if (displayName !== undefined) {
          updateData.displayName = displayName || null;
        }

        // Ensure we have something to update
        if (Object.keys(updateData).length === 0) {
          return reply.code(400).send({
            success: false,
            message: 'No updates provided',
          });
        }

        // Update user
        const updatedUser = await prisma.user.update({
          where: { id: currentUserId },
          data: updateData,
          select: {
            id: true,
            username: true,
            displayName: true,
            avatar: true,
          },
        });

        return {
          success: true,
          message: 'Profile updated successfully',
          data: {
            id: updatedUser.id,
            username: updatedUser.username,
            displayName: updatedUser.displayName ?? undefined,
            avatar: updatedUser.avatar ?? undefined,
          },
        };
      } catch (error) {
        fastify.log.error({ error: 'Failed to update user profile', details: error });
        return reply.code(500).send({
          success: false,
          message: 'Failed to update user profile',
        });
      }
    },
  });

  // ==================== DELETE DEVICE ====================
  fastify.delete<{ Params: { deviceId: string } }>('/users/me/devices/:deviceId', {
    preHandler: authenticate,
    handler: async (request, reply) => {
      try {
        const { deviceId } = request.params;
        const currentUserId = (request as any).user.userId;
        const tokenDeviceId = (request as any).user.deviceId;

        // Find the device
        const device = await prisma.device.findFirst({
          where: {
            id: deviceId,
            userId: currentUserId,
          },
        });

        if (!device) {
          return reply.code(404).send({
            success: false,
            message: 'Device not found',
          });
        }

        // Check if trying to delete current device
        if (device.deviceId === tokenDeviceId) {
          return reply.code(400).send({
            success: false,
            message: 'Cannot delete current device. Use logout instead.',
          });
        }

        // Delete the device
        await prisma.device.delete({
          where: { id: deviceId },
        });

        // Also delete associated signal keys
        await prisma.deviceKeys.deleteMany({
          where: {
            deviceId: device.deviceId,
          },
        });

        return {
          success: true,
          message: 'Device deleted successfully',
        };
      } catch (error) {
        fastify.log.error({ error: 'Failed to delete device', details: error });
        return reply.code(500).send({
          success: false,
          message: 'Failed to delete device',
        });
      }
    },
  });

  // ==================== GET USER BY ID ====================
  fastify.get<{ Params: { userId: string } }>('/users/:userId', {
    preHandler: authenticate,
    handler: async (request, reply) => {
      try {
        const { userId } = request.params;

        const user = await prisma.user.findUnique({
          where: { id: userId },
          select: {
            id: true,
            username: true,
            displayName: true,
            avatar: true,
            status: true,
            createdAt: true,
            deviceKeys: {
              where: { deviceId: 'default' },
              select: {
                identityKeyPub: true,
                registrationId: true,
              },
              take: 1,
            },
          },
        });

        if (!user) {
          return reply.code(404).send({
            success: false,
            message: 'User not found',
          });
        }

        return {
          success: true,
          data: {
            id: user.id,
            username: user.username,
            displayName: user.displayName ?? undefined,
            avatar: user.avatar ?? undefined,
            status: user.status.toLowerCase() as 'online' | 'offline' | 'away',
            publicIdentityKey: user.deviceKeys[0]?.identityKeyPub ?? undefined,
            registrationId: user.deviceKeys[0]?.registrationId,
            createdAt: user.createdAt,
          },
        };
      } catch (error) {
        fastify.log.error({ error: 'Failed to get user', details: error });
        return reply.code(500).send({
          success: false,
          message: 'Failed to get user',
        });
      }
    },
  });
};
