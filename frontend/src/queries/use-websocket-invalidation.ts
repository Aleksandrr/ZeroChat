/**
 * WebSocket Query Invalidation Hook
 *
 * Automatically invalidates TanStack Query caches when WebSocket messages arrive.
 * This ensures UI stays in sync with real-time updates.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { useWebSocketContext } from '@/contexts/WebSocketContext';

import { queryKeys } from './keys';

/**
 * Hook that listens to WebSocket events and invalidates relevant queries.
 * Should be used at the app root level to ensure all tabs stay synchronized.
 */
export function useWebSocketInvalidation() {
  const queryClient = useQueryClient();
  const ws = useWebSocketContext();

  useEffect(() => {
    if (!ws.isConnected) return;

    // Handle new messages - no invalidation needed
    // Chat list is updated optimistically via setChats() in useChatMessages
    // This prevents unnecessary refetches of the entire chat list
    const unsubMessage = ws.onMessage((_data: unknown) => {
      // No invalidation - chat list updates are handled optimistically
    });

    // Handle read events - invalidate only the specific chat detail
    const unsubReadEvent = ws.onReadEvent((data) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.chats.detail(data.chatId),
      });
      // Don't invalidate entire chats list - sidebar updates optimistically
    });

    // Handle presence updates - don't invalidate queries
    // Presence changes are handled via Zustand store for better performance
    const unsubPresence = ws.onPresence((_data) => {
      // No query invalidation - presence is managed by UI store
    });

    return () => {
      unsubMessage();
      unsubReadEvent();
      unsubPresence();
    };
  }, [ws, ws.isConnected, queryClient]);
}

/**
 * Hook to manually invalidate all chat-related queries.
 * Useful for forced refresh after reconnection.
 */
export function useInvalidateAllChats() {
  const queryClient = useQueryClient();

  return () => {
    queryClient.invalidateQueries({
      queryKey: queryKeys.chats.all,
    });
    queryClient.invalidateQueries({
      queryKey: queryKeys.messages.all,
    });
  };
}

/**
 * Hook to invalidate messages for a specific chat.
 */
export function useInvalidateChatMessages(chatId: string | null) {
  const queryClient = useQueryClient();

  return () => {
    if (chatId) {
      queryClient.invalidateQueries({
        queryKey: queryKeys.messages.chat(chatId),
      });
    }
  };
}
