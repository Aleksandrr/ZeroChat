/**
 * useChatWebSocket - Hook for managing WebSocket event handlers
 * Extracted from ChatContext.tsx
 */
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';

import type { SignalContextType } from '@/contexts/SignalContext';
import { apiBundleToPreKeyBundle } from '@/lib/signal/utils/bundle-converter';
import { arrayBufferToBase64, base64ToArrayBuffer, establishedSessions } from '@/contexts/SignalContext';
import type { WebSocketContextType } from '@/contexts/WebSocketContext';
import {
  deleteMessageRecord,
  getMessageRecordByOriginal,
  resetUnreadCount,
  setUnreadCount,
  storeMessage,
  storeMessageRecord,
  // Command Bus operations
  pinMessage,
  unpinMessage,
  deleteMessageFromDB,
  addMessageReaction,
  removeMessageReaction,
  updateChatMuteStatus,
  updateChatArchiveStatus,
  updateChatPinStatus,
  updateChatDescription,
  updateChatMetadata,
  getChatMetadata,
  deleteChatMessages,
  deleteChatMetadata,
  deleteChatAttachments,
  updateMessageContent,
  updateMessageReply,
  removeParticipantFromChat,
  updateChatParticipants,
  type ChatMetadata,
  // Folder operations
  storeFolder,
  getFolder,
  deleteFolder,
  addChatToFolder,
  removeChatFromFolder,
} from '@/lib/messages/db';
import type { PreKeyBundle } from '@/lib/signal/types';
import { fileLogger } from '@/lib/utils/file-logger';
import { queryKeys } from '@/queries';
import { MESSAGE_STORES } from '@/lib/messages/db';
import { chatService } from '@/services/chat';
import { useUnreadStore } from '@/stores';
import { toast } from '@/stores/toast-store';
import type { Attachment, Chat, Message, User } from '@/types';
import type {
  GroupMessagePayload,
  InternalWSChatMessage,
  MessageRetryPayload,
  SessionSyncPayload,
} from '@/types/chat';
import type { FolderRecord, StoredMessage } from '@/lib/messages/db';

import { getCommandBus } from '@/lib/command-bus';
import { resolveDisplayName } from '@/lib/contacts/contacts-utils';
import { userCacheService } from '@/services/user-cache';
  
  const MAX_DECRYPTION_FAILURES = 3;

 const MESSAGE_RECORD_EXPIRY_DAYS = 7;

 // ==================== Storage Keys ====================
 const SYSTEM_CHAT_STORAGE_KEY = 'system-chat';
 const SYSTEM_CHAT_ID_KEY = 'system-chat-id';

