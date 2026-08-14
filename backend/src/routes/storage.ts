/**
 * Storage Routes - API для управления квотами хранилища
 * 
 * Endpoints:
 * - GET /api/storage/quota - Получить информацию о квоте пользователя
 */

import { FastifyInstance } from 'fastify';
import { authenticate } from '../middleware/auth';
import { getUserStorageQuota, formatBytes } from '../services/storage-quota';

// ==================== Types ====================

interface QuotaResponse {
  success: boolean;
  data: {
    usedBytes: number;
    maxBytes: number;
    availableBytes: number;
    percentUsed: number;
    usedFormatted: string;
    maxFormatted: string;
    availableFormatted: string;
  };
}

// ==================== Schema Definitions ====================

const quotaResponseSchema = {
  200: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      data: {
        type: 'object',
        properties: {
          usedBytes: { type: 'number', description: 'Использовано байт' },
          maxBytes: { type: 'number', description: 'Максимально доступно байт (1 GB)' },
          availableBytes: { type: 'number', description: 'Доступно байт' },
          percentUsed: { type: 'number', description: 'Процент использования' },
          usedFormatted: { type: 'string', description: 'Форматированный размер использованного' },
          maxFormatted: { type: 'string', description: 'Форматированный максимальный размер' },
          availableFormatted: { type: 'string', description: 'Форматированный доступный размер' },
        },
      },
    },
  },
  401: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      message: { type: 'string' },
    },
  },
  500: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      message: { type: 'string' },
    },
  },
};

// ==================== Routes ====================

export async function storageRoutes(fastify: FastifyInstance): Promise<void> {
  // All routes require authentication
  fastify.addHook('preHandler', authenticate);

  /**
   * GET /api/storage/quota
   * 
   * Получает информацию о квоте хранилища текущего пользователя.
   * Квота применяется к pending сообщениям (offline доставка) с файлами.
   * 
   * Response:
   * {
   *   "success": true,
   *   "data": {
   *     "usedBytes": 12345678,
   *     "maxBytes": 1073741824,
   *     "availableBytes": 1061397706,
   *     "percentUsed": 1.15,
   *     "usedFormatted": "11.77 MB",
   *     "maxFormatted": "1 GB",
   *     "availableFormatted": "1012.23 MB"
   *   }
   * }
   */
  fastify.get('/storage/quota', {
    schema: {
      description: 'Получить информацию о квоте хранилища пользователя',
      tags: ['storage'],
      response: quotaResponseSchema,
    },
    handler: async (request, reply): Promise<QuotaResponse> => {
      const userId = request.user?.userId;
      
      if (!userId) {
        return reply.code(401).send({
          success: false,
          message: 'Unauthorized',
        }) as unknown as QuotaResponse;
      }

      try {
        const quota = await getUserStorageQuota(userId);

        return {
          success: true,
          data: {
            usedBytes: quota.usedBytes,
            maxBytes: quota.maxBytes,
            availableBytes: quota.availableBytes,
            percentUsed: quota.percentUsed,
            usedFormatted: formatBytes(quota.usedBytes),
            maxFormatted: formatBytes(quota.maxBytes),
            availableFormatted: formatBytes(quota.availableBytes),
          },
        };
      } catch (error) {
        console.error('[Storage Quota] Error getting quota:', error);
        return reply.code(500).send({
          success: false,
          message: 'Failed to get storage quota',
        }) as unknown as QuotaResponse;
      }
    },
  });
}
