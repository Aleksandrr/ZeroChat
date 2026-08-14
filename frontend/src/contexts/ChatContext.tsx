/**
 * ChatContext - Chat and messages management (Refactored)
 * Handles chats list, messages, and chat operations
 * 
 * REFACTORING (2026-02-27):
 * - Extracted types to @/types/chat
 * - Extracted useChatMessages hook for message operations
 * - Extracted useChatWebSocket hook for WebSocket handlers
 * - Extracted useGroupChat hook for group chat functionality
 * - Extracted useTypingIndicators hook for typing indicators
 * - Reduced from ~1234 lines to ~200 lines
 */

import { useQueryClient } from '@tanstack/react-query';
import type React from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import {
  useChatMessages,
  useChatWebSocket,
  useFavorites,
  useGroupChat,
  useTypingIndicators,
} from '@/hooks/chat';
import { resetUnreadCount } from '@/lib/messages';
import { queryKeys } from '@/queries';
import { useUnreadStore } from '@/stores';
import type { Chat } from '@/types';
import type { ChatContextType, GroupSyncPayload, TypingIndicatorPayload } from '@/types/chat';

import { useAuth } from './AuthContext';
import { useSignal } from './SignalContext';
import { useWebSocketContext } from './WebSocketContext';

// ==================== Context ====================

const ChatContext = createContext<ChatContextType | null>(null);

// ==================== Provider ====================

interface ChatProviderProps {
  children: React.ReactNode;
  onNewMessage?: Parameters<typeof useChatWebSocket>[0]['onNewMessage'];
}

