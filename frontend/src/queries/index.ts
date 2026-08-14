/**
 * TanStack Query Module
 *
 * Exports for TanStack Query integration:
 * - QueryProvider: React provider for QueryClient
 * - queryKeys: Centralized query key factory
 * - Query hooks for chats, messages, users
 * - WebSocket invalidation hooks
 */

// Provider
export {
  QueryClient,
  QueryClientProvider,
  QueryProvider,
  useQueryClient,
} from './query-provider';

// Query Keys
export type {
  ChatsQueryKey,
  DevicesQueryKey,
  MessagesQueryKey,
  UsersQueryKey,
} from './keys';
export { queryKeys } from './keys';

// Chat Query Hooks
export {
  useChat,
  useChats,
  useCreateChat,
  useMarkAsRead,
  useMessages,
} from './chat-queries';

// User Query Hooks
export { useSearchUsers } from './user-queries';

// WebSocket Invalidation Hooks
export {
  useInvalidateAllChats,
  useInvalidateChatMessages,
  useWebSocketInvalidation,
} from './use-websocket-invalidation';
