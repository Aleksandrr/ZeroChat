/**
 * useChatMessages - Hook for managing chat messages and operations
 * Extracted from ChatContext.tsx
 */
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { SignalContextType } from '@/contexts/SignalContext';
import { arrayBufferToBase64, base64ToArrayBuffer, establishedSessions } from '@/contexts/SignalContext';
import { apiBundleToPreKeyBundle } from '@/lib/signal/utils/bundle-converter';
import { getCurrentDeviceId } from '@/lib/signal';
import type { WebSocketContextType } from '@/contexts/WebSocketContext';
import { useWebSocketContext } from '@/contexts/WebSocketContext';
import { useAuth } from '@/contexts/AuthContext';
import { useSignal } from '@/contexts/SignalContext';
import { toast } from '@/components/ui/toast';
import {
  deleteMessage as deleteMessageFromDB,
  getLastMessagesForChats,
  getMessage,
  initMessagesDB,
  pinMessage as pinMessageInDB,
  unpinMessage as unpinMessageInDB,
  storeMessage,
  storeMessageRecord,
  updateMessageContent,
  updateMessageStatus,
  getChatMetadata,
  storeReaction,
  deleteReaction,
} from '@/lib/messages';
import { userCacheService } from '@/services/user-cache';
import { chatListCoordinator } from '@/lib/chat-coordinator';
import type { PreKeyBundle } from '@/lib/signal/types';
import { queryKeys } from '@/queries';
import { contactsService } from '@/services/contacts';
import type { ContactRecord } from '@/lib/messages';
import { chatService } from '@/services/chat';
import { getAccessToken } from '@/services/auth';
import type { Chat, User } from '@/types';

const MESSAGE_RECORD_EXPIRY_DAYS = 7;
const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001/api';

interface UseChatMessagesReturn {
  chats: Chat[];
  setChats: React.Dispatch<React.SetStateAction<Chat[]>>;
  activeChat: Chat | null;
  setActiveChat: React.Dispatch<React.SetStateAction<Chat | null>>;
  chatsLoading: boolean;
  loadChats: (forceRefresh?: boolean) => Promise<void>;
  createChat: (username: string) => Promise<Chat>;
  sendMessage: (content: string, activeChat: Chat | null, replyTo?: string, metadata?: Record<string, any>) => Promise<void>;
  updateChat: (chatId: string, updates: Partial<Chat>) => void;
  // Chat management commands
  muteChat: (chatId: string, mutedUntil?: number | null) => Promise<void>;
  unmuteChat: (chatId: string) => Promise<void>;
  archiveChat: (chatId: string) => Promise<void>;
  unarchiveChat: (chatId: string) => Promise<void>;
  leaveChat: (chatId: string) => Promise<void>;
  deleteChat: (chatId: string, deleteMessages?: boolean) => Promise<void>;
  // Message commands
  deleteMessage: (messageId: string, chatId: string, deleteForEveryone: boolean) => Promise<void>;
  editMessage: (messageId: string, chatId: string, content: string) => Promise<void>;
  pinMessage: (messageId: string, chatId: string) => Promise<void>;
  unpinMessage: (messageId: string, chatId: string) => Promise<void>;
  reactToMessage: (messageId: string, chatId: string, emoji: string, add: boolean) => Promise<void>;
  // System commands
  clearChat: (chatId: string) => Promise<void>;
  exportChat: (chatId: string) => Promise<Blob>;
  reportMessage: (chatId: string, messageId: string, reason: 'spam' | 'abuse' | 'inappropriate' | 'other') => Promise<void>;
  // Folder commands
  createFolder: (name: string, color?: string, order?: number) => Promise<string>;
  updateFolder: (folderId: string, updates: { name?: string; color?: string; order?: number }) => Promise<void>;
  deleteFolder: (folderId: string, moveChatsTo?: string | null) => Promise<void>;
  addChatToFolder: (folderId: string, chatId: string) => Promise<void>;
  removeChatFromFolder: (folderId: string, chatId: string) => Promise<void>;
  reorderFolder: (folderId: string, newOrder: number) => Promise<void>;
  // Virtual chat support
  openVirtualChat: (contact: { id: string; username: string; displayName?: string; avatar?: string }) => void;
}

