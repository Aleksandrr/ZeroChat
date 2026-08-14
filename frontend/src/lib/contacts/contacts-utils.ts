/**
 * Contacts Utilities
 *
 * Provides name resolution with priority system:
 * 1. Contacts (displayName/username) - for non-forwarded messages only
 * 2. User Cache (displayName/username) - for non-forwarded messages only
 * 3. Server fetch (displayName/username)
 * 4. Fallback to userId
 */

import { contactsService } from '@/services/contacts';
import { userCacheService } from '@/services/user-cache';

// ==================== Types ====================

export interface ResolveNameOptions {
  userId: string;
  chatId: string;
  isForwarded?: boolean;
}

// ==================== API Functions ====================

/**
 * Resolve the display name for a user with priority system
 *
 * Priority order:
 * 1. Contacts (displayName or username) - only if !isForwarded
 * 2. User Cache (displayName or username) - only if !isForwarded
 * 3. Server fetch (displayName or username)
 * 4. Fallback to userId
 */
export async function resolveDisplayName(
  userId: string,
  chatId: string,
  isForwarded = false
): Promise<string> {
  // Forwarded messages: skip contacts and cache, go directly to server
  if (isForwarded) {
    const serverName = await fetchUsernameFromServer(userId);
    return serverName || userId;
  }

  // 1. Check contacts (address book)
  const contact = await contactsService.getContact(userId);
  if (contact) {
    return contact.displayName || contact.username;
  }

  // 2. Check user cache
  const cached = await userCacheService.getUser(userId, chatId);
  if (cached) {
    return cached.displayName || cached.username || userId;
  }

  // 3. Fetch from server
  const serverName = await fetchUsernameFromServer(userId);
  if (serverName) {
    return serverName;
  }

  // 4. Fallback
  return userId;
}

/**
 * Fetch username/displayName from server
 * Used as fallback when user is not in contacts or cache
 */
export async function fetchUsernameFromServer(userId: string): Promise<string | null> {
  try {
    const profile = await contactsService.getUserProfile(userId);
    return profile.displayName || profile.username || null;
  } catch (error) {
    console.warn(`[resolveDisplayName] Failed to fetch user ${userId} from server:`, error);
    return null;
  }
}

/**
 * Batch resolve display names for multiple users
 * Optimizes by minimizing server requests
 *
 * @param requests - Array of { userId, chatId, isForwarded }
 * @returns Map of userId -> displayName
 */
export async function batchResolveDisplayNames(
  requests: ResolveNameOptions[]
): Promise<Map<string, string>> {
  const result = new Map<string, string>();

  // Group by: forwarded vs not forwarded, and whether we need server fetch
  const nonForwarded = requests.filter(r => !r.isForwarded);
  const forwarded = requests.filter(r => r.isForwarded);

  // Process non-forwarded: check contacts and cache first
  for (const req of nonForwarded) {
    const name = await resolveDisplayName(req.userId, req.chatId, false);
    result.set(req.userId, name);
  }

  // Process forwarded: only server fetch
  for (const req of forwarded) {
    const name = await resolveDisplayName(req.userId, req.chatId, true);
    result.set(req.userId, name);
  }

  return result;
}

// ==================== Helper Functions ====================

/**
 * Check if a message is forwarded
 */
export function isForwardedMessage(metadata?: Record<string, unknown>): boolean {
  return !!metadata?.forwardedFrom;
}

/**
 * Get sender display name for a message
 * Convenience wrapper around resolveDisplayName
 */
export async function getMessageSenderName(
  senderId: string,
  chatId: string,
  messageMetadata?: Record<string, unknown>
): Promise<string> {
  const isForwarded = isForwardedMessage(messageMetadata);
  const name = await resolveDisplayName(senderId, chatId, isForwarded);
  return name;
}

// ==================== Export ====================

export const contactsUtils = {
  resolveDisplayName,
  fetchUsernameFromServer,
  batchResolveDisplayNames,
  isForwardedMessage,
  getMessageSenderName,
};

export default contactsUtils;
