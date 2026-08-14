/**
 * Chat Query Hooks - DEBUG VERSION
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { chatListCoordinator } from '@/lib/chat-coordinator';
import { getMessagesAround, getOlderMessagesWithCursor, getRecentMessages, getReactionsForMessage } from '@/lib/messages';
import { chatService } from '@/services/chat';
import { getAccessToken } from '@/services/auth';
import type { Attachment, Chat, ChatCreateResponse, Message, Reaction } from '@/types';

import { queryKeys } from './keys';

/**
 * Convert a StoredMessage (IndexedDB record) into the public Message
 * type used throughout the UI. Loads reactions in parallel and merges
 * them onto the base message.
 *
 * Shared between the initial-load query, the paginating `loadMore`,
 * and the F5 `loadAround` path so all three return identical shapes.
 */
async function storedToMessage(m: Awaited<ReturnType<typeof getRecentMessages>>[number]): Promise<Message> {
  const status: Message['status'] = m.status === 'delivered' ? 'DELIVERED' : m.status === 'read' ? 'READ' : 'SENT';
  const baseMsg: Message = {
    id: m.id,
    chatId: m.chatId,
    senderId: m.senderId,
    senderUsername: m.senderUsername,
    content: m.content,
    type: (m.type as Message['type']) || 'TEXT',
    status,
    createdAt: new Date(m.timestamp).toISOString(),
    replyTo: m.replyTo,
    replyToOriginalSenderId: m.replyToOriginalSenderId,
    metadata: m.metadata,
    attachments: m.attachments?.map(att => ({
      id: att.id,
      type: att.type,
      fileName: att.fileName,
      size: att.size,
      mimeType: att.mimeType,
      data: att.data,
      contentHash: att.contentHash,
    })) as Attachment[],
    reactions: undefined,
  };
  // Load reactions for this message in parallel with the caller's other work.
  try {
    const reactionRecords = await getReactionsForMessage(m.id);
    if (reactionRecords.length > 0) {
      baseMsg.reactions = reactionRecords.map(r => ({
        emoji: r.emoji,
        userId: r.userId,
        count: 1,
      }));
    }
  } catch {
    // Reaction lookup is best-effort — never block the message itself.
  }
  return baseMsg;
}

export function useChats() {
  const queryClient = useQueryClient();

  const query = useQuery<Chat[], Error>({
    queryKey: queryKeys.chats.lists(),
    queryFn: async ({ signal }) => {
      if (signal?.aborted) {
        throw new Error('Query aborted');
      }
      return await chatListCoordinator.getChats();
    },
    staleTime: 60_000,
    refetchOnMount: false,
  });

  const { refetch: _originalRefetch, ...rest } = query;

  const refetch = useCallback(async () => {
    // Force a fresh fetch via coordinator and update cache
    const chats = await chatListCoordinator.forceRefresh();
    queryClient.setQueryData(queryKeys.chats.lists(), chats);
    return { data: chats };
  }, [queryClient]);

  return { ...rest, refetch };
}

export function useChat(chatId: string | null) {
  return useQuery<Chat, Error>({
    queryKey: queryKeys.chats.detail(chatId!),
    queryFn: () => chatService.getChat(chatId!),
    enabled: !!chatId && !chatId!.startsWith('virtual-'), // Don't fetch virtual chats from server
  });
}

/**
 * Messages from IndexedDB with manual pagination
 */
