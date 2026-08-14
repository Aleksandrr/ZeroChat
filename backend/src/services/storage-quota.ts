export { formatBytes } from '../utils/shared';
import { formatBytes } from '../utils/shared';
/**
 * Storage Quota Service - Управление квотами хранилища для pending сообщений
 * 
 * Квота применяется только к:
 * - Зашифрованным сообщениям (encrypted = true)
 * - Pending сообщениям (metadata->>'pendingDeviceId' IS NOT NULL)
 * 
 * Лимит: 1 GB на пользователя для offline доставки сообщений с файлами
 */

import { prisma } from '../prisma/client';

// ==================== Constants ====================

export const STORAGE_QUOTA = {
  MAX_BYTES: 1073741824, // 1 GB in bytes
  MAX_GB: 1,
} as const;

// ==================== Types ====================

export interface QuotaInfo {
  usedBytes: number;
  maxBytes: number;
  availableBytes: number;
  percentUsed: number;
}

export interface QuotaCheckResult {
  allowed: boolean;
  currentUsage: number;
  newUsage: number;
  maxBytes: number;
  availableBytes: number;
  exceededBy: number | undefined;
}

// ==================== Main Functions ====================

/**
 * Получает информацию о квоте хранилища пользователя
 * 
 * Подсчитывает суммарный размер всех pending сообщений (encrypted + metadata.pendingDeviceId IS NOT NULL)
 * 
 * @param userId - ID пользователя
 * @returns QuotaInfo с использованием и лимитом
 */
export async function getUserStorageQuota(userId: string): Promise<QuotaInfo> {
  // Используем raw query для подсчета, так как JSON фильтры сложны в типизированном Prisma
  const result = await prisma.$queryRaw<{ used_bytes: bigint }[]>`
    SELECT COALESCE(SUM(
      COALESCE("payloadSize", LENGTH(content))
    ), 0) as used_bytes
    FROM messages
    WHERE "authorId" = ${userId}
      AND encrypted = true
      AND metadata->>'pendingDeviceId' IS NOT NULL
  `;

  const usedBytes = Number(result[0]?.used_bytes || 0);
  const availableBytes = Math.max(0, STORAGE_QUOTA.MAX_BYTES - usedBytes);
  const percentUsed = (usedBytes / STORAGE_QUOTA.MAX_BYTES) * 100;

  return {
    usedBytes,
    maxBytes: STORAGE_QUOTA.MAX_BYTES,
    availableBytes,
    percentUsed: Math.round(percentUsed * 100) / 100, // Округляем до 2 знаков
  };
}

/**
 * Проверяет квоту перед отправкой нового сообщения
 * 
 * @param userId - ID отправителя
 * @param newPayloadSize - Размер нового сообщения в байтах
 * @returns QuotaCheckResult с результатом проверки
 */
export async function checkQuotaBeforeSend(
  userId: string,
  newPayloadSize: number
): Promise<QuotaCheckResult> {
  const quota = await getUserStorageQuota(userId);
  const newUsage = quota.usedBytes + newPayloadSize;
  const allowed = newUsage <= STORAGE_QUOTA.MAX_BYTES;

  return {
    allowed,
    currentUsage: quota.usedBytes,
    newUsage,
    maxBytes: STORAGE_QUOTA.MAX_BYTES,
    availableBytes: quota.availableBytes,
    exceededBy: allowed ? undefined : newUsage - STORAGE_QUOTA.MAX_BYTES,
  };
}

/**
 * Проверяет квоту для множества сообщений (batch check)
 * Полезно при отправке сообщений с вложениями на несколько устройств
 * 
 * @param userId - ID отправителя
 * @param totalPayloadSize - Суммарный размер всех сообщений в байтах
 * @returns QuotaCheckResult с результатом проверки
 */
export async function checkQuotaForBatch(
  userId: string,
  totalPayloadSize: number
): Promise<QuotaCheckResult> {
  return checkQuotaBeforeSend(userId, totalPayloadSize);
}

/**
 * Форматирует размер в байтах в человекочитаемый формат
 */

/**
 * Проверяет, может ли пользователь отправить сообщения с указанными вложениями
 * 
 * @param userId - ID отправителя
 * @param attachmentSizes - Массив размеров вложений в байтах
 * @param messageCount - Количество сообщений (для multi-device)
 * @returns QuotaCheckResult с результатом проверки
 */
export async function canSendWithAttachments(
  userId: string,
  attachmentSizes: number[],
  messageCount: number = 1
): Promise<QuotaCheckResult> {
  const totalAttachmentSize = attachmentSizes.reduce((sum, size) => sum + size, 0);
  // Предполагаем, что каждая копия сообщения для разных устройств имеет примерно одинаковый размер
  const estimatedPayloadSize = totalAttachmentSize * messageCount;
  
  return checkQuotaBeforeSend(userId, estimatedPayloadSize);
}

// ==================== Error Classes ====================

export class StorageQuotaExceededError extends Error {
  public readonly code = 'STORAGE_QUOTA_EXCEEDED';
  public readonly quotaInfo: QuotaInfo;

  constructor(quotaInfo: QuotaInfo, message?: string) {
    super(
      message || 
      `Storage quota exceeded: ${formatBytes(quotaInfo.usedBytes)} used of ${formatBytes(quotaInfo.maxBytes)}`
    );
    this.name = 'StorageQuotaExceededError';
    this.quotaInfo = quotaInfo;
  }
}
