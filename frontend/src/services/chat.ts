/**
 * ChatService
 * 
 * API сервис для чатов с методами:
 * - getChats() - получить все чаты пользователя
 * - getMessages() - получить сообщения чата (пагинация)
 * - createDirectChat() - создать 1:1 чат
 * - sendMessage() - отправить сообщение
 * - searchUsers() - поиск пользователей
 */

import { getAccessToken } from '@/services/auth';
import type { Chat, ChatCreateResponse, CreateGroupData, CreateGroupResponse, GroupInfo, InviteLinkResponse, JoinByInviteResponse, UserRole,UserSearchResult } from '@/types';

// ==================== Configuration ====================

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001/api';

// ==================== Custom Errors ====================

export class ChatError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode?: number
  ) {
    super(message);
    this.name = 'ChatError';
  }
}

// ==================== Backend Response Types ====================

interface BackendChatsResponse {
  success: boolean;
  data: {
    id: string;
    name?: string;
    type: string;
    avatar?: string;
    isGroup: boolean;
    otherParticipant?: {
      userId: string;
      username: string;
      displayName?: string;
      avatar?: string;
      status?: string;
      lastSeen?: string | null;
      deviceId?: string;
      needsSession?: boolean;
    } | null;
    participants?: {
      userId: string;
      username: string;
      displayName?: string;
      avatar?: string;
      status?: string;
      lastSeen?: string | null;
      deviceId?: string;
      needsSession?: boolean;
      role?: string;
      joinedAt?: string;
    }[];
    lastMessage?: {
      id: string;
      content: string;
      textPreview?: string;
      type?: string;
      authorId: string;
      authorUsername?: string;
      createdAt: string;
    } | null;
    updatedAt: string;
    unreadCount?: number;
  }[];
}

interface BackendChatCreateResponse {
  success: boolean;
  data: ChatCreateResponse;
}

interface BackendUserSearchResponse {
  success: boolean;
  data: UserSearchResult[];
  pagination?: {
    nextCursor?: string;
    hasMore: boolean;
  };
}

interface BackendSystemChatResponse {
  success: boolean;
  data: {
    id: string;
    name?: string;
    type: string;
    avatar?: string;
    isGroup: boolean;
    isSystem: boolean;
    createdAt: string;
    updatedAt: string;
    participants: {
      userId: string;
      username: string;
      displayName?: string;
      avatar?: string;
      status?: string;
      lastSeen?: string | null;
      deviceId?: string;
      role?: string;
      joinedAt?: string;
    }[];
    lastMessages?: {
      id: string;
      content: string;
      type?: string;
      authorId: string;
      authorUsername?: string;
      createdAt: string;
    }[];
  };
}

// ==================== Chat Service ====================

export class ChatService {
  private static instance: ChatService;

  // Device cache with TTL (5 minutes)
  private deviceCache = new Map<string, { data: { deviceId: number }[]; expiresAt: number }>();
  private static readonly DEVICE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  private constructor() {
    // Private constructor for singleton
  }

  /**
   * Singleton instance
   */
  static getInstance(): ChatService {
    if (!ChatService.instance) {
      ChatService.instance = new ChatService();
    }
    return ChatService.instance;
  }

  // ==================== Private Methods ====================

