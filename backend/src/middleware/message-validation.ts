/**
 * Message validation middleware
 * Validates message sizes and detects size mismatches
 */

import { getRedisClient } from '../redis/client';

export interface SizeValidationResult {
  valid: boolean;
  error?: string;
  declaredSize?: number | undefined;
  actualSize?: number;
}

export interface FileRateLimitResult {
  allowed: boolean;
  reason?: 'RATE_LIMIT_MESSAGES' | 'RATE_LIMIT_BYTES';
  retryAfter?: number;
  currentMessages?: number;
  currentBytes?: number;
}

// Constants for validation
const MAX_MESSAGE_SIZE = 100 * 1024 * 1024; // 100 MB
const SIZE_MISMATCH_TOLERANCE = 0.1; // 10%

// Rate limit constants
const MESSAGES_PER_MINUTE = 10;
const BYTES_PER_HOUR = 500 * 1024 * 1024; // 500 MB
const MINUTE_WINDOW = 60; // seconds
const HOUR_WINDOW = 3600; // seconds

/**
 * Calculate actual size of base64 content in bytes
 */
function calculateBase64Size(base64Content: string): number {
  // Remove base64 padding to get accurate byte count
  const base64Length = base64Content.length;
  const padding = (base64Content.match(/=/g) || []).length;
  return Math.floor((base64Length * 3) / 4) - padding;
}

/**
 * Validate message size against maximum limit and declared size
 * 
 * @param content - Base64 encoded message content
 * @param metadata - Optional metadata with declared payload size
 * @returns SizeValidationResult with validation status
 */
export function validateMessageSize(
  content: string,
  metadata?: { payloadSize?: number }
): SizeValidationResult {
  // Calculate actual size from base64 content
  const actualSize = calculateBase64Size(content);

  // Check maximum size limit
  if (actualSize > MAX_MESSAGE_SIZE) {
    return {
      valid: false,
      error: 'PAYLOAD_TOO_LARGE',
      actualSize,
      declaredSize: metadata?.payloadSize
    };
  }

  const declaredSize = metadata?.payloadSize;

  // Check size mismatch if declared size is provided
  if (declaredSize !== undefined && declaredSize > 0) {
    const sizeDiff = Math.abs(declaredSize - actualSize);
    const tolerance = actualSize * SIZE_MISMATCH_TOLERANCE;

    if (sizeDiff > tolerance) {
      // Log warning but don't block - will use actual size
      console.warn('[MessageValidation] Payload size mismatch:', {
        declaredSize,
        actualSize,
        difference: sizeDiff,
        tolerance
      });

      return {
        valid: true, // Allow but with warning
        error: 'PAYLOAD_SIZE_MISMATCH',
        declaredSize,
        actualSize
      };
    }
  }

  return {
    valid: true,
    actualSize,
    declaredSize
  };
}

/**
 * Check if message size exceeds maximum limit
 * 
 * @param content - Base64 encoded message content
 * @returns boolean indicating if size is within limits
 */
export function checkMaxMessageSize(content: string): boolean {
  const actualSize = calculateBase64Size(content);
  return actualSize <= MAX_MESSAGE_SIZE;
}

/**
 * Get actual message size in bytes
 * 
 * @param content - Base64 encoded message content
 * @returns Size in bytes
 */
export function getMessageSize(content: string): number {
  return calculateBase64Size(content);
}

/**
 * Check rate limit for file messages using Redis
 * 
 * @param userId - User ID to check
 * @param payloadSize - Size of the current payload in bytes
 * @returns FileRateLimitResult with rate limit status
 */
export async function checkFileRateLimit(
  userId: string,
  payloadSize: number
): Promise<FileRateLimitResult> {
  const redis = getRedisClient();

  if (!redis) {
    // Redis not available - allow but log warning
    console.warn('[FileRateLimit] Redis not available, skipping rate limit check');
    return { allowed: true };
  }

  const minuteKey = `ratelimit:files:${userId}:minute`;
  const bytesKey = `ratelimit:files:${userId}:bytes:hour`;

  try {
    // Get current counters
    const [minuteCount, hourBytes] = await Promise.all([
      redis.get(minuteKey).then(v => parseInt(v || '0', 10)),
      redis.get(bytesKey).then(v => parseInt(v || '0', 10))
    ]);

    // Check per-minute message limit
    if (minuteCount >= MESSAGES_PER_MINUTE) {
      const ttl = await redis.ttl(minuteKey);
      return {
        allowed: false,
        reason: 'RATE_LIMIT_MESSAGES',
        retryAfter: ttl > 0 ? ttl : MINUTE_WINDOW,
        currentMessages: minuteCount,
        currentBytes: hourBytes
      };
    }

    // Check per-hour byte limit
    if (hourBytes + payloadSize > BYTES_PER_HOUR) {
      const ttl = await redis.ttl(bytesKey);
      return {
        allowed: false,
        reason: 'RATE_LIMIT_BYTES',
        retryAfter: ttl > 0 ? ttl : HOUR_WINDOW,
        currentMessages: minuteCount,
        currentBytes: hourBytes
      };
    }

    // Increment counters atomically
    const pipeline = redis.pipeline();

    // Increment minute counter
    pipeline.incr(minuteKey);
    pipeline.expire(minuteKey, MINUTE_WINDOW, 'NX'); // Only set expiry if not exists

    // Increment byte counter
    pipeline.incrby(bytesKey, payloadSize);
    pipeline.expire(bytesKey, HOUR_WINDOW, 'NX');

    await pipeline.exec();

    return {
      allowed: true,
      currentMessages: minuteCount + 1,
      currentBytes: hourBytes + payloadSize
    };

  } catch (error) {
    console.error('[FileRateLimit] Redis error:', error);
    // Fail open - allow the request if Redis is down
    return { allowed: true };
  }
}

/**
 * Check if message has attachments (for rate limiting purposes)
 * 
 * @param attachments - Optional array of attachments
 * @returns boolean indicating if message has attachments
 */
export function hasAttachments(
  attachments: unknown[] | undefined | null
): boolean {
  return Array.isArray(attachments) && attachments.length > 0;
}

/**
 * Format bytes to human readable string
 */

/**
 * Get rate limit configuration
 */
export const FILE_RATE_LIMITS = {
  maxPayloadSize: MAX_MESSAGE_SIZE, // 100 MB per message
  messagesPerMinute: MESSAGES_PER_MINUTE, // 10 file messages per minute
  bytesPerHour: BYTES_PER_HOUR, // 500 MB per hour
  sizeMismatchTolerance: SIZE_MISMATCH_TOLERANCE, // 10%
} as const;