// Internal hook that requires context parameters
function useChatMessagesInternal({ user, signal, ws }: {
  user: { id: string; username: string } | null;
  signal: SignalContextType;
  ws: WebSocketContextType;
}): UseChatMessagesReturn {
  const queryClient = useQueryClient();
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeChat, setActiveChat] = useState<Chat | null>(null);
  const [chatsLoading, setChatsLoading] = useState(false);
  const [messagesDbReady, setMessagesDbReady] = useState(false);
  const messagesDbReadyRef = useRef(false);

  const chatsLoadedRef = useRef(false);
  const loadChatsRef = useRef<(() => Promise<void>) | null>(null);

  // Throttle map for reactToMessage: key=`${messageId}:${emoji}:${add}` -> last-call timestamp.
  // Using a ref so the map survives useCallback identity changes.
  const reactThrottleRef = useRef<Map<string, number>>(new Map());

  // Get commandBus from ws context
  const commandBus = ws.commandBus;

   // Initialize messages DB
   useEffect(() => {
     let mounted = true;

     initMessagesDB()
       .then(async () => {
         if (mounted) {
           messagesDbReadyRef.current = true;
           setMessagesDbReady(true);
           
           // Clear stale user cache entries ONCE on app startup (not on every chat load)
           // This is moved to a separate initialization hook or done only once per app session
         }
       })
       .catch(console.error);

     return () => {
       mounted = false;
     };
   }, []);

  // Reset loaded flag when user logs out
  useEffect(() => {
    if (!user) {
      chatsLoadedRef.current = false;
      setChats([]);
      setActiveChat(null);
    }
  }, [user]);

   // Load chats from API
   const loadChats = useCallback(async (forceRefresh = false) => {
     if (!user) return;

     // Skip if already loaded and not forcing refresh
     if (chatsLoadedRef.current && !forceRefresh) {
       return;
     }
       
     // Reset the flag when force refreshing to ensure fresh data
     if (forceRefresh) {
       chatsLoadedRef.current = false;
     }

     try {
       setChatsLoading(true);
       // Use coordinator to avoid duplicate fetches across tabs
       let data = await chatListCoordinator.getChats(forceRefresh);

      // ==================== System Chat Persistence ====================
      // Ensure system chat is present after page reload (if it exists in localStorage)
      const SYSTEM_CHAT_STORAGE_KEY = 'system-chat';
      const SYSTEM_CHAT_ID_KEY = 'system-chat-id';
      const systemChatId = localStorage.getItem(SYSTEM_CHAT_ID_KEY);
      const savedSystemChat = localStorage.getItem(SYSTEM_CHAT_STORAGE_KEY);
      if (systemChatId && savedSystemChat && data && !data.some(c => c.id === systemChatId)) {
        try {
          const systemChat = JSON.parse(savedSystemChat) as Chat;
           // Get the actual unread count from IndexedDB metadata (persisted)
           try {
             const metadata = await getChatMetadata(systemChatId);
             if (metadata) {
               systemChat.unreadCount = metadata.unreadCount;
             } else {
               systemChat.unreadCount = 0;
             }
           } catch (e) {
             console.error('[useChatMessages] Failed to get system chat metadata:', e);
             systemChat.unreadCount = 0;
           }
           data.unshift(systemChat);
        } catch (e) {
          console.error('[useChatMessages] Failed to parse system chat from localStorage:', e);
        }
      }
      // ================================================================

       // Get all local contacts to apply displayName overrides
       let contactsMap = new Map<string, ContactRecord>();
       if (messagesDbReadyRef.current) {
         const allContacts = await contactsService.getAllContacts();
         contactsMap = new Map(allContacts.map(c => [c.id, c]));
       }

       // Get last messages and unread counts from IndexedDB for preview
       let chatsToSet: Chat[];
       if (data && data.length > 0 && messagesDbReadyRef.current) {
          const chatIds = data.map(c => c.id);
          const lastMessagesMap = await getLastMessagesForChats(chatIds);
   
            chatsToSet = data.map(chat => {
             const localLastMsg = lastMessagesMap.get(chat.id);
             
             const updates: Partial<Chat> = {};
            
            if (localLastMsg) {
              updates.lastMessage = {
                id: localLastMsg.id,
                content: localLastMsg.content,
                senderId: localLastMsg.senderId,
                createdAt: new Date(localLastMsg.timestamp).toISOString(),
                type: localLastMsg.type as 'TEXT' | 'IMAGE' | 'FILE' | 'AUDIO' | 'VIDEO' | 'SYSTEM' | undefined,
                attachments: localLastMsg.attachments,
              };
            }

             // Apply local contact displayName overrides for participants
             const enhancedParticipants = chat.participants.map(p => {
               const localContact = contactsMap.get(p.id);
               if (localContact && localContact.displayName) {
                 return { ...p, displayName: localContact.displayName };
               }
               return p;
             });
             updates.participants = enhancedParticipants;
           
           // Always use the backend's unread count instead of local metadata
           // This ensures consistency across devices
           const updatedChat = {
             ...chat,
             ...updates,
             unreadCount: chat.unreadCount, // Always trust backend
           };
           return updatedChat;
         });
       } else {
         chatsToSet = (data || []).map(chat => ({
           ...chat,
           participants: chat.participants.map(p => {
             const localContact = contactsMap.get(p.id);
             if (localContact && localContact.displayName) {
               return { ...p, displayName: localContact.displayName };
             }
             return p;
           }),
         }));
       }

       // Cache participants for all chats (automatic user cache population)
       if (chatsToSet.length > 0) {
         try {
           for (const chat of chatsToSet) {
             if (chat.participants && chat.participants.length > 0) {
               await userCacheService.cacheParticipants(chat.id, chat.participants as any);
             }
           }
         } catch (error) {
           console.error('[useChatMessages] Failed to cache chat participants:', error);
         }
       }

       setChats(chatsToSet);

       // Update activeChat with fresh data if it exists in the new list
       if (activeChat) {
         const updatedActiveChat = chatsToSet.find(c => c.id === activeChat.id);
         if (updatedActiveChat) {
           setActiveChat(updatedActiveChat);
         }
       }

      chatsLoadedRef.current = true;
    } catch (error) {
      console.error('[useChatMessages] Failed to load chats:', error);
      chatsLoadedRef.current = true;
    } finally {
      setChatsLoading(false);
    }
  }, [user]);

  // Store loadChats in ref for external use
  useEffect(() => {
    loadChatsRef.current = loadChats;
  }, [loadChats]);

  // Load chats on mount and when user/db readiness changes
  useEffect(() => {
    if (user && messagesDbReady && !chatsLoadedRef.current && !chatsLoading) {
      void loadChatsRef.current?.();
    }
  }, [user, messagesDbReady, chatsLoading]);

    // Global handler for incoming reaction commands from other devices/users
    useEffect(() => {
      if (!commandBus || !user) return;

      const unsubscribe = commandBus.subscribeToCommandEvents(async (event) => {
        if (event.type !== 'event') return;

        const eventPayload = event.payload as {
          commandType: string;
          payload: Record<string, unknown>;
          issuer?: { userId?: string; deviceId?: string };
        };
        const { commandType, payload } = eventPayload;

        // Handle message reactions
        if (commandType === 'message.react' || commandType === 'message.unreact') {
          const { messageId, emoji, chatId } = payload as {
            messageId: string;
            emoji: string;
            chatId: string;
          };
          const issuer = eventPayload.issuer;
          const reactorUserId = issuer?.userId || user.id;

          try {
            if (commandType === 'message.react') {
              await storeReaction(messageId, reactorUserId, emoji);
            } else {
              await deleteReaction(messageId, reactorUserId, emoji);
            }
            // Invalidate messages query to refresh UI
            queryClient.invalidateQueries({ queryKey: queryKeys.messages.chat(chatId) });
          } catch (error) {
            console.error(`[useChatMessages] Failed to ${commandType === 'message.react' ? 'store' : 'delete'} incoming reaction:`, error);
          }
        }
      });

      return unsubscribe;
    }, [commandBus, user, queryClient]);

   // Create a new direct chat or return existing one
   const createChat = useCallback(async (
     username: string
   ): Promise<Chat> => {
     try {
       // Check if chat with this user already exists
       const existingChat = chats.find(chat =>
         chat.type === 'private' &&
         chat.participants.some(p => p.username === username)
       );

       if (existingChat) {
         return existingChat;
       }

       const response = await chatService.createDirectChat(username);
       const newChat: Chat = {
         id: response.chatId,
         name: response.participants?.[0]?.username || username,
         type: 'private',
         participants: response.participants?.map((p) => ({
           id: p.userId,
           username: p.username,
           displayName: p.displayName,
           status: p.status,
           lastSeen: p.lastSeen,
           deviceId: (() => { const parsed = parseInt(String(p.deviceId), 10); return !isNaN(parsed) ? parsed : undefined; })(),
           needsSession: p.needsSession
         })) || [],
         createdAt: new Date().toISOString(),
         updatedAt: new Date().toISOString(),
       };

       setChats(prev => {
         if (prev.some(c => c.id === newChat.id)) {
           return prev;
         }
         return [newChat, ...prev];
       });

       // Cache participants for the new chat
       try {
         if (newChat.participants && newChat.participants.length > 0) {
           await userCacheService.cacheParticipants(newChat.id, newChat.participants as any);
         }
       } catch (error) {
         console.error('[useChatMessages] Failed to cache participants for new chat:', error);
       }

       return newChat;
     } catch (error) {
       console.error('[useChatMessages] Failed to create chat:', error);
       throw error;
     }
   }, [chats]);

    // Open a virtual chat with a contact (chat not yet created on server)
     const openVirtualChat = useCallback((contact: {
       id: string;
       username: string;
       displayName?: string;
       avatar?: string;
     }) => {
      if (!user) {
         console.warn('[useChatMessages] Cannot open virtual chat: user not available');
         return;
       }

       const currentUser = user as User; // Non-null assertion after check

       const virtualChat: Chat = {
         id: `virtual-${contact.id}`,
         type: 'private',
         participants: [
           {
             id: currentUser.id,
             username: currentUser.username,
             displayName: currentUser.displayName,
             avatar: currentUser.avatar,
             status: currentUser.status,
             lastSeen: currentUser.lastSeen,
             deviceId: currentUser.deviceId,
             needsSession: currentUser.needsSession,
           },
           {
             id: contact.id,
             username: contact.username,
             displayName: contact.displayName,
             avatar: contact.avatar,
             status: undefined,
             lastSeen: undefined,
             deviceId: undefined,
             needsSession: undefined,
           }
         ],
         createdAt: new Date().toISOString(),
         updatedAt: new Date().toISOString(),
         isVirtual: true,
       };

        setActiveChat(virtualChat);
     }, [user]);

  // Helper to ensure session exists with a device
  const ensureSession = useCallback(async (targetUserId: string, deviceId: number): Promise<void> => {
    const sessionExists = await signal.hasSession(targetUserId, deviceId);
    if (sessionExists) return;

    const bundle = await chatService.getPreKeyBundle(targetUserId, deviceId.toString());
    const preKeyBundle = apiBundleToPreKeyBundle({ ...bundle, identityKeyPub: bundle.identityKeyPub });

    await signal.processPreKeyBundle(targetUserId, deviceId, preKeyBundle);
  }, [signal]);

  // Send a message (private or group)
  const sendMessage = useCallback(async (
    content: string,
    targetChat: Chat | null,
    replyTo?: string,
    metadata?: Record<string, any>
  ): Promise<void> => {
      if (!user) throw new Error('User not authenticated');
      if (!ws.isConnected) throw new Error('WebSocket not connected');

      const currentDeviceId = getCurrentDeviceId();
      
      if (!targetChat) throw new Error('Chat not found');
      let chat = targetChat;

      // Handle virtual chat - create real chat on server first.
      // The backend does NOT accept an initialMessage on POST /chats, so we
      // create the chat and then fall through to the encrypted WS send path
      // to actually deliver the first message. The previous implementation
      // returned early after storeMessage(), which meant the recipient NEVER
      // received the first message of a virtual chat.
      if (chat.isVirtual) {
        try {
          const contact = chat.participants.find(p => p.id !== user.id);
          if (!contact) {
            throw new Error('No contact found for virtual chat');
          }
          // 1. Create real chat (no initialMessage — backend doesn't support it).
          const newRealChat = await createChat(contact.username);
          try {
            await userCacheService.cacheParticipants(newRealChat.id, newRealChat.participants as any);
          } catch (error) {
            console.error('[useChatMessages] Failed to cache participants:', error);
          }
          // 2. Replace virtual chat in local state (if it was added to chats array).
          setChats(prev => prev.map(c =>
            c.id === chat.id ? { ...newRealChat, isVirtual: false } : c
          ));
          // 3. Update activeChat if it points to the virtual chat.
          if (activeChat?.id === chat.id) {
            setActiveChat({ ...newRealChat, isVirtual: false });
          }
          // 4. Replace local chat variable for fall-through to encryption path.
          chat = { ...newRealChat, isVirtual: false };
          // Do NOT return — fall through to encryption + ws.sendMultiDeviceMessage
        } catch (error) {
          console.error('[useChatMessages] Failed to create chat from virtual:', error);
          throw error;
        }
      }

      // Handle GROUP CHAT messages
     if (chat.type === 'group') {
       let groupMessageId: string | undefined;
       try {
         // Initialize Sender Key and get the distribution message (SKDM)
          const skdm = await signal.initializeSenderKey(chat.id);
          const skdmBase64 = arrayBufferToBase64(skdm);

          const encrypted = await signal.encryptGroupMessage(chat.id, content);
          const encryptedBase64 = arrayBufferToBase64(encrypted.body);

         groupMessageId = await ws.sendGroupMessage(
           chat.id,
           user.id,
           String(currentDeviceId),
           encryptedBase64,
           undefined, // messageId
           undefined, // senderKeyId
           replyTo, // replyTo
           undefined, // attachments
           skdmBase64, // senderKeyDistribution - SKDM to share with other members
           metadata // metadata
         );
         const messageId = groupMessageId;

          await storeMessage({
            id: messageId,
            chatId: chat.id,
            senderId: user.id,
            senderUsername: user.username,
            senderDeviceId: currentDeviceId,
            content,
            timestamp: Date.now(),
            createdAt: Date.now(),
            messageType: encrypted.type,
            isOutgoing: true,
            status: 'sent',
            type: 'TEXT',
            isPinned: false,
            editedAt: 0,
            replyTo,
            replyToOriginalSenderId: metadata?.replyTo?.originalSenderId,
            metadata, // Include forwarded metadata
          });

         void queryClient.invalidateQueries({
           queryKey: queryKeys.messages.chat(chat.id),
         });

         setChats(prev => prev.map(c => {
           if (c.id === chat.id) {
             return {
               ...c,
               lastMessage: {
                 id: messageId,
                 content,
                 senderId: user.id,
                 chatId: chat.id,
                 createdAt: new Date().toISOString(),
                 timestamp: new Date().toISOString(),
                 type: 'TEXT',
               },
               updatedAt: new Date().toISOString(),
             };
           }
           return c;
         }));

       } catch (err) {
         console.error('[useChatMessages] Failed to send group message:', err);
         if (groupMessageId) {
           try {
             await updateMessageStatus(groupMessageId, 'failed');
             void queryClient.invalidateQueries({ queryKey: queryKeys.messages.chat(chat.id) });
           } catch {}
         }
         toast.error('Не удалось отправить сообщение', 'Проверьте подключение');
         throw err;
       }
       // U10: post-send prekey check — each outgoing message consumes
       // one of our one-time prekeys on the recipient's bundle fetch,
       // so a busy conversation can drain the pool faster than the
       // hourly check would notice. Dispatch the event; the
       // `usePrekeyManager` hook (in SignalProvider's tree) picks it
       // up and runs `checkAndReplenish` async. Best-effort — if the
       // manager isn't mounted yet, the event silently no-ops.
       window.dispatchEvent(new Event('zerochat:prekey-check'));
       return;
     }

     // Handle PRIVATE CHAT messages
     const recipient = chat.participants.find(p => p.id !== user.id) || chat.participants[0];
     if (!recipient) {
       throw new Error('Recipient not found');
     }

     try {
       const recipientDevices = await chatService.getRecipientDevices(recipient.id);
       if (recipientDevices.length === 0) {
         throw new Error(`Recipient ${recipient.username} has no registered devices.`);
       }

       const senderDevices = await chatService.getRecipientDevices(user.id);
       const otherSenderDevices = senderDevices.filter(d => d.deviceId !== currentDeviceId);

       // Establish sessions with all recipient devices
       for (const device of recipientDevices) {
         await ensureSession(recipient.id, device.deviceId);
       }

       // Establish sessions with sender's other devices (self-delivery)
       for (const device of otherSenderDevices) {
         await ensureSession(user.id, device.deviceId);
       }

       // Encrypt for each recipient device SEQUENTIALLY
       const recipientMessages: { deviceId: number; content: string; messageType: number }[] = [];
       for (const device of recipientDevices) {
         const encrypted = await signal.encrypt(recipient.id, device.deviceId, content);
         const encryptedBase64 = arrayBufferToBase64(encrypted.body);
         recipientMessages.push({
           deviceId: device.deviceId,
           content: encryptedBase64,
           messageType: encrypted.type,
         });
       }

       // Encrypt for sender's other devices (self-delivery) SEQUENTIALLY
       let senderMessages: { deviceId: number; content: string; messageType: number }[] | undefined;
       if (otherSenderDevices.length > 0) {
         senderMessages = [];
         for (const device of otherSenderDevices) {
           const encrypted = await signal.encrypt(user.id, device.deviceId, content);
           const encryptedBase64 = arrayBufferToBase64(encrypted.body);
           senderMessages.push({
             deviceId: device.deviceId,
             content: encryptedBase64,
             messageType: encrypted.type,
           });
         }
       }

       const messageId = await ws.sendMultiDeviceMessage(
         chat.id,
         recipient.id,
         recipientMessages,
         senderMessages,
         undefined, // attachments
         replyTo, // replyTo
         metadata // metadata
       );

       // Save MessageRecords for retry mechanism
       const now = Date.now();
       for (const { deviceId } of recipientMessages) {
         const recordId = `${messageId}-${deviceId}`;
         storeMessageRecord({
           id: recordId,
           originalMessageId: messageId,
           recipientId: recipient.id,
           recipientDeviceId: deviceId,
           plaintext: content,
           chatId: chat.id,
           createdAt: now,
           expiresAt: now + MESSAGE_RECORD_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
         }).catch(err => console.warn('[useChatMessages] Failed to store MessageRecord:', err));
       }

        // Save sent message to IndexedDB
        await storeMessage({
          id: messageId,
          chatId: chat.id,
          senderId: user.id,
          senderUsername: user.username,
          senderDeviceId: currentDeviceId,
          content,
          timestamp: Date.now(),
          createdAt: Date.now(),
          messageType: recipientMessages[0]?.messageType || 2,
          isOutgoing: true,
          status: 'sent',
          type: 'TEXT',
          isPinned: false,
          editedAt: 0,
          replyTo,
          replyToOriginalSenderId: metadata?.replyTo?.originalSenderId,
          metadata, // Include forwarded metadata
          });

         void queryClient.invalidateQueries({
           queryKey: queryKeys.messages.chat(chat.id),
         });

         // Invalidate chats cache to refresh sidebar
         // Обновить lastMessage в списке чатов для отображения в сайдбаре
         setChats(prev => prev.map(c => {
           if (c.id === chat.id) {
             return {
               ...c,
               lastMessage: {
                 id: messageId,
                 content,
                 senderId: user.id,
                 chatId: chat.id,
                 createdAt: new Date().toISOString(),
                 timestamp: new Date().toISOString(),
                 type: 'TEXT',
               },
               updatedAt: new Date().toISOString(),
             };
           }
           return c;
         }));

      void queryClient.invalidateQueries({
        queryKey: queryKeys.chats.lists(),
      });

      // U10: post-send prekey check (same rationale as group branch).
      window.dispatchEvent(new Event('zerochat:prekey-check'));

    } catch (error) {
      console.error('[useChatMessages] Failed to send encrypted message:', error);
      toast.error('Не удалось отправить сообщение', 'Проверьте подключение');
      throw error; // propagate to MessageInput so it can restore the draft
    }
  }, [user, ws, signal, ensureSession, queryClient, createChat, activeChat]);

  // Update chat
  const updateChat = useCallback((chatId: string, updates: Partial<Chat>) => {
    setChats(prev => prev.map(chat =>
      chat.id === chatId ? { ...chat, ...updates } : chat
    ));
  }, []);

  // Chat management commands via Command Bus
  const muteChat = useCallback(async (chatId: string, mutedUntil?: number | null) => {
    if (!commandBus) throw new Error('CommandBus not available');
    await commandBus.sendCommand(
      'chat.mute',
      {
        chatId,
        mutedUntil: mutedUntil ? new Date(mutedUntil).toISOString() : null,
      },
      { encrypt: false }
    );
    // Optimistic update
    setChats(prev => prev.map(chat =>
      chat.id === chatId ? { ...chat, isMuted: true, mutedUntil: mutedUntil ?? undefined } : chat
    ));
  }, [commandBus, setChats]);

  const unmuteChat = useCallback(async (chatId: string) => {
    if (!commandBus) throw new Error('CommandBus not available');
    await commandBus.sendCommand(
      'chat.unmute',
      { chatId },
      { encrypt: false }
    );
    // Optimistic update
    setChats(prev => prev.map(chat =>
      chat.id === chatId ? { ...chat, isMuted: false, mutedUntil: undefined } : chat
    ));
  }, [commandBus, setChats]);

  const archiveChat = useCallback(async (chatId: string) => {
    if (!commandBus) throw new Error('CommandBus not available');
    await commandBus.sendCommand(
      'chat.archive',
      { chatId },
      { encrypt: false }
    );
    // Optimistic update
    setChats(prev => prev.map(chat =>
      chat.id === chatId ? { ...chat, isArchived: true } : chat
    ));
  }, [commandBus, setChats]);

  const unarchiveChat = useCallback(async (chatId: string) => {
    if (!commandBus) throw new Error('CommandBus not available');
    await commandBus.sendCommand(
      'chat.unarchive',
      { chatId },
      { encrypt: false }
    );
    // Optimistic update
    setChats(prev => prev.map(chat =>
      chat.id === chatId ? { ...chat, isArchived: false } : chat
    ));
  }, [commandBus, setChats]);

  const leaveChat = useCallback(async (chatId: string) => {
    if (!commandBus) throw new Error('CommandBus not available');
    if (!user) throw new Error('User not available');
    try {
      await commandBus.sendCommand(
        'chat.leave',
        { chatId, userId: user.id },
        { encrypt: false }
      );
      // Optimistic update - remove from list
      setChats(prev => prev.filter(chat => chat.id !== chatId));
      if (activeChat?.id === chatId) {
        setActiveChat(null);
      }
    } catch (err) {
      console.error('[useChatMessages] leaveChat failed:', err);
      toast.error('Не удалось покинуть чат', err instanceof Error ? err.message : undefined);
      throw err;
    }
  }, [commandBus, setChats, activeChat, setActiveChat, user]);

  const deleteChat = useCallback(async (chatId: string, deleteMessages = true) => {
    if (!commandBus) throw new Error('CommandBus not available');
    await commandBus.sendCommand(
      'chat.delete',
      { chatId, deleteMessages },
      { encrypt: false }
    );
    // Clean up deleter's IndexedDB immediately
    try {
      const { deleteChatMessages: delMsgs, deleteChatAttachments: delAtts, deleteChatMetadata: delMeta } = await import('@/lib/messages');
      await Promise.all([
        delMsgs(chatId),
        delAtts(chatId),
        delMeta(chatId),
      ]);
    } catch (error) {
      console.error('[deleteChat] Failed to clean up IndexedDB:', error);
    }
    // Remove from local state
    setChats(prev => prev.filter(chat => chat.id !== chatId));
    if (activeChat?.id === chatId) {
      setActiveChat(null);
    }
  }, [commandBus, setChats, activeChat, setActiveChat]);

  // Helper function to get recipient ID for a chat (for P2P encryption)
  const getChatRecipientId = useCallback((chatId: string): string => {
    const chat = chats.find(c => c.id === chatId);
    if (!chat) throw new Error(`Chat ${chatId} not found`);
    if (chat.type === 'private') {
      const recipient = chat.participants.find(p => p.id !== user?.id);
      return recipient?.id || '';
    }
    // For group chats, commands are server-mediated (encrypt: false)
    return '';
  }, [chats, user]);

  // Command Bus methods
  const deleteMessage = useCallback(async (messageId: string, chatId: string, deleteForEveryone: boolean) => {
    if (!commandBus) throw new Error('CommandBus not available');

    // 1. Snapshot for rollback
    let snapshot: Awaited<ReturnType<typeof getMessage>> | undefined;
    try {
      snapshot = await getMessage(messageId);
    } catch {}

    // 2. Optimistic: delete from local IndexedDB immediately
    try { await deleteMessageFromDB(messageId); } catch {}
    void queryClient.invalidateQueries({ queryKey: queryKeys.messages.chat(chatId) });

    // 3. Send command + rollback on failure
    try {
      await commandBus.sendCommand(
        'message.delete',
        {
          messageId,
          chatId,
          deleteForEveryone,
        },
        {
          encrypt: deleteForEveryone,
          recipientId: deleteForEveryone ? getChatRecipientId(chatId) : undefined,
        }
      );
    } catch (err) {
      console.error('[useChatMessages] deleteMessage failed:', err);
      if (snapshot) {
        try { await storeMessage(snapshot); } catch {}
        void queryClient.invalidateQueries({ queryKey: queryKeys.messages.chat(chatId) });
      }
      toast.error('Не удалось удалить сообщение', err instanceof Error ? err.message : undefined);
      throw err;
    }
  }, [commandBus, getChatRecipientId, queryClient]);

  const editMessage = useCallback(async (messageId: string, chatId: string, content: string) => {
    if (!commandBus) throw new Error('CommandBus not available');

    // 1. Snapshot for rollback
    let snapshot: Awaited<ReturnType<typeof getMessage>> | undefined;
    try {
      snapshot = await getMessage(messageId);
    } catch {}

    // 2. Optimistic: update local IndexedDB immediately
    const editTimestamp = Date.now();
    try { await updateMessageContent(messageId, content, editTimestamp); } catch {}
    void queryClient.invalidateQueries({ queryKey: queryKeys.messages.chat(chatId) });

    // 3. Send command + rollback on failure
    try {
      await commandBus.sendCommand(
        'message.edit',
        {
          messageId,
          chatId,
          content,
          editTimestamp,
        },
        {
          encrypt: true,
          recipientId: getChatRecipientId(chatId),
        }
      );
    } catch (err) {
      console.error('[useChatMessages] editMessage failed:', err);
      if (snapshot) {
        try { await storeMessage(snapshot); } catch {}
        void queryClient.invalidateQueries({ queryKey: queryKeys.messages.chat(chatId) });
      }
      toast.error('Не удалось редактировать сообщение', err instanceof Error ? err.message : undefined);
      throw err;
    }
  }, [commandBus, getChatRecipientId, queryClient]);

  const pinMessage = useCallback(async (messageId: string, chatId: string) => {
    if (!commandBus) throw new Error('CommandBus not available');

    // 1. Snapshot for rollback
    let snapshot: Awaited<ReturnType<typeof getMessage>> | undefined;
    try {
      snapshot = await getMessage(messageId);
    } catch {}

    // 2. Optimistic: pin in local IndexedDB immediately
    const pinTimestamp = Date.now();
    try { await pinMessageInDB(messageId, pinTimestamp); } catch {}
    void queryClient.invalidateQueries({ queryKey: queryKeys.messages.chat(chatId) });

    // 3. Send command + rollback on failure
    try {
      await commandBus.sendCommand(
        'message.pin',
        {
          messageId,
          chatId,
          pinTimestamp,
        },
        { encrypt: false }
      );
    } catch (err) {
      console.error('[useChatMessages] pinMessage failed:', err);
      if (snapshot) {
        try { await storeMessage(snapshot); } catch {}
        void queryClient.invalidateQueries({ queryKey: queryKeys.messages.chat(chatId) });
      }
      toast.error('Не удалось закрепить сообщение', err instanceof Error ? err.message : undefined);
      throw err;
    }
  }, [commandBus, queryClient]);

  const unpinMessage = useCallback(async (messageId: string, chatId: string) => {
    if (!commandBus) throw new Error('CommandBus not available');

    // 1. Snapshot for rollback
    let snapshot: Awaited<ReturnType<typeof getMessage>> | undefined;
    try {
      snapshot = await getMessage(messageId);
    } catch {}

    // 2. Optimistic: unpin in local IndexedDB immediately
    try { await unpinMessageInDB(messageId); } catch {}
    void queryClient.invalidateQueries({ queryKey: queryKeys.messages.chat(chatId) });

    // 3. Send command + rollback on failure
    try {
      await commandBus.sendCommand(
        'message.unpin',
        {
          messageId,
          chatId,
        },
        { encrypt: false }
      );
    } catch (err) {
      console.error('[useChatMessages] unpinMessage failed:', err);
      if (snapshot) {
        try { await storeMessage(snapshot); } catch {}
        void queryClient.invalidateQueries({ queryKey: queryKeys.messages.chat(chatId) });
      }
      toast.error('Не удалось открепить сообщение', err instanceof Error ? err.message : undefined);
      throw err;
    }
  }, [commandBus, queryClient]);

  const reactToMessage = useCallback(async (messageId: string, chatId: string, emoji: string, add: boolean) => {
    if (!commandBus) throw new Error('CommandBus not available');
    if (!user) throw new Error('User not available');
    const command = add ? 'message.react' : 'message.unreact';

    // Throttle: prevent rapid-fire commands (min 100ms between same message+emoji+action).
    // Uses a ref-held Map so the throttle state survives useCallback identity changes.
    const throttleKey = `${messageId}:${emoji}:${add}`;
    const lastCall = reactThrottleRef.current.get(throttleKey) ?? 0;
    if (Date.now() - lastCall < 100) {
      console.warn('[useChatMessages] Reaction command throttled');
      return;
    }
    reactThrottleRef.current.set(throttleKey, Date.now());

    // Optimistic update - update local IndexedDB immediately
    try {
      if (add) {
        await storeReaction(messageId, user.id, emoji);
      } else {
        await deleteReaction(messageId, user.id, emoji);
      }
      // Invalidate messages query to trigger refetch with updated reactions
      void queryClient.invalidateQueries({ queryKey: queryKeys.messages.chat(chatId) });
    } catch (error) {
      console.error('[useChatMessages] Failed to update reaction locally:', error);
      // Continue to send command anyway - server will sync later
    }

    // Send command + rollback optimistic change on failure
    const payload: Record<string, unknown> = {
      messageId,
      chatId,
      emoji,
      userId: user.id, // Всегда добавляем userId для валидации на сервере
    };
    if (add) {
      payload.add = true;
    }

    try {
      await commandBus.sendCommand(
        command,
        payload,
        { encrypt: false }
      );
    } catch (err) {
      console.error('[useChatMessages] reactToMessage failed:', err);
      // Rollback optimistic update
      try {
        if (add) {
          await deleteReaction(messageId, user.id, emoji);
        } else {
          await storeReaction(messageId, user.id, emoji);
        }
        void queryClient.invalidateQueries({ queryKey: queryKeys.messages.chat(chatId) });
      } catch {}
      toast.error('Не удалось поставить реакцию', err instanceof Error ? err.message : undefined);
      throw err;
    }
  }, [commandBus, queryClient, user]);

  // System commands
  const clearChat = useCallback(async (chatId: string) => {
    if (!commandBus) throw new Error('CommandBus not available');
    await commandBus.sendCommand(
      'system.clear_chat',
      { chatId, clearFor: 'everyone' },
      { encrypt: false }
    );
    // Clear local messages cache
    queryClient.removeQueries({ queryKey: queryKeys.messages.chat(chatId) });
  }, [commandBus, queryClient]);

  const exportChat = useCallback(async (chatId: string, format: 'json' | 'csv' = 'json'): Promise<Blob> => {
    if (!commandBus) throw new Error('CommandBus not available');

    return new Promise((resolve, reject) => {
      // Subscribe BEFORE sending to avoid missing early events. We don't know
      // the envelope commandId until sendCommand resolves, so we stash it
      // and only handle events matching it.
      let envelopeCommandId: string | null = null;

      const unsubscribe = commandBus.subscribeToCommandEvents((event) => {
        if (event.type !== 'event') return;
        if (envelopeCommandId === null || event.commandId !== envelopeCommandId) return;

        unsubscribe();
        const result = event.result as { exportUrl: string } | undefined;
        if (!result?.exportUrl) {
          reject(new Error('Export failed: no exportUrl in response'));
          return;
        }
        // Fetch the exported file
        fetch(result.exportUrl, {
          headers: {
            'Authorization': `Bearer ${getAccessToken()}`,
          },
        })
          .then(res => {
            if (!res.ok) throw new Error(`Export failed: ${res.statusText}`);
            return res.blob();
          })
          .then(resolve)
          .catch(reject);
      });

      commandBus.sendCommand(
        'system.export_chat',
        { chatId, format },
        { encrypt: false }
      ).then(returnedId => {
        envelopeCommandId = returnedId;
      }).catch(err => {
        unsubscribe();
        reject(err);
      });
    });
  }, [commandBus]);

  const reportMessage = useCallback(async (chatId: string, messageId: string, reason: 'spam' | 'abuse' | 'inappropriate' | 'other') => {
    if (!commandBus) throw new Error('CommandBus not available');
    await commandBus.sendCommand(
      'system.report_message',
      { chatId, messageId, reason },
      { encrypt: false }
    );
  }, [commandBus]);

        // ============ Folder Commands ============
   const createFolder = useCallback(async (name: string, color?: string, order: number = 0): Promise<string> => {
     if (!commandBus) throw new Error('CommandBus not available');

     return new Promise((resolve, reject) => {
       // Subscribe BEFORE sending — see exportChat for the race-condition rationale.
       let envelopeCommandId: string | null = null;

       const unsubscribe = commandBus.subscribeToCommandEvents((event) => {
         if (event.type !== 'event') return;
         if (envelopeCommandId === null || event.commandId !== envelopeCommandId) return;

         unsubscribe();
         const result = event.result as { folderId: string } | undefined;
         if (result?.folderId) {
           resolve(result.folderId);
         } else {
           reject(new Error('Failed to create folder: no folderId in response'));
         }
       });

       commandBus.sendCommand(
         'folder.create',
         {
           name,
           color: color ?? null,
           order,
         },
         { encrypt: false }
       ).then(returnedId => {
         envelopeCommandId = returnedId;
       }).catch(err => {
         unsubscribe();
         reject(err);
       });
     });
   }, [commandBus]);

  const updateFolder = useCallback(async (folderId: string, updates: { name?: string; color?: string; order?: number }): Promise<void> => {
    if (!commandBus) throw new Error('CommandBus not available');
    await commandBus.sendCommand(
      'folder.update',
      {
        folderId,
        updates,
      },
      { encrypt: false }
    );
  }, [commandBus]);

  const deleteFolder = useCallback(async (folderId: string, moveChatsTo?: string | null): Promise<void> => {
    if (!commandBus) throw new Error('CommandBus not available');
    await commandBus.sendCommand(
      'folder.delete',
      {
        folderId,
        moveChatsTo: moveChatsTo ?? null,
      },
      { encrypt: false }
    );
  }, [commandBus]);

  const addChatToFolder = useCallback(async (folderId: string, chatId: string): Promise<void> => {
    if (!commandBus) throw new Error('CommandBus not available');
    await commandBus.sendCommand(
      'folder.add_chat',
      {
        folderId,
        chatId,
      },
      { encrypt: false }
    );
  }, [commandBus]);

  const removeChatFromFolder = useCallback(async (folderId: string, chatId: string): Promise<void> => {
    if (!commandBus) throw new Error('CommandBus not available');
    await commandBus.sendCommand(
      'folder.remove_chat',
      {
        folderId,
        chatId,
      },
      { encrypt: false }
    );
  }, [commandBus]);

  const reorderFolder = useCallback(async (folderId: string, newOrder: number): Promise<void> => {
    if (!commandBus) throw new Error('CommandBus not available');
    await commandBus.sendCommand(
      'folder.reorder',
      {
        folderId,
        newOrder,
      },
      { encrypt: false }
    );
  }, [commandBus]);

   return {
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
    };
}

// Public hook that automatically gets contexts
export function useChatMessages(): UseChatMessagesReturn {
  const { user } = useAuth();
  const signal = useSignal();
  const ws = useWebSocketContext();
  if (!ws) {
    throw new Error('WebSocketContext not available');
  }
  return useChatMessagesInternal({ user, signal, ws });
}