  /**
   * Generic request method with auth headers
   */
  private async request<T>(endpoint: string, options?: RequestInit): Promise<T> {
    const token = getAccessToken();

    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token && { 'Authorization': `Bearer ${token}` }),
        ...options?.headers,
      },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: 'Request failed' }));
      throw new ChatError(
        error.message || 'Request failed',
        error.code || 'UNKNOWN_ERROR',
        response.status
      );
    }

    return response.json();
  }

  // ==================== Public Methods ====================

  /**
   * Get all user chats
   */
  async getChats(): Promise<Chat[]> {
    try {
      // Запрашиваем обычные чаты (SYSTEM чаты исключены на бэкенде)
      const response = await this.request<BackendChatsResponse>('/chats');

      if (!response.success) {
        throw new ChatError('Failed to get chats', 'GET_CHATS_ERROR');
      }

      // Конвертируем обычные чаты
      const chats = response.data.map(chat => {
        // Use participants array if available (for group chats), otherwise construct from otherParticipant
        const participantsList = chat.participants && chat.participants.length > 0
          ? chat.participants.map(p => ({
              id: p.userId,
              username: p.username,
              displayName: p.displayName,
              avatar: p.avatar,
              status: p.status as 'online' | 'offline' | 'away',
              lastSeen: p.lastSeen || undefined,
              deviceId: p.deviceId ? parseInt(p.deviceId, 10) || undefined : undefined,
            }))
          : (chat.otherParticipant ? [{
              id: chat.otherParticipant.userId,
              username: chat.otherParticipant.username,
              displayName: chat.otherParticipant.displayName,
              avatar: chat.otherParticipant.avatar,
              status: chat.otherParticipant.status as 'online' | 'offline' | 'away',
              lastSeen: chat.otherParticipant.lastSeen || undefined,
              deviceId: chat.otherParticipant.deviceId ? parseInt(chat.otherParticipant.deviceId, 10) || undefined : undefined,
            }] : []);
          
         const mappedChat: Chat = {
          id: chat.id,
          name: chat.name,
          type: chat.type.toLowerCase() as 'private' | 'group' | 'favorites',
          avatar: chat.avatar,
          isSystem: false, // SYSTEM chats are excluded from this endpoint
          participants: participantsList,
          lastMessage: chat.lastMessage ? {
            id: chat.lastMessage.id,
            content: chat.lastMessage.content,
            senderId: chat.lastMessage.authorId,
            type: chat.lastMessage.type as 'TEXT' | 'SYSTEM',
            createdAt: chat.lastMessage.createdAt,
          } : undefined,
          unreadCount: chat.unreadCount,
          createdAt: chat.updatedAt,
          updatedAt: chat.updatedAt,
        };
        
        return mappedChat;
      });

      return chats;
    } catch (error) {
      if (error instanceof ChatError) {
        throw error;
      }
      throw new ChatError(
        error instanceof Error ? error.message : 'Unknown error',
        'NETWORK_ERROR'
      );
    }
  }

  /**
   * Create a direct (1:1) chat with another user
   */
  async createDirectChat(
    contactUsername: string,
    initialMessage?: string
  ): Promise<ChatCreateResponse> {
    try {
      const body: { contactUsername: string; initialMessage?: string } = {
        contactUsername,
      };

      if (initialMessage) {
        body.initialMessage = initialMessage;
      }

      const response = await this.request<BackendChatCreateResponse>('/chats', {
        method: 'POST',
        body: JSON.stringify(body),
      });

      if (!response.success) {
        throw new ChatError('Failed to create chat', 'CREATE_CHAT_ERROR');
      }

      return response.data;
    } catch (error) {
      if (error instanceof ChatError) {
        throw error;
      }
      throw new ChatError(
        error instanceof Error ? error.message : 'Unknown error',
        'NETWORK_ERROR'
      );
    }
  }

  /**
   * Search users by username or email
   */
  async searchUsers(query: string): Promise<UserSearchResult[]> {
    try {
      const params = new URLSearchParams({ query: query });

      const response = await this.request<BackendUserSearchResponse>(
        `/users/search?${params}`
      );

      if (!response.success) {
        throw new ChatError('Failed to search users', 'SEARCH_USERS_ERROR');
      }

      return response.data || [];
    } catch (error) {
      if (error instanceof ChatError) {
        throw error;
      }
      throw new ChatError(
        error instanceof Error ? error.message : 'Unknown error',
        'NETWORK_ERROR'
      );
    }
  }

  /**
   * Get a single chat by ID
   */
  async getChat(chatId: string): Promise<Chat> {
    try {
      interface BackendGetChatResponse {
        id: string;
        name?: string;
        type: string;
        avatar?: string;
        isGroup: boolean;
        isSystem?: boolean;
        createdAt: string;
        updatedAt: string;
        participants: {
          userId: string;
          username: string;
          displayName?: string;
          avatar?: string;
          status?: string;
          lastSeen?: string | null;
          deviceId?: string;
          role?: string;
          joinedAt?: string;
        }[];
        lastMessages?: unknown[];
      }

      const response = await this.request<{ success: boolean; data: BackendGetChatResponse }>(
        `/chats/${chatId}`
      );

      if (!response.success) {
        throw new ChatError('Failed to get chat', 'GET_CHAT_ERROR');
      }

      const chat = response.data;
      const isSystemChat = chat.type === 'SYSTEM' || chat.isSystem;

      // Map backend response to Chat type
      return {
        id: chat.id,
        name: chat.name || (isSystemChat ? 'ZeroChat' : undefined),
        type: isSystemChat ? 'system' : (chat.type.toLowerCase() as 'private' | 'group'),
        avatar: chat.avatar,
        isSystem: isSystemChat,
        isGroup: chat.isGroup,
        participants: isSystemChat ? [] : chat.participants.map(p => ({
          id: p.userId,
          username: p.username,
          displayName: p.displayName,
          avatar: p.avatar,
          status: p.status as 'online' | 'offline' | 'away',
          lastSeen: p.lastSeen || undefined,
          deviceId: p.deviceId ? parseInt(p.deviceId, 10) || undefined : undefined,
        })),
        createdAt: chat.createdAt,
        updatedAt: chat.updatedAt,
      };
    } catch (error) {
      if (error instanceof ChatError) {
        throw error;
      }
      throw new ChatError(
        error instanceof Error ? error.message : 'Unknown error',
        'NETWORK_ERROR'
      );
    }
  }

  /**
   * Mark messages as read
   */
  async markAsRead(chatId: string, messageIds: string[]): Promise<void> {
    try {
      await this.request(`/chats/${chatId}/read`, {
        method: 'POST',
        body: JSON.stringify({ messageIds }),
      });
    } catch (error) {
      console.error('Failed to mark messages as read:', error);
      // Don't throw - this is a non-critical operation
    }
  }

  /**
   * Leave a group chat
   */
  async leaveChat(chatId: string): Promise<void> {
    try {
      await this.request(`/chats/${chatId}/leave`, {
        method: 'POST',
      });
    } catch (error) {
      if (error instanceof ChatError) {
        throw error;
      }
      throw new ChatError(
        error instanceof Error ? error.message : 'Unknown error',
        'LEAVE_CHAT_ERROR'
      );
    }
  }

  /**
    * Get all devices for a recipient user
    * Used to implement Sesame protocol self-delivery to sender's other devices
    * Results are cached for 5 minutes to reduce API calls
    */
  async getRecipientDevices(userId: string): Promise<{ deviceId: number }[]> {
    // Check cache first
    const cached = this.deviceCache.get(userId);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.data;
    }

    try {
      const response = await this.request<{
        success: boolean;
        data: {
          devices: {
            deviceId: string;
            identityKeyPub: string;
            registrationId: number;
          }[];
        };
      }>(`/keys/devices/${userId}`);

      if (!response.success) {
        throw new ChatError('Failed to get recipient devices', 'GET_RECIPIENT_DEVICES_ERROR');
      }

      // Return device IDs as numbers (Signal Protocol uses numeric device IDs)
      // Bug 5 fix: Filter out NaN values which would cause message delivery failures
      const devices = response.data.devices
        .map(d => ({
          deviceId: parseInt(d.deviceId, 10),
        }))
        .filter(d => !isNaN(d.deviceId));

      // Cache the result
      this.deviceCache.set(userId, {
        data: devices,
        expiresAt: Date.now() + ChatService.DEVICE_CACHE_TTL,
      });

      return devices;
    } catch (error) {
      if (error instanceof ChatError) {
        throw error;
      }
      throw new ChatError(
        error instanceof Error ? error.message : 'Unknown error',
        'NETWORK_ERROR'
      );
    }
  }

  /**
   * Clear the device cache (e.g. on logout or when devices change)
   */
  clearDeviceCache(userId?: string): void {
    if (userId) {
      this.deviceCache.delete(userId);
    } else {
      this.deviceCache.clear();
    }
  }

  /**
   * Get PreKey bundle for a user/device
   * Used to establish X3DH session before sending first message
   */
  async getPreKeyBundle(userId: string, deviceId: string): Promise<{
    identityKeyPub: string;
    signedPreKey: { id: number; pub: string; sig: string };
    registrationId: number;
    pqLastResortPreKey?: { id: number; pub: string; sig: string };
    oneTimeEcPreKey?: { id: number; pub: string };
    oneTimePqPreKey?: { id: number; pub: string; sig: string };
  }> {
    try {
      const response = await this.request<{
        success: boolean;
        data: {
          identityKeyPub: string;
          signedPreKey: { id: number; pub: string; sig: string };
          registrationId: number;
          pqLastResortPreKey?: { id: number; pub: string; sig: string };
          oneTimeEcPreKey?: { id: number; pub: string };
          oneTimePqPreKey?: { id: number; pub: string; sig: string };
        };
      }>(`/keys/pqxdh/bundle/${userId}/${deviceId}`);

      if (!response.success) {
        throw new ChatError('Failed to get PreKey bundle', 'GET_PREKEY_BUNDLE_ERROR');
      }

      return response.data;
    } catch (error) {
      if (error instanceof ChatError) {
        throw error;
      }
      throw new ChatError(
        error instanceof Error ? error.message : 'Unknown error',
        'NETWORK_ERROR'
      );
    }
  }

  /**
   * Get the saved public identity key (base64) for a remote user.
   *
   * Used by the Safety Numbers UI to compute `generateSafetyNumber()` for a
   * contact without needing an active session or a fresh PreKey bundle.
   *
   * The `/keys/devices/:userId` endpoint already returns `identityKeyPub`
   * per device; we just take the first one (all devices for the same user
   * share the same identity key in Signal Protocol).
   *
   * Returns `null` if the user has no published devices yet (no key exchange
   * has occurred) or the network call fails.
   */
  async getRemoteIdentityKey(userId: string): Promise<string | null> {
    try {
      const response = await this.request<{
        success: boolean;
        data: {
          devices: {
            deviceId: string;
            identityKeyPub: string;
            registrationId: number;
          }[];
        };
      }>(`/keys/devices/${userId}`);

      if (!response.success) return null;
      const first = response.data?.devices?.[0];
      if (!first?.identityKeyPub) return null;
      return first.identityKeyPub;
    } catch {
      return null;
    }
  }
}