interface UseChatWebSocketOptions {
  user: { id: string; username: string } | null;
  signal: SignalContextType;
  ws: WebSocketContextType;
  setChats: React.Dispatch<React.SetStateAction<Chat[]>>;
  activeChatRef: React.MutableRefObject<Chat | null>;
  onNewMessage?: (message: Message) => void;
  handleGroupMessage?: (payload: GroupMessagePayload) => Promise<boolean>;
  chats?: Chat[]; // For group message sender resolution
}

 export function useChatWebSocket({
  user,
  signal,
  ws,
  setChats,
  activeChatRef,
  onNewMessage,
  handleGroupMessage,
  chats,
}: UseChatWebSocketOptions) {
  const queryClient = useQueryClient();
    const pendingDecryptRef = useRef<Map<string, InternalWSChatMessage>>(new Map());
    const decryptionFailuresRef = useRef<Map<string, number>>(new Map());
    const signalReadyRef = useRef<boolean>(signal.isInitialized);
    const messageQueueRef = useRef<InternalWSChatMessage[]>([]);
    const favoritesQueueRef = useRef<Parameters<typeof handleFavoritesMessage>[0][]>([]);
    const groupMessageQueueRef = useRef<GroupMessagePayload[]>([]);
    const isProcessingQueueRef = useRef<boolean>(false);
    const isProcessingFavoritesRef = useRef<boolean>(false);
    const isProcessingGroupRef = useRef<boolean>(false);

    // U8: markRead batching — instead of sending one WS message per incoming
    // chat message, coalesce them within a 300ms window into a single
    // sendMarkRead(chatId, [...messageIds]) call. Drastically reduces WS
    // traffic when many messages arrive in a burst (history sync, large
    // group, etc.) without affecting delivery semantics — the server still
    // receives every messageId, just in fewer packets.
    const markReadQueueRef = useRef<Map<string, Set<string>>>(new Map());
    const markReadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const MARK_READ_DEBOUNCE_MS = 300;

    const scheduleMarkRead = useCallback(
      (chatId: string, messageId: string): void => {
        let chatSet = markReadQueueRef.current.get(chatId);
        if (!chatSet) {
          chatSet = new Set<string>();
          markReadQueueRef.current.set(chatId, chatSet);
        }
        chatSet.add(messageId);

        if (markReadTimerRef.current) {
          clearTimeout(markReadTimerRef.current);
        }
        markReadTimerRef.current = setTimeout(() => {
          markReadTimerRef.current = null;
          if (!ws.isConnected) return;
          for (const [cid, msgIds] of markReadQueueRef.current) {
            if (msgIds.size > 0) {
              ws.sendMarkRead(cid, Array.from(msgIds));
              msgIds.clear();
            }
          }
        }, MARK_READ_DEBOUNCE_MS);
      },
      [ws],
    );

    // Handle incoming message
    const handleIncomingMessage = useCallback(async (msg: InternalWSChatMessage): Promise<void> => {
      const { chatId, content, senderId, senderUsername, senderDeviceId, timestamp, messageId, messageType, replyTo, replyToOriginalSenderId, unreadCount, isSelfDelivery, isSystem } = msg.payload;
      
      // Extract replyTo from metadata if not in payload (backward compatibility)
       // Normalize replyTo - handle both string and object cases
       let normalizedReplyTo: string | undefined;
       if (replyTo) {
         if (typeof replyTo === 'string') {
           normalizedReplyTo = replyTo;
         } else if (typeof replyTo === 'object' && replyTo !== null && 'id' in replyTo) {
           // If replyTo is an object with an id property, extract it
           normalizedReplyTo = (replyTo as { id: string }).id;
         }
       }
       // Also check metadata.replyTo if normalizedReplyTo is still undefined
       if (!normalizedReplyTo && msg.payload.metadata?.replyTo) {
         const metaReplyTo = msg.payload.metadata.replyTo;
         if (typeof metaReplyTo === 'string') {
           normalizedReplyTo = metaReplyTo;
         } else if (typeof metaReplyTo === 'object' && metaReplyTo !== null && 'id' in metaReplyTo) {
           normalizedReplyTo = (metaReplyTo as { id: string }).id;
         }
       }

       // Extract replyToOriginalSenderId from metadata if not in payload
       const replyToOriginalSenderIdFromMetadata = replyToOriginalSenderId || (msg.payload.metadata?.replyTo?.originalSenderId as string | undefined);

      // Determine if this is a system message (check both flag and type)
      const isSystemMessage = isSystem || msg.payload.type === 'SYSTEM';
       
      // DEBUG: Log system message detection (DISABLED)
      // if (isSystemMessage) {
      //   console.log('[useChatWebSocket] Detected SYSTEM message:', {
      //     messageId,
      //     chatId,
      //     isSystem,
      //     payloadType: msg.payload.type,
      //     content: content,
      //     contentLength: content?.length
      //   });
      // }

      // Save system chat ID for quick access (even if already exists, overwrite to ensure it's set)
      if (isSystemMessage) {
        try {
          localStorage.setItem(SYSTEM_CHAT_ID_KEY, chatId);
        } catch (e) {
          console.error('[useChatWebSocket] Failed to save system chat ID:', e);
        }
      }

     if (!user) return;

      // CRITICAL FIX: Check if Signal is initialized (wasm ready)
      // Shared Worker messages can arrive before Signal is ready in a new tab
      if (!signal.isInitialized) {
        // console.warn('[useChatWebSocket] Signal not initialized, queuing message:', messageId);
        messageQueueRef.current.push(msg);
        return;
      }

        // Log incoming WebSocket message (DISABLED - too noisy)
        // fileLogger.logWebSocketMessageReceived(
        //   messageType === 3 || messageType === 2 ? 'encrypted_message' : 'text_message',
        //   chatId,
        //   senderId,
        //   0 // attachment count unknown at this stage
        // );

    try {
      let decryptedContent: string;
      let extractedAttachments: Attachment[] | undefined;
      const decryptStartTime = Date.now();

      if (messageType === 3 || messageType === 2) {
        try {
          const ciphertext = base64ToArrayBuffer(content);
          const deviceId = senderDeviceId ? parseInt(senderDeviceId, 10) : 1;
          
          const ciphertextSize = ciphertext.byteLength;
          fileLogger.logDecryptionStart(messageId, `msg-${messageId}`, ciphertextSize, senderId);
          
          decryptedContent = await signal.decrypt(senderId, deviceId, ciphertext, messageType);
          
          const decryptDuration = Date.now() - decryptStartTime;
          fileLogger.logDecryptionComplete(messageId, `msg-${messageId}`, decryptedContent.length, decryptDuration);

           // Parse attachments from decrypted content if present
           try {
             const parsed = JSON.parse(decryptedContent);
             if (parsed.attachments && Array.isArray(parsed.attachments)) {
               extractedAttachments = (parsed.attachments as unknown[]).map((att): Attachment => {
                 const a = att as {
                   id: string;
                   type: 'image' | 'video' | 'audio' | 'file';
                   fileName?: string;
                   size: number;
                   mimeType: string;
                   data: string;
                   contentHash?: string;
                 };
                 return {
                   id: a.id,
                   type: a.type,
                   fileName: a.fileName || 'unnamed',
                   size: a.size,
                   mimeType: a.mimeType,
                   data: a.data, // Base64 data (encrypted in transit, now decrypted)
                   contentHash: a.contentHash || a.id, // Use contentHash from attachment, fallback to id
                 };
               });
                // Log attachment count and total size (DISABLED)
                // const totalSize = (parsed.attachments as unknown[]).reduce((sum: number, att) => {
                //   const a = att as { size?: number };
                //   return sum + (a.size || 0);
                // }, 0);
                // console.log(`[useChatWebSocket] Decrypted ${extractedAttachments?.length} attachments, total size: ${totalSize} bytes`);
                // For messages with attachments, use the text field (or empty if missing)
               if (typeof parsed === 'object' && parsed !== null && 'text' in parsed) {
                 decryptedContent = (parsed as { text?: string }).text ?? '';
               } else {
                 decryptedContent = '';
               }
             }
             // If no attachments, decryptedContent remains the original decrypted string (no change)
           } catch {
             // Not JSON, decryptedContent remains the original decrypted string (no change)
           }
          
          // Reset decryption failure counter on successful decrypt
          const failKey = `${senderId}:${deviceId}`;
          if (decryptionFailuresRef.current.has(failKey)) {
            decryptionFailuresRef.current.delete(failKey);
          }
        } catch (decryptError) {
          console.warn('[useChatWebSocket] Decryption failed:', decryptError);

          const failedDeviceId = senderDeviceId ? parseInt(senderDeviceId, 10) : 1;
          const failKey = `${senderId}:${failedDeviceId}`;
          const failures = (decryptionFailuresRef.current.get(failKey) ?? 0) + 1;
          decryptionFailuresRef.current.set(failKey, failures);

          if (failures >= MAX_DECRYPTION_FAILURES) {
            decryptionFailuresRef.current.delete(failKey);
            signal.archiveSession(senderId, failedDeviceId).catch(() => { /* ignore */ });
            ws.sendMessageRetryRequest(messageId, chatId, senderId, failedDeviceId);
          }

          decryptedContent = `[Ошибка дешифрования: сообщение от ${senderId}]`;
          pendingDecryptRef.current.set(messageId, msg);
        }
      } else {
        decryptedContent = content;
        // For non-encrypted messages, check payload.attachments (legacy)
           extractedAttachments = msg.payload.attachments?.map(att => ({
             id: att.id,
             type: att.type,
             fileName: att.fileName || 'unnamed',
             size: att.size,
             mimeType: att.mimeType,
             data: att.data,
             contentHash: att.id, // Use id as contentHash for legacy attachments
           }));
      }

      // Use extracted attachments from decrypted content, or fallback to payload.attachments
       const storageAttachments: Attachment[] | undefined = extractedAttachments || (msg.payload.attachments ? msg.payload.attachments.map(att => ({
         id: att.id,
         type: att.type,
         fileName: att.fileName || 'unnamed',
         size: att.size,
         mimeType: att.mimeType,
         data: att.data,
         contentHash: att.id, // Use id as contentHash for legacy attachments
       })) : undefined);
      
        // DEBUG: Log attachments to verify data is present (DISABLED)
        // console.log('[useChatWebSocket] storageAttachments:', JSON.stringify(storageAttachments?.map(a => ({
        //   id: a.id,
        //   type: a.type,
        //   fileName: a.fileName,
        //   hasData: !!a.data,
        //   dataLength: a.data?.length,
        //   mimeType: a.mimeType,
        //   size: a.size,
        //   contentHash: a.contentHash
        // })), null, 2));

        // DEBUG: Log incoming message before creating Message object (DISABLED)
        // console.log('[useChatWebSocket] Processing message:', {
        //   messageId: messageId,
        //   chatId: chatId,
        //   senderId: senderId,
        //   payloadType: msg.payload.type,
        //   payloadReplyTo: msg.payload.replyTo,
        //   payloadMetadata: msg.payload.metadata,
        //   isSystem: isSystem,
        // });

        // Determine message type
        let messageTypeStr: 'TEXT' | 'IMAGE' | 'FILE' | 'AUDIO' | 'VIDEO' | 'SYSTEM' = 'TEXT';
        if (isSystem || msg.payload.type === 'SYSTEM') {
          messageTypeStr = 'SYSTEM';
        } else if (storageAttachments && storageAttachments.length > 0) {
          // Use type from first attachment or from payload.type
          const attachmentType = storageAttachments[0]!.type;
          if (attachmentType === 'image') messageTypeStr = 'IMAGE';
          else if (attachmentType === 'video') messageTypeStr = 'VIDEO';
          else if (attachmentType === 'audio') messageTypeStr = 'AUDIO';
          else if (attachmentType === 'file') messageTypeStr = 'FILE';
        } else if (msg.payload.type) {
          // Use payload type if provided
          messageTypeStr = msg.payload.type as 'TEXT' | 'IMAGE' | 'FILE' | 'AUDIO' | 'VIDEO' | 'SYSTEM';
        }

         const newMessage: Message = {
           id: messageId || crypto.randomUUID(),
           chatId,
          senderId,
          content: decryptedContent,
          type: messageTypeStr,
          status: 'DELIVERED',
          createdAt: new Date(timestamp || Date.now()).toISOString(),
          // Use normalized replyTo
          replyTo: normalizedReplyTo,
          replyToOriginalSenderId: replyToOriginalSenderIdFromMetadata,
          metadata: msg.payload.metadata,
          attachments: storageAttachments,
        };

         // DEBUG: Log message creation (DISABLED - too noisy)
         // console.log('[useChatWebSocket] Created message:', {
         //   id: newMessage.id,
         //   type: newMessage.type,
         //   content: newMessage.content,
         //   contentLength: newMessage.content?.length,
         //   isSystem: isSystemMessage,
         //   chatId: newMessage.chatId,
         //   replyTo: newMessage.replyTo,
         //   replyToOriginalSenderId: newMessage.replyToOriginalSenderId,
         //   senderId: newMessage.senderId,
         //   isOwn: senderId === user?.id,
         //   // Debug: what came from decryption
         //   msgReplyTo: replyTo,
         //   metadataReplyTo: msg.payload.metadata?.replyTo,
         // });

         // Save to IndexedDB
         
         await storeMessage({
           id: newMessage.id,
           chatId,
           senderId,
           senderUsername,
           senderDeviceId: parseInt(senderDeviceId, 10) || 0,
           content: decryptedContent,
           timestamp: timestamp || Date.now(),
           createdAt: Date.now(),
           messageType,
           isOutgoing: false,
           status: 'delivered',
           type: newMessage.type,
           replyTo: normalizedReplyTo,
           replyToOriginalSenderId: replyToOriginalSenderIdFromMetadata,
           metadata: msg.payload.metadata,
           attachments: storageAttachments,
           isPinned: false,
          editedAt: 0,
        });

        // Cache the message sender (skips forwarded messages automatically)
        try {
          await userCacheService.cacheSender(
            senderId,
            senderUsername || senderId,
            chatId,
            undefined,
            msg.payload.metadata
          );
        } catch (error) {
          console.error('[useChatWebSocket] Failed to cache message sender:', error);
        }

      void queryClient.invalidateQueries({
        queryKey: queryKeys.messages.chat(chatId),
      });
      
       // Invalidate chats cache to refresh sidebar
       void queryClient.invalidateQueries({
         queryKey: queryKeys.chats.lists(),
       });

       // Update unread count
       const isSelfDeliveryMessage = isSelfDelivery !== undefined ? isSelfDelivery : senderId === user?.id;
       const isInActiveChat = activeChatRef.current?.id === chatId;
       const systemChatId = localStorage.getItem(SYSTEM_CHAT_ID_KEY);
       const isSystemChat = chatId === systemChatId;
       
       let newUnreadCount: number;
       if (isSystemMessage) {
         // System chat: always increment when not active, reset when active
         if (isInActiveChat) {
           newUnreadCount = 0;
           await resetUnreadCount(chatId);
         } else {
           // Increment unread count for system notifications
           const currentCount = useUnreadStore.getState().getUnreadCount(chatId);
           newUnreadCount = currentCount + 1;
           await setUnreadCount(chatId, newUnreadCount);
         }
       } else if (isSelfDeliveryMessage) {
         if (isSystemChat) {
           // For system chat, self-delivery (e.g., verification code) should not affect unread count
           newUnreadCount = useUnreadStore.getState().getUnreadCount(chatId) ?? 0;
           // Do not call resetUnreadCount; we'll sync with store later
         } else {
           newUnreadCount = 0;
           await resetUnreadCount(chatId);
         }
       } else if (isInActiveChat) {
         newUnreadCount = 0;
         await resetUnreadCount(chatId);
       } else if (unreadCount !== undefined) {
         newUnreadCount = unreadCount;
         await setUnreadCount(chatId, unreadCount);
       } else {
         const currentCount = useUnreadStore.getState().getUnreadCount(chatId);
         newUnreadCount = currentCount > 0 ? currentCount : 1;
         await setUnreadCount(chatId, newUnreadCount);
       }

        // Also update Zustand store for unread counts (separate from chats array)
        // This allows ChatList to subscribe to unreadCount changes without re-rendering on every message
        useUnreadStore.getState().setUnreadCount(chatId, newUnreadCount);

       // Resolve display name for new chat (if needed)
       // Always resolve sender's name with isForwarded=false because senderId is the person
       // who sent this message to the chat (the forwarder), not the original author.
       const displayName = await resolveDisplayName(senderId, chatId, false);

      // Update chats list
      setChats(prev => {
        const chatExists = prev.some(c => c.id === chatId);

        if (!chatExists) {
          const parsedDeviceId = parseInt(senderDeviceId, 10);
          const newChat: Chat = {
            id: chatId,
            type: isSystemMessage ? 'system' : 'private',
            isSystem: isSystemMessage,
            participants: isSystemMessage ? [] : [
              { 
                id: senderId, 
                username: displayName, 
                displayName: displayName,
                deviceId: !isNaN(parsedDeviceId) ? parsedDeviceId : undefined 
              },
              { 
                id: user?.id || '', 
                username: user?.username || '', 
                displayName: user?.username || '' 
              },
            ],
            lastMessage: {
              id: messageId,
              content: decryptedContent.slice(0, 50),
              senderId,
              type: messageTypeStr,
              attachments: storageAttachments,
              createdAt: new Date(timestamp || Date.now()).toISOString(),
            },
            unreadCount: newUnreadCount,  // Use value from backend
            createdAt: new Date(timestamp || Date.now()).toISOString(),
            updatedAt: new Date(timestamp || Date.now()).toISOString(),
          };
          
            // Save system chat to localStorage for persistence across page reloads
            if (isSystemMessage) {
              try {
                localStorage.setItem(SYSTEM_CHAT_STORAGE_KEY, JSON.stringify(newChat));
                // Also ensure system-chat-id is set (may already be from above)
                localStorage.setItem(SYSTEM_CHAT_ID_KEY, chatId);
              } catch (e) {
                console.error('[useChatWebSocket] Failed to save system chat to localStorage:', e);
              }
            }
            
            return [newChat, ...prev];
        } else {
          return prev.map(chat => {
            if (chat.id !== chatId) return chat;

            if (isInActiveChat && ws.isConnected) {
              // U8: batch markRead into a 300ms debounced WS send instead of
              // firing one sendMarkRead per incoming message.
              scheduleMarkRead(chatId, messageId);
            }

            const updatedChat: Chat = {
              ...chat,
              lastMessage: {
                id: messageId,
                content: decryptedContent.slice(0, 50),
                senderId,
                type: messageTypeStr,
                attachments: storageAttachments,
                createdAt: new Date(timestamp || Date.now()).toISOString(),
              },
              updatedAt: new Date(timestamp || Date.now()).toISOString(),
              unreadCount: newUnreadCount,
            };

            // Save updated system chat to localStorage
            if (isSystemMessage) {
              try {
                localStorage.setItem(SYSTEM_CHAT_STORAGE_KEY, JSON.stringify(updatedChat));
                localStorage.setItem(SYSTEM_CHAT_ID_KEY, chatId);
              } catch (e) {
                console.error('[useChatWebSocket] Failed to save system chat to localStorage:', e);
              }
            }

            return updatedChat;
          });
        }
      });

      onNewMessage?.(newMessage);
    } catch (error) {
      console.error('[useChatWebSocket] Failed to process message:', error);
    }
  }, [user, signal, ws, activeChatRef, setChats, onNewMessage, queryClient, scheduleMarkRead]);

   // Handle read events
   const handleReadEvent = useCallback((payload: { chatId: string }) => {
     // console.log("[handleReadEvent] chatId:", payload.chatId);
     void queryClient.invalidateQueries({
       queryKey: queryKeys.messages.chat(payload.chatId),
     });
   }, [queryClient]);

   // Handle read_ack
   const handleReadAck = useCallback(async (payload: { chatId: string; unreadCount?: number }) => {
     // console.log("[handleReadAck] chatId:", payload.chatId, "unreadCount:", payload.unreadCount);
     // console.log("[handleReadAck] Received payload:", payload);
     
     // Use unreadCount from backend (should be 0 after reading)
     const newUnreadCount = payload.unreadCount ?? 0;
     setChats(prev => {
       const chatToUpdate = prev.find(c => c.id === payload.chatId);
       // console.log("[handleReadAck] setChats: looking for chatId=", payload.chatId, "found:", !!chatToUpdate, "currentUnreadCount:", chatToUpdate?.unreadCount, "totalChats:", prev.length);
       const updated = prev.map(chat =>
         chat.id === payload.chatId ? { ...chat, unreadCount: newUnreadCount } : chat
       );
       // console.log("[handleReadAck] setChats: after update, chats count:", updated.length);
       return updated;
     });
     // Also update Zustand store for unread counts
     // console.log("[handleReadAck] Updating Zustand store: chatId=", payload.chatId, "count=", newUnreadCount);
     useUnreadStore.getState().setUnreadCount(payload.chatId, newUnreadCount);
     await setUnreadCount(payload.chatId, newUnreadCount);
   }, [setChats]);

  // Handle presence updates
  const handlePresence = useCallback((data: { userId: string; status: string; lastSeen?: string } | undefined | null) => {
    if (!data?.userId) {
      console.warn('[useChatWebSocket] Received invalid presence data:', data);
      return;
    }
    setChats(prev => {
      let hasChanges = false;
      const updatedChats = prev.map(chat => {
        const participantIndex = chat.participants.findIndex(p => p.id === data.userId);
        if (participantIndex === -1 || !chat.participants[participantIndex]) return chat;

        const participant = chat.participants[participantIndex];
        // Check if status or lastSeen actually changed
        if (participant.status === data.status && participant.lastSeen === data.lastSeen) {
          return chat;
        }

        hasChanges = true;
        const updatedParticipants = [...chat.participants];
        updatedParticipants[participantIndex] = {
          ...updatedParticipants[participantIndex],
          status: data.status,
          lastSeen: data.lastSeen,
        } as User;

        return { ...chat, participants: updatedParticipants };
      });
      
      return hasChanges ? updatedChats : prev;
    });
  }, [setChats]);

   // Handle session sync
   const handleSessionSync = useCallback(async (data: SessionSyncPayload) => {
     if (data.reason !== 'retry_request') return;

     // CRITICAL FIX: Check if Signal is initialized (wasm ready)
     if (!signal.isInitialized) {
       console.warn('[useChatWebSocket] Signal not initialized, dropping session sync request');
       return;
     }

      try {
       await signal.archiveSession(data.userId, data.deviceId);
       const bundle = await chatService.getPreKeyBundle(data.userId, String(data.deviceId));
       const preKeyBundle = apiBundleToPreKeyBundle({ ...bundle, identityKeyPub: bundle.identityKeyPub });

       await signal.processPreKeyBundle(data.userId, data.deviceId, preKeyBundle);
       establishedSessions.add(`${data.userId}.${data.deviceId}`);
     } catch (e) {
      console.warn('[useChatWebSocket] Failed to re-establish session:', e);
    }
  }, [signal]);

    // Handle message retry request
    const handleMessageRetry = useCallback(async (data: MessageRetryPayload) => {
      if (!user) return;

      // CRITICAL FIX: Check if Signal is initialized (wasm ready)
      if (!signal.isInitialized) {
        console.warn('[useChatWebSocket] Signal not initialized, dropping message retry request');
        return;
      }

      try {
       const record = await getMessageRecordByOriginal(data.originalMessageId, data.senderId, data.senderDeviceId);
       if (!record) {
         console.warn('[useChatWebSocket] MessageRecord not found for retry:', data.originalMessageId);
         return;
       }

       await signal.archiveSession(data.senderId, data.senderDeviceId);

       const bundle = await chatService.getPreKeyBundle(data.senderId, String(data.senderDeviceId));
       const preKeyBundle = apiBundleToPreKeyBundle({ ...bundle, identityKeyPub: bundle.identityKeyPub });

       await signal.processPreKeyBundle(data.senderId, data.senderDeviceId, preKeyBundle);
       establishedSessions.add(`${data.senderId}.${data.senderDeviceId}`);

       const encrypted = await signal.encrypt(data.senderId, data.senderDeviceId, record.plaintext);
       const encryptedBase64 = arrayBufferToBase64(encrypted.body);

       void ws.sendMultiDeviceMessage(
         record.chatId,
         data.senderId,
         [{ deviceId: data.senderDeviceId, content: encryptedBase64, messageType: encrypted.type }],
         undefined
       );

       const recordId = `${data.originalMessageId}-${data.senderDeviceId}`;
       await deleteMessageRecord(recordId);

       const newRecordId = `${Date.now()}-${data.senderDeviceId}`;
       await storeMessageRecord({
         id: newRecordId,
         originalMessageId: data.originalMessageId,
         recipientId: data.senderId,
         recipientDeviceId: data.senderDeviceId,
         plaintext: record.plaintext,
         chatId: record.chatId,
         createdAt: Date.now(),
         expiresAt: Date.now() + MESSAGE_RECORD_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
       });
     } catch (e) {
       console.warn('[useChatWebSocket] Failed to handle message_retry:', e);
     }
   }, [user, signal, ws]);

          // Handle command_event from Command Bus
      const handleCommandEvent = useCallback(async (data: Record<string, unknown>) => {
        try {
          
          const event = data as {
            commandId?: string;
            commandType?: string;
            payload?: Record<string, unknown>;
            metadata?: { encrypted?: boolean };
            issuer?: { userId: string; deviceId: number };
            result?: unknown;
          };

         const { commandType, payload, metadata, issuer, result } = event;

          if (!commandType || !payload) {
            console.warn('[useChatWebSocket] Invalid command_event:', event);
            return;
          }

          // CRITICAL FIX: Check if Signal is initialized (wasm ready) for commands that need encryption/decryption
          // Some commands (like command.retry) require Signal operations
          const commandsRequiringSignal = ['command.retry', 'command.decrypt'];
          if (commandsRequiringSignal.some(cmd => commandType.startsWith(cmd)) && !signal.isInitialized) {
            console.warn('[useChatWebSocket] Signal not initialized, dropping command_event:', commandType);
            return;
          }

         // Decrypt if encrypted
        let processedPayload = payload;

        // Check for Signal-encrypted payload (EncryptedPayload format:
        // { encryptedBase64: string, encryptionType: 'signal_pqxdh' })
        if (payload.encryptedBase64 && payload.encryptionType) {
          try {
            const commandBus = getCommandBus();
            if (commandBus) {
              // Get the sender's signal device ID from issuer metadata.
              // The issuer object in command events has { userId, deviceId }
              // where deviceId is the WS device UUID, not the Signal device ID.
              // We need to resolve it — for now, try all active sessions.
              // The decryptFn in CommandBus handles session lookup by UUID.
              const decrypted = await commandBus.decryptCommandPayload(
                payload.encryptedBase64 as string,
                issuer?.userId || '',
                issuer?.deviceId || 1,
              );
              processedPayload = decrypted;
            } else {
              console.error('[useChatWebSocket] CommandBus not available for decryption');
              return;
            }
          } catch (decryptError) {
            console.error('[useChatWebSocket] Failed to decrypt command:', decryptError);
            return;
          }
        } else if (metadata?.encrypted && payload.encrypted && payload.messageType) {
          // Legacy encryption format (pre-command-bus)
          try {
            const encryptedBase64 = payload.encrypted as string;
            const ciphertext = base64ToArrayBuffer(encryptedBase64);
            const decrypted = await signal.decrypt(
              issuer?.userId || '',
              issuer?.deviceId || 1,
              ciphertext,
              payload.messageType as number
            );
            processedPayload = JSON.parse(decrypted);
          } catch (decryptError) {
            console.error('[useChatWebSocket] Failed to decrypt legacy command:', decryptError);
            return;
          }
        }

        // Process command
        switch (commandType) {
          // ============ MESSAGE COMMANDS ============
          case 'message.delete': {
            const deletePayload = processedPayload as { messageId: string; chatId: string };
            await deleteMessageFromDB(deletePayload.messageId);
            void queryClient.invalidateQueries({ queryKey: queryKeys.messages.chat(deletePayload.chatId) });
            void queryClient.invalidateQueries({ queryKey: queryKeys.chats.lists() });
            break;
          }

          case 'message.edit': {
            const editPayload = processedPayload as { messageId: string; chatId: string; content: string; editTimestamp: number };
            await updateMessageContent(editPayload.messageId, editPayload.content, editPayload.editTimestamp);
            void queryClient.invalidateQueries({ queryKey: queryKeys.messages.chat(editPayload.chatId) });
            break;
          }

          case 'message.pin': {
            const pinPayload = processedPayload as { messageId: string; chatId: string; pinTimestamp: number };
            await pinMessage(pinPayload.messageId, pinPayload.pinTimestamp);
            void queryClient.invalidateQueries({ queryKey: queryKeys.messages.chat(pinPayload.chatId) });
            break;
          }

          case 'message.unpin': {
            const unpinPayload = processedPayload as { messageId: string; chatId: string };
            await unpinMessage(unpinPayload.messageId);
            void queryClient.invalidateQueries({ queryKey: queryKeys.messages.chat(unpinPayload.chatId) });
            break;
          }

          case 'message.react': {
            const reactPayload = processedPayload as { messageId: string; chatId: string; emoji: string; userId: string };
            // Используем userId из payload, так как команда может быть отправлена другим пользователем
            await addMessageReaction(reactPayload.messageId, reactPayload.userId, reactPayload.emoji);
            void queryClient.invalidateQueries({ queryKey: queryKeys.messages.chat(reactPayload.chatId) });
            break;
          }

          case 'message.unreact': {
            const unreactPayload = processedPayload as { messageId: string; chatId: string; emoji: string; userId: string };
            // Используем userId из payload, так как команда может быть отправлена другим пользователем
            await removeMessageReaction(unreactPayload.messageId, unreactPayload.userId, unreactPayload.emoji);
            void queryClient.invalidateQueries({ queryKey: queryKeys.messages.chat(unreactPayload.chatId) });
            break;
          }

          case 'message.reply': {
            const replyPayload = processedPayload as { messageId: string; chatId: string; replyToMessageId: string };
            await updateMessageReply(replyPayload.messageId, replyPayload.replyToMessageId);
            void queryClient.invalidateQueries({ queryKey: queryKeys.messages.chat(replyPayload.chatId) });
            break;
          }

          // ============ CHAT COMMANDS ============
          case 'chat.mute': {
            const mutePayload = processedPayload as { chatId: string; mutedUntil?: string | null };
            const mutedUntil = mutePayload.mutedUntil ? new Date(mutePayload.mutedUntil).getTime() : null;
            await updateChatMuteStatus(mutePayload.chatId, mutedUntil);
            void queryClient.invalidateQueries({ queryKey: queryKeys.chats.lists() });
            break;
          }

          case 'chat.unmute': {
            const unmutePayload = processedPayload as { chatId: string };
            await updateChatMuteStatus(unmutePayload.chatId, null);
            void queryClient.invalidateQueries({ queryKey: queryKeys.chats.lists() });
            break;
          }

          case 'chat.archive': {
            const archivePayload = processedPayload as { chatId: string };
            await updateChatArchiveStatus(archivePayload.chatId, true);
            void queryClient.invalidateQueries({ queryKey: queryKeys.chats.lists() });
            break;
          }

          case 'chat.unarchive': {
            const unarchivePayload = processedPayload as { chatId: string };
            await updateChatArchiveStatus(unarchivePayload.chatId, false);
            void queryClient.invalidateQueries({ queryKey: queryKeys.chats.lists() });
            break;
          }

          case 'chat.pin': {
            const chatPinPayload = processedPayload as { chatId: string };
            await updateChatPinStatus(chatPinPayload.chatId, true);
            void queryClient.invalidateQueries({ queryKey: queryKeys.chats.lists() });
            break;
          }

          case 'chat.unpin': {
            const chatUnpinPayload = processedPayload as { chatId: string };
            await updateChatPinStatus(chatUnpinPayload.chatId, false);
            void queryClient.invalidateQueries({ queryKey: queryKeys.chats.lists() });
            break;
          }

          case 'chat.delete': {
            const deleteChatPayload = processedPayload as { chatId: string };
            // Delete attachments first (before messages)
            await deleteChatAttachments(deleteChatPayload.chatId);
            // Delete all messages
            await deleteChatMessages(deleteChatPayload.chatId);
            // Delete chat metadata
            await deleteChatMetadata(deleteChatPayload.chatId);
            // Remove chat from list
            setChats(prev => prev.filter(chat => chat.id !== deleteChatPayload.chatId));
            // Clear active chat if the deleted chat was open
            if (activeChatRef.current?.id === deleteChatPayload.chatId) {
              activeChatRef.current = null;
            }
            void queryClient.invalidateQueries({ queryKey: queryKeys.chats.lists() });
            void queryClient.invalidateQueries({ queryKey: queryKeys.messages.all });
            break;
          }

          case 'chat.leave': {
            const leaveChatPayload = processedPayload as { chatId: string };
            // Remove chat from list (user left the chat)
            setChats(prev => prev.filter(chat => chat.id !== leaveChatPayload.chatId));
            // Clear active chat if the left chat was open
            if (activeChatRef.current?.id === leaveChatPayload.chatId) {
              activeChatRef.current = null;
            }
            void queryClient.invalidateQueries({ queryKey: queryKeys.chats.lists() });
            break;
          }

          case 'chat.update': {
            const updateChatPayload = processedPayload as { chatId: string; updates: Record<string, unknown> };

            // Update Chat in store for name/avatar changes
            const chatFields: Partial<Chat> = {};
            if ('name' in updateChatPayload.updates) chatFields.name = updateChatPayload.updates.name as string;
            if ('avatar' in updateChatPayload.updates) chatFields.avatar = updateChatPayload.updates.avatar as string;

            if (Object.keys(chatFields).length > 0) {
              setChats(prev => prev.map(chat =>
                chat.id === updateChatPayload.chatId ? { ...chat, ...chatFields } : chat
              ));
            }

            // Update ChatMetadata for command bus fields
            const metadataUpdates: Partial<ChatMetadata> = {};
            if ('description' in updateChatPayload.updates) metadataUpdates.description = updateChatPayload.updates.description as string | null;
            if ('isMuted' in updateChatPayload.updates) metadataUpdates.isMuted = updateChatPayload.updates.isMuted as boolean;
            if ('mutedUntil' in updateChatPayload.updates) {
              const mutedUntil = updateChatPayload.updates.mutedUntil as string | null;
              metadataUpdates.mutedUntil = mutedUntil ? new Date(mutedUntil).getTime() : null;
            }
            if ('isPinned' in updateChatPayload.updates) metadataUpdates.isPinned = updateChatPayload.updates.isPinned as boolean;
            if ('isArchived' in updateChatPayload.updates) metadataUpdates.isArchived = updateChatPayload.updates.isArchived as boolean;

            if (Object.keys(metadataUpdates).length > 0) {
              // Get current metadata to provide all required fields
              const currentMetadata = await getChatMetadata(updateChatPayload.chatId);
              if (currentMetadata) {
                const updatedMetadata: ChatMetadata = {
                  ...currentMetadata,
                  ...metadataUpdates,
                  updatedAt: Date.now(),
                };
                await updateChatMetadata(updatedMetadata);
              }
            }

            void queryClient.invalidateQueries({ queryKey: queryKeys.chats.lists() });
            break;
          }

                     // ============ FOLDER COMMANDS ============
           case 'folder.create': {
             const createPayload = processedPayload as { commandId: string; name: string; color: string | null; order: number };
             const createResult = result as { folderId: string } | undefined;
             const folderId = createResult?.folderId;
             if (!folderId) {
               console.error('[useChatWebSocket] folder.create missing result.folderId', { commandId: createPayload.commandId, result });
               break;
             }
             const folder: FolderRecord = {
               id: folderId,
               userId: user!.id,
               name: createPayload.name,
               color: createPayload.color,
               order: createPayload.order,
               createdAt: Date.now(),
               updatedAt: Date.now(),
             };
             await storeFolder(folder);
             void queryClient.invalidateQueries({ queryKey: queryKeys.chats.lists() });
             break;
           }


          case 'folder.update': {
            const updatePayload = processedPayload as { folderId: string; updates: Record<string, unknown> };
            const currentFolder = await getFolder(updatePayload.folderId);
            if (!currentFolder) {
              console.warn('[useChatWebSocket] Folder not found for update:', updatePayload.folderId);
              break;
            }

            const updatedFolder: FolderRecord = {
              ...currentFolder,
              name: 'name' in updatePayload.updates ? updatePayload.updates.name as string : currentFolder.name,
              color: 'color' in updatePayload.updates ? (updatePayload.updates.color as string | null) : currentFolder.color,
              order: 'order' in updatePayload.updates ? (updatePayload.updates.order as number) : currentFolder.order,
              updatedAt: Date.now(),
            };
            await storeFolder(updatedFolder);
            void queryClient.invalidateQueries({ queryKey: queryKeys.chats.lists() });
            break;
          }

          case 'folder.delete': {
            const deletePayload = processedPayload as { folderId: string; moveChatsTo: string | null };
            await deleteFolder(deletePayload.folderId);
            // If moveChatsTo is specified, we need to move chats to another folder
            // This would be handled by separate folder.add_chat commands from server
            void queryClient.invalidateQueries({ queryKey: queryKeys.chats.lists() });
            break;
          }

          case 'folder.add_chat': {
            const addChatPayload = processedPayload as { folderId: string; chatId: string };
            await addChatToFolder(addChatPayload.folderId, addChatPayload.chatId);
            // Update chat's folderId in local state
            setChats(prev => prev.map(chat =>
              chat.id === addChatPayload.chatId ? { ...chat, folderId: addChatPayload.folderId } : chat
            ));
            void queryClient.invalidateQueries({ queryKey: queryKeys.chats.lists() });
            break;
          }

          case 'folder.remove_chat': {
            const removeChatPayload = processedPayload as { folderId: string; chatId: string };
            await removeChatFromFolder(removeChatPayload.folderId, removeChatPayload.chatId);
            // Remove chat from folder (set folderId to undefined)
            setChats(prev => prev.map(chat =>
              chat.id === removeChatPayload.chatId ? { ...chat, folderId: undefined } : chat
            ));
            void queryClient.invalidateQueries({ queryKey: queryKeys.chats.lists() });
            break;
          }

          case 'folder.reorder': {
            const reorderPayload = processedPayload as { folderId: string; newOrder: number };
            // For reorder, we need the full list of chats in the folder to update their orders
            // Since we don't have that info, we'll just invalidate the cache
            // The actual reordering should be done via a separate query to get updated folder state
            void queryClient.invalidateQueries({ queryKey: queryKeys.chats.lists() });
            break;
          }

           // ============ SYSTEM COMMANDS ============
           case 'system.clear_chat': {
             const clearPayload = processedPayload as { chatId: string };
             await deleteChatMessages(clearPayload.chatId);
             void queryClient.invalidateQueries({ queryKey: queryKeys.messages.chat(clearPayload.chatId) });
             break;
           }

           // ============ DEVICE COMMANDS ============
           // (device.verification_request is now handled globally in WebSocketContext)

                      case 'system.export_chat': {
             // Export is handled via command bus subscription in the caller
             // No local state change needed
             break;
           }


                                case 'system.report_message': {
             const reportPayload = processedPayload as { chatId: string; messageId: string; reason: string };
             // Show toast for the reporting user
             if (issuer?.userId === user?.id) {
               toast.success('Message reported', 'Thank you for helping keep the chat safe.');
             }
             break;
           }

           // F8: System messages emitted by the backend on group
           // creation + participant add. We persist a local SYSTEM
           // message into IndexedDB and invalidate the messages query
           // so the chat UI re-fetches and shows the new system line.
           //
           // The backend's `broadcastSystemEvent` (see
           // back/src/ws/handler/handlers/command-handlers.ts) sends
           // these to ALL participants (including the creator / the
           // newly-added user), so every client sees the same system
           // message — no client-side annotation needed.
           case 'system.chat_created': {
             const sysPayload = processedPayload as {
               chatId: string;
               chatType: string;
               name?: string;
               createdBy: { userId: string; username: string };
               createdAt: number;
             };
             try {
               const { addSystemMessage } = await import('@/lib/messages/db');
               const groupName = sysPayload.name || 'Без названия';
               await addSystemMessage(
                 sysPayload.chatId,
                 `Группа "${groupName}" создана`,
                 {
                   kind: 'chat_created',
                   chatType: sysPayload.chatType,
                   name: sysPayload.name,
                   createdBy: sysPayload.createdBy,
                   createdAt: sysPayload.createdAt,
                 },
               );
               void queryClient.invalidateQueries({ queryKey: queryKeys.messages.chat(sysPayload.chatId) });
             } catch (e) {
               console.warn('[useChatWebSocket] F8: failed to add system.chat_created message:', e);
             }
             break;
           }

           case 'system.participant_joined': {
             const sysPayload = processedPayload as {
               chatId: string;
               userId: string;
               username: string;
               joinedAt: number;
               inviterId?: string;
             };
             try {
               const { addSystemMessage } = await import('@/lib/messages/db');
               await addSystemMessage(
                 sysPayload.chatId,
                 `${sysPayload.username} присоединился к группе`,
                 {
                   kind: 'participant_joined',
                   userId: sysPayload.userId,
                   username: sysPayload.username,
                   joinedAt: sysPayload.joinedAt,
                   inviterId: sysPayload.inviterId,
                 },
               );
               void queryClient.invalidateQueries({ queryKey: queryKeys.messages.chat(sysPayload.chatId) });
             } catch (e) {
               console.warn('[useChatWebSocket] F8: failed to add system.participant_joined message:', e);
             }
             break;
           }



          default:
            // Unhandled command type
        }

        // Broadcast to other tabs via Broadcast Channel (if available)
        if (navigator.serviceWorker && (window as any).broadcastChannel) {
          (window as any).broadcastChannel.postMessage({
            type: 'command_event',
            command: commandType,
            payload: processedPayload,
          });
        }
      } catch (error) {
        console.error('[useChatWebSocket] Failed to handle command_event:', error);
      }
    }, [queryClient, user, signal, setChats]);

   // Handle favorites message (multi-device sync for saved messages)
   const handleFavoritesMessage = useCallback(async (data: unknown): Promise<void> => {
     const msg = data as {
       messageId?: string;
       chatId?: string;
       senderId?: string;
       senderDeviceId?: number;
       content?: string;
       messageType?: number;
       timestamp?: number;
       replyTo?: string;
       isFavorites?: boolean;
       isSelfDelivery?: boolean;
       attachments?: Array<{
         id: string;
         type: 'image' | 'video' | 'audio' | 'file';
         fileName?: string;
         size: number;
         mimeType: string;
         data: string;
         contentHash?: string;
       }>;
     };

     if (!user) {
       return;
     }

     if (!msg.messageId || !msg.chatId || !msg.senderId) {
       console.warn('[useChatWebSocket] Invalid favorites message structure:', msg);
       return;
     }

     // CRITICAL FIX: Check if Signal is initialized (wasm ready)
     if (!signal.isInitialized) {
       console.warn('[useChatWebSocket] Signal not initialized, queuing favorites message:', msg.messageId);
       favoritesQueueRef.current.push(msg);
       return;
     }

    try {
      let decryptedContent: string;
      let extractedAttachments: Attachment[] | undefined;

      // If encrypted content is provided (from another device), decrypt it
      if (msg.messageType && (msg.messageType === 2 || msg.messageType === 3) && msg.senderDeviceId && msg.content) {
        try {
          const ciphertext = base64ToArrayBuffer(msg.content);
          const decryptStartTime = Date.now();
          decryptedContent = await signal.decrypt(
            msg.senderId,
            msg.senderDeviceId,
            ciphertext,
            msg.messageType
          );
          const decryptDuration = Date.now() - decryptStartTime;
          fileLogger.logDecryptionComplete(msg.messageId, `favorites-${msg.messageId}`, decryptedContent.length, decryptDuration);

          // Parse attachments from decrypted content if present (similar to handleIncomingMessage)
          try {
            const parsed = JSON.parse(decryptedContent);
            if (parsed.attachments && Array.isArray(parsed.attachments)) {
              extractedAttachments = (parsed.attachments as unknown[]).map((att): Attachment => {
                const a = att as {
                  id: string;
                  type: 'image' | 'video' | 'audio' | 'file';
                  fileName?: string;
                  size: number;
                  mimeType: string;
                  data: string;
                  contentHash?: string;
                };
                return {
                  id: a.id,
                  type: a.type,
                  fileName: a.fileName || 'unnamed',
                  size: a.size,
                  mimeType: a.mimeType,
                  data: a.data,
                  contentHash: a.contentHash || a.id,
                };
              });
               // Use text field if present
               if (typeof parsed === 'object' && parsed !== null && 'text' in parsed) {
                 decryptedContent = (parsed as { text?: string }).text ?? '';
               } else {
                 decryptedContent = '';
               }
              }
           } catch {
            // Not JSON, decryptedContent remains as is
          }
        } catch (decryptError) {
          console.warn('[useChatWebSocket] Failed to decrypt favorites message:', decryptError);
          // Fall back to error message
          decryptedContent = `[Ошибка дешифрования: сообщение из избранного]`;
        }
      } else {
        // Plaintext message (should not happen for cross-device favorites)
        decryptedContent = msg.content || '[Пустое сообщение]';
        // Check for attachments in payload directly (legacy)
        if (msg.attachments && Array.isArray(msg.attachments)) {
          extractedAttachments = msg.attachments.map(att => ({
            id: att.id,
            type: att.type,
            fileName: att.fileName || 'unnamed',
            size: att.size,
            mimeType: att.mimeType,
            data: att.data,
            contentHash: att.contentHash || att.id,
          }));
        }
      }

      // Determine message type based on attachments
      let messageTypeStr: 'TEXT' | 'IMAGE' | 'FILE' | 'AUDIO' | 'VIDEO' | 'SYSTEM' = 'TEXT';
      if (extractedAttachments && extractedAttachments.length > 0) {
        const attachmentType = extractedAttachments[0]!.type;
        if (attachmentType === 'image') messageTypeStr = 'IMAGE';
        else if (attachmentType === 'video') messageTypeStr = 'VIDEO';
        else if (attachmentType === 'audio') messageTypeStr = 'AUDIO';
        else if (attachmentType === 'file') messageTypeStr = 'FILE';
      }

      // Save to IndexedDB with attachments
      await storeMessage({
        id: msg.messageId!,
        chatId: msg.chatId!,
        senderId: msg.senderId!,
        senderDeviceId: msg.senderDeviceId || 0,
        content: decryptedContent,
        timestamp: msg.timestamp || Date.now(),
        createdAt: Date.now(),
        messageType: msg.messageType || 0,
        isOutgoing: msg.senderId === user.id,
        status: 'delivered',
        type: messageTypeStr,
        replyTo: msg.replyTo,
        attachments: extractedAttachments,
        isPinned: false,
        editedAt: 0,
      });

      // Update chats list in sidebar (similar to handleIncomingMessage)
      setChats(prev => {
        const chatExists = prev.some(c => c.id === msg.chatId);

        if (!chatExists) {
          // For favorites, create/update the chat entry
          const newChat: Chat = {
            id: msg.chatId!,
            type: 'favorites',
            isSystem: false,
            participants: [],
            lastMessage: {
              id: msg.messageId!,
              content: decryptedContent.slice(0, 50),
              senderId: msg.senderId!,
              type: messageTypeStr,
              attachments: extractedAttachments,
              createdAt: new Date(msg.timestamp || Date.now()).toISOString(),
            },
            unreadCount: 0, // Self-delivery, no unread
            createdAt: new Date(msg.timestamp || Date.now()).toISOString(),
            updatedAt: new Date(msg.timestamp || Date.now()).toISOString(),
          };
          return [newChat, ...prev];
        } else {
          return prev.map(chat => {
            if (chat.id !== msg.chatId) return chat;
            return {
              ...chat,
              lastMessage: {
                id: msg.messageId!,
                content: decryptedContent.slice(0, 50),
                senderId: msg.senderId!,
                type: messageTypeStr,
                attachments: extractedAttachments,
                createdAt: new Date(msg.timestamp || Date.now()).toISOString(),
              },
              updatedAt: new Date(msg.timestamp || Date.now()).toISOString(),
              unreadCount: 0, // Self-delivery, no unread
            };
          });
        }
      });

       // Invalidate queries to refresh UI
       void queryClient.invalidateQueries({
         queryKey: queryKeys.messages.chat(msg.chatId),
       });
       void queryClient.invalidateQueries({
         queryKey: queryKeys.chats.lists(),
       });
    } catch (error) {
      console.error('[useChatWebSocket] Failed to handle favorites message:', error);
    }
  }, [user, signal, queryClient, setChats, fileLogger]);

    // Subscribe to WebSocket events
    useEffect(() => {
      if (!ws.isConnected) return;

      const unsubMessage = ws.onMessage(async (data: unknown) => {
        const msg = data as InternalWSChatMessage;
        if (msg.type === 'message' && msg.payload) {
          await handleIncomingMessage(msg);
        }
      });
      
      // Subscribe to pending_messages event
      const unsubPendingMessages = ws.subscribe('pending_messages', (data) => {
        // pending_messages event received
      });

      const unsubFavoritesMessage = ws.subscribe('favorites_message', (data) => {
        void handleFavoritesMessage(data);
      });

      // Group message handler with queue support
      const unsubGroupMessage = ws.subscribe('group_message', (data) => {
        // Handle both direct mode (full WSMessage with payload) and worker mode (payload only)
        const anyData = data as any;
        const payload = anyData.payload ? anyData.payload : data;

        if (!payload) {
          console.warn('[useChatWebSocket] group_message has no payload');
          return;
        }

        if (!signal.isInitialized) {
          groupMessageQueueRef.current.push(payload);
          return;
        }

        if (handleGroupMessage) {
          void handleGroupMessage(payload);
        } else {
          console.warn('[useChatWebSocket] handleGroupMessage is not provided');
        }
      });

      const unsubReadEvent = ws.onReadEvent(handleReadEvent);
      const unsubReadAck = ws.onReadAck(handleReadAck);
      const unsubPresence = ws.onPresence(handlePresence);
      const unsubSessionSync = ws.onSessionSync(handleSessionSync);
       const unsubMessageRetry = ws.onMessageRetry(handleMessageRetry);
         const unsubCommandEvent = ws.subscribe('command_event', (data) => {
           void handleCommandEvent(data as Record<string, unknown>);
           // Forward to command bus for result-aware subscribers
           const commandBus = getCommandBus();
           commandBus?.handleCommandEvent(data as Record<string, unknown>);
         });

      // Notify backend we're ready
      void ws.send('ready', {});

      return () => {
        unsubMessage();
        unsubFavoritesMessage();
        unsubGroupMessage();
        unsubReadEvent();
        unsubReadAck();
        unsubPresence();
        unsubSessionSync();
        unsubMessageRetry();
        unsubCommandEvent();
        unsubPendingMessages();
      };
    }, [ws, ws.isConnected, handleIncomingMessage, handleFavoritesMessage, handleGroupMessage, handleReadEvent, handleReadAck, handlePresence, handleSessionSync, handleMessageRetry, handleCommandEvent, signal.isInitialized]);

    // Handle system chat update from verification code generation
    useEffect(() => {
      const handler = (event: Event) => {
        const custom = event as CustomEvent<{
          chatId: string;
          message: {
            id: string;
            chatId: string;
            senderId: string;
            senderUsername?: string;
            senderDeviceId: number;
            content: string;
            timestamp: number;
            messageType: number;
            isSystem: boolean;
          };
        }>;
        const { chatId, message } = custom.detail;
        
        // Construct InternalWSChatMessage
        const msg: InternalWSChatMessage = {
          type: 'message',
          payload: {
            chatId,
            content: message.content,
            senderId: message.senderId,
            senderUsername: message.senderUsername,
            senderDeviceId: String(message.senderDeviceId),
            timestamp: message.timestamp,
            messageId: message.id,
            messageType: message.messageType,
            isSystem: message.isSystem,
            isSelfDelivery: false,
          },
        };
        
        void handleIncomingMessage(msg);
      };
      
      window.addEventListener('system-chat-update', handler);
      return () => window.removeEventListener('system-chat-update', handler);
    }, [handleIncomingMessage]);

    // CRITICAL FIX: Process queued messages when Signal becomes ready
   useEffect(() => {
     signalReadyRef.current = signal.isInitialized;

      if (signal.isInitialized && messageQueueRef.current.length > 0 && !isProcessingQueueRef.current) {
        isProcessingQueueRef.current = true;
       const queue = [...messageQueueRef.current];
       messageQueueRef.current = [];

       // Process all queued messages sequentially
       (async () => {
         for (const msg of queue) {
           try {
             await handleIncomingMessage(msg);
           } catch (error) {
             console.error('[useChatWebSocket] Failed to process queued message:', error);
           }
         }
         isProcessingQueueRef.current = false;
       })();
     }
   }, [signal.isInitialized, handleIncomingMessage]);

    // CRITICAL FIX: Process queued favorites messages when Signal becomes ready
    useEffect(() => {
      if (signal.isInitialized && favoritesQueueRef.current.length > 0 && !isProcessingFavoritesRef.current) {
        isProcessingFavoritesRef.current = true;
        const queue = [...favoritesQueueRef.current];
        favoritesQueueRef.current = [];

        // Process all queued favorites messages sequentially
        (async () => {
          for (const msg of queue) {
            try {
              await handleFavoritesMessage(msg);
            } catch (error) {
              console.error('[useChatWebSocket] Failed to process queued favorites message:', error);
            }
          }
          isProcessingFavoritesRef.current = false;
        })();
      }
    }, [signal.isInitialized, handleFavoritesMessage]);

    // CRITICAL FIX: Process queued group messages when Signal becomes ready
    useEffect(() => {
      if (signal.isInitialized && groupMessageQueueRef.current.length > 0 && !isProcessingGroupRef.current) {
        isProcessingGroupRef.current = true;
        const queue = [...groupMessageQueueRef.current];
        groupMessageQueueRef.current = [];

        // Process all queued group messages sequentially
        (async () => {
          for (const payload of queue) {
            try {
              if (handleGroupMessage) {
                await handleGroupMessage(payload);
              } else {
                console.warn('[useChatWebSocket] handleGroupMessage is not provided, skipping queued message');
              }
            } catch (error) {
              console.error('[useChatWebSocket] Failed to process queued group message:', error, 'messageId:', payload.messageId);
            }
          }
          isProcessingGroupRef.current = false;
        })();
      }
    }, [signal.isInitialized, handleGroupMessage]);

   return {
     pendingDecryptRef,
     decryptionFailuresRef,
   };
}