export function ChatProvider({ children, onNewMessage }: ChatProviderProps) {
  const { user } = useAuth();
  const ws = useWebSocketContext();
  const signal = useSignal();
  const queryClient = useQueryClient();

  // Use ref for activeChat to avoid resubscribe on chat switch
  const activeChatRef = useRef<Chat | null>(null);

    // Chat messages and operations hook
    const {
      chats,
      setChats,
      activeChat,
      setActiveChat,
      chatsLoading,
      loadChats,
      createChat,
      sendMessage,
      updateChat,
      muteChat,
      unmuteChat,
      archiveChat,
      unarchiveChat,
      leaveChat,
      deleteChat,
      deleteMessage,
      editMessage,
      pinMessage,
      unpinMessage,
      reactToMessage,
      clearChat,
      exportChat,
      reportMessage,
      // Folder commands
      createFolder,
      updateFolder,
      deleteFolder,
      addChatToFolder,
      removeChatFromFolder,
      reorderFolder,
      // Virtual chat support
      openVirtualChat,
    } = useChatMessages();

  // Favorites hook for saved messages
  const { sendFavoritesMessage } = useFavorites({ user, signal, ws, setChats });

  // Keep activeChatRef in sync
  useEffect(() => {
    activeChatRef.current = activeChat;
  }, [activeChat]);

   // NOTE: Removed auto-refresh on WebSocket connect (2026-02-28)
   // Messages arrive via WebSocket and are written to IndexedDB directly.
   // No need to trigger additional loadChats() after connection.
   // Multi-device sync is handled via zerochat:sync-complete event.
   /*
  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout>;
    
    // Only trigger on transition from disconnected to connected
    if (ws.isConnected && user && !prevWsConnectedRef.current) {
      prevWsConnectedRef.current = true;
      // Wait longer to allow messages to be processed first
      timeoutId = setTimeout(() => {
        loadChats(true);
      }, 1500); // Wait 1.5s for messages to be processed
    } else if (!ws.isConnected) {
      prevWsConnectedRef.current = false;
    }
    
    return () => {
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [ws.isConnected, user]);
  */

  // Initialize unreadCounts from loaded chats (only on first load)
  // This syncs Zustand store with the initial chat data
  // We only set counts that don't already exist in the store to avoid overwriting
  // real-time updates from WebSocket
  const hasInitializedRef = useRef(false);
  useEffect(() => {
    if (chats && chats.length > 0 && !hasInitializedRef.current) {
      const store = useUnreadStore.getState();
      const unreadCounts: Record<string, number> = {};
      let hasNewCounts = false;
      
      for (const chat of chats) {
        // Only set if chat has unread messages AND store doesn't have this chat yet
        if (chat.unreadCount && chat.unreadCount > 0 && store.getUnreadCount(chat.id) === 0) {
          unreadCounts[chat.id] = chat.unreadCount;
          hasNewCounts = true;
        }
      }
      
      if (hasNewCounts) {
        store.setAllUnreadCounts({ ...store.unreadCounts, ...unreadCounts });
      }
      
      hasInitializedRef.current = true;
    }
  }, [chats]);

   // Clear unreadCounts when user logs out
   useEffect(() => {
     if (!user) {
       useUnreadStore.getState().clear();
     }
   }, [user]);

     // Group chat functionality hook (must be before useChatWebSocket to provide handleGroupMessage)
     const {
       handleGroupSync,
       handleGroupKeyUpdate,
       handleGroupMessage,
       addParticipant,
       removeParticipant,
       updateParticipantRole,
     } = useGroupChat({
       signal,
       setChats,
       activeChatRef,
       currentUserId: user?.id || '',
       ws,
       chats, // Pass chats for sender username resolution
     });

    // WebSocket event handlers hook
    useChatWebSocket({
      user,
      signal,
      ws,
      setChats,
      activeChatRef,
      onNewMessage,
      handleGroupMessage, // Pass group message handler
      chats, // Pass chats for sender resolution
    });

  // Typing indicators hook
  const { typingUsers, getTypingUsers, handleTypingIndicator } = useTypingIndicators();

  // Handle sync complete - refresh chats and messages
  useEffect(() => {
    const handleSyncComplete = async () => {
      // Get current active chat ID
      const currentChatId = activeChat?.id;
      
      // Remove and re-fetch messages for the active chat to force fresh data from IndexedDB
      if (currentChatId) {
        // Remove the query from cache to force a fresh fetch
        queryClient.removeQueries({ queryKey: queryKeys.messages.chat(currentChatId) });
      }
      
      // Also invalidate all other message queries
      await queryClient.invalidateQueries({
        queryKey: queryKeys.messages.all,
        exact: false
      });
      
      // Invalidate chats queries to refresh sidebar
      await queryClient.invalidateQueries({
        queryKey: queryKeys.chats.lists()
      });
      
       // Also invalidate chats to refresh the list - force refresh to bypass loaded guard
       await loadChats(true);
    };

    window.addEventListener('zerochat:sync-complete', handleSyncComplete);
    return () => window.removeEventListener('zerochat:sync-complete', handleSyncComplete);
  }, [loadChats, queryClient, activeChat]);

   // Subscribe to group sync
   useEffect(() => {
     if (!ws.isConnected) return;

      const unsub = ws.subscribe('group_sync', (data: unknown) => {
        // Handle both direct mode (full WSMessage) and worker mode (payload only)
        const anyData = data as any;
        const payload = anyData.payload ? anyData.payload : data;
        void handleGroupSync(payload as GroupSyncPayload);
      });

     return () => unsub();
   }, [ws.isConnected, ws.subscribe, handleGroupSync]);

   // Subscribe to group key updates
   useEffect(() => {
     if (!ws.isConnected) return;

      const unsub = ws.subscribe('group_key_update', (data: unknown) => {
        // Handle both direct mode (full WSMessage) and worker mode (payload only)
        const anyData = data as any;
        const payload = anyData.payload ? anyData.payload : data;
        void handleGroupKeyUpdate(payload as GroupSyncPayload);
      });

     return () => unsub();
   }, [ws.isConnected, ws.subscribe, handleGroupKeyUpdate]);

    // Group message subscription is now handled by useChatWebSocket with queue support

   // Subscribe to typing indicators
  useEffect(() => {
    if (!ws.isConnected) return;

    const unsub = ws.subscribe('typing', (data: unknown) => {
      // Handle both direct mode (full WSMessage) and worker mode (payload only)
      const anyData = data as any;
      const payload = anyData.payload ? anyData.payload : data;
      const typedPayload = payload as TypingIndicatorPayload;
      if (payload.chatId && payload.userId) {
        handleTypingIndicator({
          chatId: payload.chatId,
          userId: payload.userId,
          isTyping: payload.isTyping ?? false,
        });
      }
    });

    return () => unsub();
  }, [ws.isConnected, ws.subscribe, handleTypingIndicator]);

  // Clear active chat
  const clearActiveChat = useCallback(() => {
    setActiveChat(null);
  }, [setActiveChat]);

  // Contact card state
  const [contactCardOpen, setContactCardOpen] = useState(false);
  const [contactUserId, setContactUserId] = useState<string | null>(null);
  const [contactChatId, setContactChatId] = useState<string | null>(null);

  // Open contact card - finds existing private chat or uses current chat
  const openContactCard = useCallback((userId: string) => {
    if (!user) return;

    // Find existing private chat with this user
    const privateChat = chats.find(c =>
      c.type === 'private' &&
      c.participants.some(p => p.id === userId)
    );

    // Use private chat if found, otherwise fallback to current active chat
    const chatIdToUse = privateChat?.id || activeChat?.id || null;

    setContactUserId(userId);
    setContactChatId(chatIdToUse);
    setContactCardOpen(true);
  }, [chats, activeChat, user]);

  // Close contact card
  const closeContactCard = useCallback(() => {
    setContactCardOpen(false);
    setContactUserId(null);
    setContactChatId(null);
  }, []);

  // Wrapper for setActiveChat that marks messages as read
  const selectChat = useCallback(async (chat: Chat | null) => {
    setActiveChat(chat);

    if (chat && !chat.isVirtual) {
      // Dispatch event for chat selection (to update scroll position in ChatMessages)
      window.dispatchEvent(new CustomEvent('zerochat:chat-selected', { detail: { chatId: chat.id } }));

      // Mark messages as read when opening a chat with unread messages
      if (chat.unreadCount && chat.unreadCount > 0 && ws.isConnected) {
        setChats(prev => prev.map(c =>
          c.id === chat.id ? { ...c, unreadCount: 0 } : c
        ));
        ws.sendMarkRead(chat.id);
        await resetUnreadCount(chat.id);
        // Sync with Zustand store - this is critical for ChatList to update
        useUnreadStore.getState().resetUnreadCount(chat.id);
      }

      // Initialize Sender Key for group chats when entering
      if (chat.type === 'group' && signal.isInitialized) {
        try {
          await signal.initializeSenderKey(chat.id);
        } catch (err) {
          console.error('[ChatContext] Failed to initialize Sender Key:', err);
        }
      }
    }
  }, [ws, signal, setActiveChat, setChats]);

  // Mark messages as read
  const markAsRead = useCallback(async (chatId: string, messageIds?: string[]) => {
    if (!ws.isConnected) return;

    setChats(prev => prev.map(chat =>
      chat.id === chatId ? { ...chat, unreadCount: 0 } : chat
    ));

    await ws.sendMarkRead(chatId, messageIds);
    await resetUnreadCount(chatId);
    // Sync with Zustand store - this is critical for ChatList to update
    useUnreadStore.getState().resetUnreadCount(chatId);
  }, [ws, setChats]);

  // Send message wrapper that passes activeChat or specified chat
  const sendMessageWrapper = useCallback(async (content: string, chatOrChatId?: Chat | string, replyTo?: string, metadata?: Record<string, any>) => {
    let targetChat = activeChat;
    if (chatOrChatId) {
      if (typeof chatOrChatId === 'string') {
        targetChat = chats.find(c => c.id === chatOrChatId) || null;
      } else {
        targetChat = chatOrChatId;
      }
    }
    await sendMessage(content, targetChat, replyTo, metadata);
  }, [sendMessage, activeChat, chats]);

  // Send favorites message wrapper (accepts optional chat for forwarding)
  const sendFavoritesMessageWrapper = useCallback(async (content: string, chatOrChatId?: Chat | string, replyTo?: string, metadata?: Record<string, any>) => {
    let targetChat: Chat | null = null;
    if (chatOrChatId) {
      if (typeof chatOrChatId === 'string') {
        targetChat = chats.find(c => c.id === chatOrChatId) || null;
      } else {
        targetChat = chatOrChatId;
      }
    } else {
      targetChat = activeChat;
    }
    await sendFavoritesMessage(content, targetChat, replyTo, metadata);
  }, [sendFavoritesMessage, activeChat, chats]);

   // Memoize context value to prevent unnecessary re-renders
   // This is critical for performance - without it, ALL consumers re-render when ANY value changes
     const value = useMemo<ChatContextType>(() => ({
       chats,
       activeChat,
       chatsLoading,
       typingUsers,
       setActiveChat,
       setChats, // Add setChats for external updates
       selectChat,
       clearActiveChat,
       loadChats,
       createChat,
       sendMessage: sendMessageWrapper,
       sendFavoritesMessage: sendFavoritesMessageWrapper,
       markAsRead,
       updateChat,
       muteChat,
       unmuteChat,
       archiveChat,
       unarchiveChat,
       leaveChat,
       deleteChat,
       deleteMessage,
       editMessage,
       pinMessage,
       unpinMessage,
       reactToMessage,
       clearChat,
       exportChat,
       reportMessage,
       addParticipant,
       removeParticipant,
       updateParticipantRole,
       getTypingUsers,
       // Folder commands
       createFolder,
       updateFolder,
       deleteFolder,
       addChatToFolder,
       removeChatFromFolder,
       reorderFolder,
       // Virtual chat support
       openVirtualChat,
       // Contact card support
       contactCardOpen,
       contactUserId,
       contactChatId,
       openContactCard,
       closeContactCard,
     }), [
       chats,
       activeChat,
      chatsLoading,
       typingUsers,
       setActiveChat,
       setChats, // Add to dependencies
       selectChat,
       clearActiveChat,
       loadChats,
       createChat,
       sendMessageWrapper,
       sendFavoritesMessageWrapper,
       markAsRead,
       updateChat,
       muteChat,
       unmuteChat,
       archiveChat,
       unarchiveChat,
       leaveChat,
       deleteChat,
       deleteMessage,
       editMessage,
       pinMessage,
       unpinMessage,
        reactToMessage,
        clearChat,
        exportChat,
        reportMessage,
        addParticipant,
        removeParticipant,
        updateParticipantRole,
        getTypingUsers,
        createFolder,
        updateFolder,
        deleteFolder,
        addChatToFolder,
        removeChatFromFolder,
        reorderFolder,
        openVirtualChat,
        contactCardOpen,
        contactUserId,
        contactChatId,
        openContactCard,
        closeContactCard,
     ]);

  return (
    <ChatContext.Provider value={value}>
      {children}
    </ChatContext.Provider>
  );
}

// ==================== Hook ====================

export function useChat(): ChatContextType {
  const context = useContext(ChatContext);
  if (!context) {
    throw new Error('useChat must be used within ChatProvider');
  }
  return context;
}
