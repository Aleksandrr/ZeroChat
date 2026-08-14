/**
 * TanStack Query Keys
 * 
 * Centralized query keys following TanStack Query best practices.
 * Keys are hierarchical for efficient invalidation.
 * 
 * @see https://tanstack.com/query/latest/docs/react/guides/query-keys
 */

export const queryKeys = {
  // ==================== Chats ====================
  chats: {
    all: ['chats'] as const,
    lists: () => [...queryKeys.chats.all, 'list'] as const,
    list: (filters?: Record<string, unknown>) =>
      [...queryKeys.chats.lists(), filters] as const,
    details: () => [...queryKeys.chats.all, 'detail'] as const,
    detail: (id: string) => [...queryKeys.chats.details(), id] as const,
  },

  // ==================== Messages ====================
  messages: {
    all: ['messages'] as const,
    lists: () => [...queryKeys.messages.all, 'list'] as const,
    list: (chatId: string, offset?: number) =>
      [...queryKeys.messages.lists(), chatId, { offset }] as const,
    chat: (chatId: string) => [...queryKeys.messages.all, chatId] as const,
    detail: (chatId: string, messageId: string) =>
      [...queryKeys.messages.chat(chatId), 'detail', messageId] as const,
  },

  // ==================== Users ====================
  users: {
    all: ['users'] as const,
    search: (query: string) => [...queryKeys.users.all, 'search', query] as const,
    detail: (id: string) => [...queryKeys.users.all, 'detail', id] as const,
  },

  // ==================== Devices ====================
  devices: {
    all: ['devices'] as const,
    list: () => [...queryKeys.devices.all, 'list'] as const,
    detail: (id: string) => [...queryKeys.devices.all, 'detail', id] as const,
  },

  // ==================== Keys (Signal Protocol) ====================
  keys: {
    all: ['keys'] as const,
    bundle: (userId: string, deviceId: string) =>
      [...queryKeys.keys.all, 'bundle', userId, deviceId] as const,
  },
} as const;

// Type exports for query keys
export type ChatsQueryKey = ReturnType<typeof queryKeys.chats.lists>;
export type MessagesQueryKey = ReturnType<typeof queryKeys.messages.list>;
export type UsersQueryKey = ReturnType<typeof queryKeys.users.search>;
export type DevicesQueryKey = ReturnType<typeof queryKeys.devices.list>;