// U4: increased pageSize from 30 to 50 — 30 was too small, causing more
// frequent cursor fetches when scrolling. Both getRecentMessages and
// getOlderMessagesWithCursor in lib/messages/db.ts already return messages
// in ASC (chronological) order via index.openCursor('prev') + reverse().
export function useMessages(chatId: string | null, pageSize = 50) {
  const queryClient = useQueryClient();
  const [allMessages, setAllMessages] = useState<Message[]>([]);
  const allMessagesRef = useRef(allMessages);
  allMessagesRef.current = allMessages;
  const [hasMore, setHasMore] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [initialLoadDone, setInitialLoadDone] = useState(false);
  
  const cursorMessageIdRef = useRef<string | undefined>(undefined);
  const currentChatIdRef = useRef<string | null>(chatId);
  const prevChatIdRef = useRef<string | null>(null);
  const paginationCutoffTimeRef = useRef<number>(Date.now());
  const isPaginatingRef = useRef(false);

  useEffect(() => {
    currentChatIdRef.current = chatId;
  }, [chatId]);

  // Reset state when chatId changes
  useLayoutEffect(() => {
    if (chatId !== prevChatIdRef.current) {
      
      // Always reset local state when chat changes - the query will fetch new data
      setAllMessages([]);
      setHasMore(true);
      setIsLoadingMore(false);
      cursorMessageIdRef.current = undefined;
      setInitialLoadDone(false);
      isPaginatingRef.current = false;
      paginationCutoffTimeRef.current = Date.now();

      // Clear previous chat's query cache to free memory
      if (prevChatIdRef.current) {
        queryClient.removeQueries({ queryKey: queryKeys.messages.chat(prevChatIdRef.current) });
      }

      prevChatIdRef.current = chatId;
    }
  }, [chatId, queryClient, pageSize]);

   // Initial load query
    const { data: _data, isLoading, isError, refetch } = useQuery<Message[], Error>({
      queryKey: queryKeys.messages.chat(chatId!),
      queryFn: async () => {
        
        if (!chatId) {
          return [];
        }
        
        const storedMessages = await getRecentMessages(chatId, pageSize);
       
        // First, create messages without reactions
        const baseMessages: Message[] = storedMessages.map(m => {
          const status: Message['status'] = m.status === 'delivered' ? 'DELIVERED' : m.status === 'read' ? 'READ' : 'SENT';
          const msg: Message = {
            id: m.id,
            chatId: m.chatId,
            senderId: m.senderId,
            senderUsername: m.senderUsername,
            content: m.content,
            type: (m.type as Message['type']) || 'TEXT',
            status,
            createdAt: new Date(m.timestamp).toISOString(),
            replyTo: m.replyTo,
            replyToOriginalSenderId: m.replyToOriginalSenderId,
            metadata: m.metadata,
            attachments: m.attachments?.map(att => ({
              id: att.id,
              type: att.type,
              fileName: att.fileName,
              size: att.size,
              mimeType: att.mimeType,
              data: att.data,
              contentHash: att.contentHash,
            })) as Attachment[],
            reactions: undefined,
          };
          return msg;
        });

        // Then, load reactions for all messages in parallel
        const messagesWithReactions = await Promise.all(
          baseMessages.map(async (msg) => {
            const reactionRecords = await getReactionsForMessage(msg.id);
            const reactions: Reaction[] = reactionRecords.map(r => ({
              emoji: r.emoji,
              userId: r.userId,
              count: 1,
            }));
            return { ...msg, reactions };
          })
        );
       
        // Check if this query is still relevant (chatId hasn't changed)
        if (chatId !== currentChatIdRef.current) {
          return allMessages; // Return current messages to avoid resetting
        }
        
        // Update local state - REPLACE on initial load, not merge
        setAllMessages(messagesWithReactions);
        
        // Only set hasMore on INITIAL load
        if (!initialLoadDone) {
          const lastMessage = storedMessages[storedMessages.length - 1];
          if (storedMessages.length === pageSize && lastMessage) {
            cursorMessageIdRef.current = lastMessage.id;
            setHasMore(true);
          } else {
            setHasMore(false);
          }
        }
        
        setInitialLoadDone(true);
        return messagesWithReactions;
      },
      enabled: !!chatId,
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      gcTime: 1000 * 60 * 60,
    });

  // Load more function
  const loadMore = useCallback(async () => {
    if (isPaginatingRef.current) {
      return;
    }
    
    if (!chatId) {
      return;
    }
    
    if (!hasMore) {
      return;
    }

    // Get cursor from FIRST message (oldest after sort)
    const cursorMessageId = allMessagesRef.current.length > 0 ? allMessagesRef.current[0]?.id : undefined;
    
    if (!cursorMessageId) {
      return;
    }
    
    const capturedChatId = chatId;
    const capturedCursor = cursorMessageId;
    
    isPaginatingRef.current = true;
    setIsLoadingMore(true);
    
     try {
       // console.log('[useMessages] loadMore: Getting older messages with cursor:', capturedCursor);
       const storedMessages = await getOlderMessagesWithCursor(capturedChatId, capturedCursor, pageSize);
      
       if (currentChatIdRef.current !== capturedChatId) {
         return;
       }
       
       // console.log('[useMessages] loadMore: Got', storedMessages.length, 'older messages');
      
      const newMessages: Message[] = storedMessages.map(m => ({
        id: m.id,
        chatId: m.chatId,
        senderId: m.senderId,
        senderUsername: m.senderUsername, // Include sender username directly
        content: m.content,
        type: (m.type as Message['type']) || 'TEXT',
        status: m.status === 'delivered' ? 'DELIVERED' : m.status === 'read' ? 'READ' : 'SENT',
        createdAt: new Date(m.timestamp).toISOString(),
        metadata: m.metadata,
        attachments: m.attachments?.map(att => ({
          id: att.id,
          type: att.type,
          fileName: att.fileName,
          size: att.size,
          mimeType: att.mimeType,
          data: att.data,
          contentHash: att.contentHash,
        })) as Attachment[],
      }));
      
      setAllMessages(prev => {
        const existingIds = new Set(prev.map(m => m.id));
        const uniqueNewMessages = newMessages.filter(m => !existingIds.has(m.id));
        if (uniqueNewMessages.length > 0) {
          const oldestNewTime = new Date(uniqueNewMessages[0]!.createdAt).getTime();
          paginationCutoffTimeRef.current = Math.min(paginationCutoffTimeRef.current, oldestNewTime);
        }
        return [...uniqueNewMessages, ...prev];
      });
      
      if (currentChatIdRef.current === capturedChatId) {
        const firstMessage = storedMessages[0];
        if (storedMessages.length === pageSize && firstMessage) {
          cursorMessageIdRef.current = firstMessage.id;
          setHasMore(true);
        } else {
          setHasMore(false);
        }
      }
    } finally {
      isPaginatingRef.current = false;
      setIsLoadingMore(false);
    }
  }, [chatId, hasMore, pageSize]);

  /**
   * F5 (silent scroll-to-unloaded):
   *
   * Loads a window of ~30 messages on each side of `targetMessageId`
   * directly from IndexedDB and merges them into `allMessages` (dedup
   * by id). Returns the index of the target message in the NEW sorted
   * (chronological) array, or `null` if the message wasn't found in
   * the chat.
   *
   * The caller (ChatMessages.scrollToMessage) is responsible for
   * waiting for the virtualizer to re-render and then calling
   * `virtualizer.scrollToIndex(idx, { align: 'center' })` to actually
   * scroll. NO toast / NO spinner — this is a silent operation per
   * the user's "как в ТГ" requirement.
   */
  const loadAround = useCallback(async (targetMessageId: string): Promise<number | null> => {
    if (!chatId) return null;

    const capturedChatId = chatId;
    try {
      const storedWindow = await getMessagesAround(capturedChatId, targetMessageId, 30);

      // Chat switched while we were loading — drop the result.
      if (currentChatIdRef.current !== capturedChatId) return null;

      if (storedWindow.length === 0) return null;

      // Convert + load reactions for every loaded message in parallel.
      const windowMessages = await Promise.all(storedWindow.map(storedToMessage));

      if (currentChatIdRef.current !== capturedChatId) return null;

      // Merge with existing allMessages (dedup by id), then sort by
      // createdAt so the virtualizer renders them in chronological
      // order. We always derive the index from the merged+sorted
      // array (not from the loaded window) — that way the returned
      // index is exactly what the virtualizer will see after re-render.
      const existingIds = new Set(allMessagesRef.current.map(m => m.id));
      const uniqueNewMessages = windowMessages.filter(m => !existingIds.has(m.id));

      // Build the merged array we expect to be rendered.
      const merged = [...allMessagesRef.current, ...uniqueNewMessages].sort((a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      );

      // If the target message isn't in the merged set, there's no
      // point committing the state update — return null so the caller
      // can no-op silently.
      const targetIndex = merged.findIndex(m => m.id === targetMessageId);
      if (targetIndex < 0) return null;

      // Commit the merge.
      setAllMessages(merged);

      // If we loaded messages older than the current cursor, the
      // "has more older pages" assumption may need to be re-checked.
      // We err on the side of "there might be more" (hasMore stays
      // true) — loadMore will set it to false if a subsequent fetch
      // returns fewer than pageSize. This is consistent with how the
      // pagination cursor behaves when scrolling up normally.
      return targetIndex;
    } catch (err) {
      console.error('[useMessages] loadAround failed:', err);
      return null;
    }
  }, [chatId]);

  return {
    data: { pages: [{ messages: allMessages }] },
    allMessages,
    hasNextPage: hasMore,
    isFetchingNextPage: isLoadingMore,
    isLoading,
    isError,
    refetch,
    fetchNextPage: loadMore,
    loadAround,
    paginationCutoffTime: paginationCutoffTimeRef.current,
    initialLoadDone,
  };
}

export function useCreateChat() {
  const queryClient = useQueryClient();

  return useMutation<ChatCreateResponse, Error, { participantId: string }>({
    mutationFn: ({ participantId }) => chatService.createDirectChat(participantId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.chats.lists() });
    },
  });
}

export function useMarkAsRead() {
  const queryClient = useQueryClient();

  return useMutation<void, Error, { chatId: string; messageIds?: string[] }>({
    mutationFn: async ({ chatId, messageIds }) => {
      const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001/api';
      const token = getAccessToken();
      
      const url = messageIds 
        ? `${API_BASE_URL}/chats/${chatId}/read`
        : `${API_BASE_URL}/chats/${chatId}/read`;
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: messageIds ? JSON.stringify({ messageIds }) : undefined,
      });

      if (!response.ok) {
        throw new Error('Failed to mark messages as read');
      }
    },
    onSuccess: (_, { chatId }) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.chats.detail(chatId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.chats.lists() });
    },
  });
}