export const chatService = ChatService.getInstance();

// ==================== Group Chat Methods ====================

/**
 * Create a group chat
 */
export async function createGroup(data: CreateGroupData): Promise<CreateGroupResponse> {
  const token = getAccessToken();
  
  const response = await fetch(`${API_BASE_URL}/chats/group`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token && { 'Authorization': `Bearer ${token}` }),
    },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: 'Failed to create group' }));
    throw new ChatError(error.message || 'Failed to create group', 'CREATE_GROUP_ERROR', response.status);
  }

  return response.json();
}

/**
 * Get group info by chat ID
 */
export async function getGroupInfo(chatId: string): Promise<GroupInfo> {
  const token = getAccessToken();
  
  const response = await fetch(`${API_BASE_URL}/chats/${chatId}/group-info`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token && { 'Authorization': `Bearer ${token}` }),
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: 'Failed to get group info' }));
    throw new ChatError(error.message || 'Failed to get group info', 'GET_GROUP_INFO_ERROR', response.status);
  }

  const result = await response.json();
  return result.data;
}

/**
 * Add participants to a group
 */
export async function addParticipants(chatId: string, usernames: string[]): Promise<{ success: boolean; message: string; requiresApproval?: boolean }> {
  const token = getAccessToken();
  
  const response = await fetch(`${API_BASE_URL}/chats/${chatId}/participants`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token && { 'Authorization': `Bearer ${token}` }),
    },
    body: JSON.stringify({ usernames }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: 'Failed to add participants' }));
    throw new ChatError(error.message || 'Failed to add participants', 'ADD_PARTICIPANTS_ERROR', response.status);
  }

  return response.json();
}

