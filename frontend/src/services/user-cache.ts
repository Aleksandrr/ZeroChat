/**
 * User Cache Service
 *
 * Manages the user cache (cached users from chat participation and messaging).
 * This cache is local-only and not synchronized across devices.
 */

import {
  cacheChatParticipants,
  cacheMessageSender,
  clearChatCache,
  clearStaleUserCache,
  getChatParticipants,
  getUserCache,
} from '@/lib/messages';
import type { User } from '@/types';

// ==================== Types ====================

export interface CachedUser extends User {
  chatId: string; // The chat where this user was encountered
  cachedAt: number;
  source: 'chat_participant' | 'message_sender';
  role?: string;
  joinedAt?: string;
  lastSeen?: string;
}

// ==================== API Functions ====================

/**
 * Get a cached user by ID, optionally filtered by chatId
 * Returns null if not found
 */
export async function getUser(userId: string, chatId?: string): Promise<CachedUser | null> {
  const record = await getUserCache(userId, chatId);
  if (!record) return null;

  return {
    id: record.userId,
    username: record.username,
    displayName: record.displayName,
    avatar: record.avatar,
    status: undefined, // Not cached
    lastSeen: record.lastSeen,
    chatId: record.chatId,
    cachedAt: record.cachedAt,
    source: record.source,
    role: record.role,
    joinedAt: record.joinedAt,
  };
}

/**
 * Cache all participants of a chat
 * This is called when loading a chat to cache its participants
 */
export async function cacheParticipants(chatId: string, participants: {
  id: string;
  username: string;
  displayName?: string;
  avatar?: string;
  role?: string;
  joinedAt?: string;
}[]): Promise<void> {
  await cacheChatParticipants(chatId, participants);
}

/**
 * Cache the sender of a message
 * Only caches if the message is not forwarded
 */
export async function cacheSender(
  senderId: string,
  senderUsername: string,
  chatId: string,
  sender?: User,
  metadata?: Record<string, unknown>
): Promise<void> {
  // Don't cache forwarded message senders
  if (metadata?.forwardedFrom) {
    return;
  }

  await cacheMessageSender(senderId, senderUsername, chatId, sender, metadata);
}

/**
 * Get all cached participants for a chat
 * Returns array of CachedUser sorted: contacts first, then by cachedAt (newest first)
 */
export async function getParticipants(chatId: string): Promise<CachedUser[]> {
  const records = await getChatParticipants(chatId);
  return records.map(record => ({
    id: record.userId,
    username: record.username,
    displayName: record.displayName,
    avatar: record.avatar,
    status: undefined,
    chatId: record.chatId,
    cachedAt: record.cachedAt,
    source: record.source,
    role: record.role,
    joinedAt: record.joinedAt,
    lastSeen: record.lastSeen,
  }));
}

/**
 * Clear the cache for a specific chat
 * Called when a chat is deleted or user leaves a group
 */
export async function clearChat(chatId: string): Promise<void> {
  await clearChatCache(chatId);
}

/**
 * Clear stale entries from the cache
 * Entries older than maxAgeDays (default 7) are removed
 * Should be called periodically (e.g., on app startup)
 */
export async function clearStaleEntries(maxAgeDays = 7): Promise<void> {
  await clearStaleUserCache(maxAgeDays);
}

// ==================== Export ====================

export const userCacheService = {
  getUser,
  cacheParticipants,
  cacheSender,
  getParticipants,
  clearChat,
  clearStaleEntries,
  // Expose raw DB functions for advanced use
  getUserCache,
  getChatParticipants,
  clearChatCache,
  clearStaleUserCache,
};

export default userCacheService;
