/**
 * Chat Query Hooks - DEBUG VERSION
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { chatListCoordinator } from '@/lib/chat-coordinator';
import { getOlderMessagesWithCursor, getRecentMessages, getReactionsForMessage } from '@/lib/messages';
import { chatService } from '@/services/chat';
import type { Attachment, Chat, ChatCreateResponse, Message, Reaction } from '@/types';

import { queryKeys } from './keys';

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
export function useMessages(chatId: string | null, pageSize = 30) {
  const queryClient = useQueryClient();
  const [allMessages, setAllMessages] = useState<Message[]>([]);
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
      console.log('[useMessages] chatId changed from', prevChatIdRef.current, 'to', chatId);
      
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
        console.log('[useMessages] queryFn called with chatId:', chatId, 'isPaginating:', isPaginatingRef.current);
        
        if (!chatId) {
          console.log('[useMessages] No chatId, returning empty array');
          return [];
        }
        
        if (isPaginatingRef.current) {
          console.log('[useMessages] Paginating, returning allMessages:', allMessages.length);
          return allMessages;
        }
        
        console.log('[useMessages] Calling getRecentMessages for chatId:', chatId);
        const storedMessages = await getRecentMessages(chatId, pageSize);
        console.log('[useMessages] getRecentMessages returned', storedMessages.length, 'messages');
       
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
       
        console.log('[useMessages] Mapped', messagesWithReactions.length, 'messages with reactions');
        
        // Check if this query is still relevant (chatId hasn't changed)
        if (chatId !== currentChatIdRef.current) {
          console.log('[useMessages] queryFn: chatId changed from', chatId, 'to', currentChatIdRef.current, '- discarding results');
          return allMessages; // Return current messages to avoid resetting
        }
        
        // Update local state - REPLACE on initial load, not merge
        console.log('[useMessages] About to call setAllMessages with', messagesWithReactions.length, 'messages');
        setAllMessages(messagesWithReactions);
        console.log('[useMessages] setAllMessages called with', messagesWithReactions.length, 'messages, allMessages now:', messagesWithReactions.length);
        
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
        
        console.log('[useMessages] About to call setInitialLoadDone(true)');
        setInitialLoadDone(true);
        console.log('[useMessages] setInitialLoadDone(true) called');
        return messagesWithReactions;
      },
      enabled: !!chatId,
      staleTime: 0,
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
    const cursorMessageId = allMessages.length > 0 ? allMessages[0]?.id : undefined;
    
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
  }, [chatId, hasMore, pageSize, allMessages]);


  return {
    data: { pages: [{ messages: allMessages }] },
    allMessages,
    hasNextPage: hasMore,
    isFetchingNextPage: isLoadingMore,
    isLoading,
    isError,
    refetch,
    fetchNextPage: loadMore,
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
      const token = localStorage.getItem('accessToken');
      
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