/**
 * Remove participant from a group
 */
export async function removeParticipant(chatId: string, userId: string): Promise<{ success: boolean; message: string }> {
  const token = getAccessToken();
  
  const response = await fetch(`${API_BASE_URL}/chats/${chatId}/participants/${userId}`, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      ...(token && { 'Authorization': `Bearer ${token}` }),
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: 'Failed to remove participant' }));
    throw new ChatError(error.message || 'Failed to remove participant', 'REMOVE_PARTICIPANT_ERROR', response.status);
  }

  return response.json();
}

/**
 * Update participant role in a group
 */
export async function updateParticipantRole(chatId: string, userId: string, role: UserRole): Promise<{ success: boolean; message: string }> {
  const token = getAccessToken();
  
  const response = await fetch(`${API_BASE_URL}/chats/${chatId}/participants/${userId}/role`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...(token && { 'Authorization': `Bearer ${token}` }),
    },
    body: JSON.stringify({ role }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: 'Failed to update role' }));
    throw new ChatError(error.message || 'Failed to update role', 'UPDATE_ROLE_ERROR', response.status);
  }

  return response.json();
}

/**
 * Leave a group
 */
export async function leaveGroup(chatId: string): Promise<{ success: boolean; message: string }> {
  const token = getAccessToken();
  
  const response = await fetch(`${API_BASE_URL}/chats/${chatId}/leave`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token && { 'Authorization': `Bearer ${token}` }),
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: 'Failed to leave group' }));
    throw new ChatError(error.message || 'Failed to leave group', 'LEAVE_GROUP_ERROR', response.status);
  }

  return response.json();
}

/**
 * Create invite link for a group
 */
export async function createInviteLink(chatId: string, expiresInHours = 24): Promise<InviteLinkResponse> {
  const token = getAccessToken();
  
  const response = await fetch(`${API_BASE_URL}/chats/${chatId}/invite-link`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token && { 'Authorization': `Bearer ${token}` }),
    },
    body: JSON.stringify({ expiresInHours }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: 'Failed to create invite link' }));
    throw new ChatError(error.message || 'Failed to create invite link', 'CREATE_INVITE_LINK_ERROR', response.status);
  }

  return response.json();
}

/**
 * Join group by invite code
 */
export async function joinByInvite(code: string): Promise<JoinByInviteResponse> {
  const token = getAccessToken();
  
  const response = await fetch(`${API_BASE_URL}/chats/invite/${code}`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token && { 'Authorization': `Bearer ${token}` }),
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: 'Failed to join group' }));
    throw new ChatError(error.message || 'Failed to join group', 'JOIN_BY_INVITE_ERROR', response.status);
  }

  return response.json();
}
