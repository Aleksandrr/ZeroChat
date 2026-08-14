/**
 * useGroupChat - Hook for managing group chat functionality
 * Extracted from ChatContext.tsx
 */
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect } from 'react';

import type { SignalContextType } from '@/contexts/SignalContext';
import type { WebSocketContextType } from '@/contexts/WebSocketContext';
import { useWebSocketContext } from '@/contexts/WebSocketContext';
import * as signalLib from '@/lib/signal';
import { resetUnreadCount, setUnreadCount, storeMessage } from '@/lib/messages';
import { base64ToUint8Array, uint8ArrayToBase64 } from '@/lib/utils/buffer';
import { queryKeys } from '@/queries';
import { useUnreadStore } from '@/stores';
 import type { Attachment, Chat, Message, User, UserRole } from '@/types';
import { deleteChatMessages, deleteChatMetadata, deleteChatAttachments } from '@/lib/messages';
 import type { GroupMessagePayload, GroupSyncPayload } from '@/types/chat';

interface UseGroupChatOptions {
  signal: SignalContextType;
  setChats: React.Dispatch<React.SetStateAction<Chat[]>>;
  activeChatRef?: React.MutableRefObject<Chat | null>;
  currentUserId: string; // Add current user ID to check if sender is self
  ws: WebSocketContextType; // WebSocket context for sending mark read
  chats: Chat[]; // Chat list for resolving sender usernames
}

export function useGroupChat({ signal, setChats, activeChatRef, currentUserId, ws, chats }: UseGroupChatOptions) {
  const queryClient = useQueryClient();
  const { commandBus } = useWebSocketContext();

   // Handle group sync (Sender Key sync between own devices)
   const handleGroupSync = useCallback(async (payload: GroupSyncPayload) => {
     if (!signal.isInitialized) {
       console.warn('[useGroupChat] Signal not initialized, dropping group sync');
       return;
     }

     try {
       // Convert senderKey from base64 to Uint8Array
       const senderKeyBytes = base64ToUint8Array(payload.senderKey);
       // senderKeyId is now used as senderDeviceId
       const senderDeviceId = parseInt(payload.senderKeyId, 10) || 1;

       await signal.addSenderKey(
         payload.chatId,
         payload.senderUserId,
         senderDeviceId,
         senderKeyBytes
       );
     } catch (err) {
       console.error('[useGroupChat] Failed to import sender key:', err);
     }
   }, [signal]);

   // Handle group key update notifications
   const handleGroupKeyUpdate = useCallback(async (payload: GroupSyncPayload) => {
     if (!signal.isInitialized) {
       console.warn('[useGroupChat] Signal not initialized, dropping group key update');
       return;
     }

     try {
       // Convert senderKey from base64 to Uint8Array
       const senderKeyBytes = base64ToUint8Array(payload.senderKey);
       // senderKeyId is now used as senderDeviceId
       const senderDeviceId = parseInt(payload.senderKeyId, 10) || 1;

       await signal.addSenderKey(
         payload.chatId,
         payload.senderUserId,
         senderDeviceId,
         senderKeyBytes
       );
     } catch (err) {
       console.error('[useGroupChat] Failed to update sender key:', err);
     }
   }, [signal]);

    // Handle incoming group message (called only when Signal is ready, queue handled by useChatWebSocket)
    const handleGroupMessage = useCallback(async (payload: GroupMessagePayload): Promise<boolean> => {
      console.log('[useGroupChat] Received group message:', {
        chatId: payload.chatId,
        senderUserId: payload.senderUserId,
        messageId: payload.messageId,
        timestamp: payload.timestamp,
        hasContent: !!payload.content,
        contentLength: payload.content?.length,
        hasSenderKeyDistribution: !!payload.senderKeyDistribution,
        hasAttachments: !!payload.attachments,
        attachmentCount: payload.attachments?.length
      });

      try {
        const senderDeviceIdNum = payload.senderDeviceId ? parseInt(payload.senderDeviceId, 10) : 1;

        // Resolve senderUsername from chats if not provided
        let senderUsername = payload.senderUsername;
        if (!senderUsername && chats) {
          const chat = chats.find(c => c.id === payload.chatId);
          const sender = chat?.participants.find(p => p.id === payload.senderUserId);
          senderUsername = sender?.username || sender?.displayName;
        }
        console.log('[useGroupChat] Resolved senderUsername:', senderUsername);

       // Normalize replyTo - handle both string and object cases (same as useChatWebSocket.ts)
       let normalizedReplyTo: string | undefined;
      if (payload.replyTo) {
        if (typeof payload.replyTo === 'string') {
          normalizedReplyTo = payload.replyTo;
        } else if (typeof payload.replyTo === 'object' && payload.replyTo !== null && 'id' in payload.replyTo) {
          normalizedReplyTo = (payload.replyTo as { id: string }).id;
        }
      }
      // Also check metadata.replyTo if normalizedReplyTo is still undefined
      if (!normalizedReplyTo && payload.metadata?.replyTo) {
        const metaReplyTo = payload.metadata.replyTo;
        if (typeof metaReplyTo === 'string') {
          normalizedReplyTo = metaReplyTo;
        } else if (typeof metaReplyTo === 'object' && metaReplyTo !== null && 'id' in metaReplyTo) {
          normalizedReplyTo = (metaReplyTo as { id: string }).id;
        }
      }

      // Extract replyToOriginalSenderId from metadata (for forwarded message replies)
      const replyToOriginalSenderId = payload.metadata?.replyTo?.originalSenderId as string | undefined;

      // If the message includes a Sender Key Distribution Message (SKDM),
      // process it first so we can decrypt subsequent SenderKeyMessages
      // from this sender.
      //
      // IMPORTANT (F1 fix): use `processSenderKeyDistribution` (expects an
      // SKDM blob as produced by `createSenderKeyDistribution`), NOT
      // `addSenderKey` (which expects a raw exported SenderKey state as
      // used by the cross-device group_sync flow). Calling `addSenderKey`
      // here would import garbage into the SenderKey store and leave the
      // recipient unable to decrypt the message body that follows.
      if (payload.senderKeyDistribution) {
        try {
          const skdmBytes = base64ToUint8Array(payload.senderKeyDistribution);
          await signalLib.processSenderKeyDistribution(
            payload.chatId,
            payload.senderUserId,
            senderDeviceIdNum,
            skdmBytes
          );
        } catch {
          // Continue anyway - maybe we already have the key
        }
      }

      const ciphertext = base64ToUint8Array(payload.content);

      // Message type 4 = Sender Key message (group message)
      let decryptedContent = await signal.decryptGroupMessage(
        payload.chatId,
        payload.senderUserId,
        senderDeviceIdNum,
        ciphertext,
        4 // MessageType::SenderKey
      );
      console.log('[useGroupChat] Message decrypted, content length:', decryptedContent.length);

      // Parse attachments from decrypted content (same as useChatWebSocket.ts)
      let extractedAttachments: Attachment[] = [];
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
              contentHash: a.contentHash || a.id,
            };
          });
          // For messages with attachments, use the text field (or empty if missing)
          if (typeof parsed === 'object' && parsed !== null && 'text' in parsed) {
            decryptedContent = (parsed as { text?: string }).text ?? '';
          } else {
            decryptedContent = '';
          }
        }
      } catch {
        // Not JSON, decryptedContent remains the original decrypted string
      }

      // Determine message type based on attachments
      let messageType: Message['type'] = 'TEXT';
      if (extractedAttachments.length > 0 && extractedAttachments[0]) {
        const firstAttachmentType = extractedAttachments[0].type;
        if (firstAttachmentType === 'image') {
          messageType = 'IMAGE';
        } else if (firstAttachmentType === 'video') {
          messageType = 'VIDEO';
        } else if (firstAttachmentType === 'audio') {
          messageType = 'AUDIO';
        } else {
          messageType = 'FILE';
        }
      }

      const newMessage: Message = {
        id: payload.messageId || crypto.randomUUID(),
        chatId: payload.chatId,
        senderId: payload.senderUserId,
        senderUsername,
        content: decryptedContent,
        type: messageType,
        attachments: extractedAttachments.length > 0 ? extractedAttachments : undefined,
        status: 'DELIVERED',
        createdAt: new Date(payload.timestamp || Date.now()).toISOString(),
        replyTo: normalizedReplyTo,
        replyToOriginalSenderId,
        metadata: payload.metadata,
      };

      // Save decrypted message to IndexedDB
      await storeMessage({
        id: newMessage.id,
        chatId: payload.chatId,
        senderId: payload.senderUserId,
        senderUsername,
        senderDeviceId: senderDeviceIdNum,
        content: decryptedContent,
        timestamp: payload.timestamp || Date.now(),
        createdAt: Date.now(),
        messageType: 4, // Sender Key message
        isOutgoing: false,
        status: 'delivered',
        type: messageType,
        attachments: extractedAttachments.length > 0 ? extractedAttachments : undefined,
        isPinned: false,
        editedAt: 0,
        replyTo: normalizedReplyTo,
        replyToOriginalSenderId,
        metadata: payload.metadata,
        });
        console.log('[useGroupChat] Message stored in IndexedDB');

        // Update unread count using value from backend (source of truth)
        // Backend sends unreadCount in payload - use it directly
        const isActiveChat = activeChatRef?.current?.id === payload.chatId;
        const isSelfDelivery = payload.isSelfDelivery === true || payload.senderUserId === currentUserId;
        const messageId = payload.messageId || crypto.randomUUID();
        const messageUnreadCount = payload.unreadCount;
       
       // Determine the unreadCount to use:
       // - If self-delivery: always 0 (own message)
       // - If in active chat: reset to 0 (user seeing it immediately)
       // - Otherwise: use value from backend (backend is source of truth)
       let newUnreadCount: number;
       
       if (isSelfDelivery) {
         newUnreadCount = 0;
         await resetUnreadCount(payload.chatId);
         // Sync with Zustand store
         useUnreadStore.getState().resetUnreadCount(payload.chatId);
       } else if (isActiveChat) {
         newUnreadCount = 0;
         await resetUnreadCount(payload.chatId);
         // Sync with Zustand store
         useUnreadStore.getState().resetUnreadCount(payload.chatId);
       } else if (messageUnreadCount !== undefined) {
         // Use value from backend as source of truth
         newUnreadCount = messageUnreadCount;
         await setUnreadCount(payload.chatId, messageUnreadCount);
         // Sync with Zustand store
         useUnreadStore.getState().setUnreadCount(payload.chatId, messageUnreadCount);
       } else {
         // Fallback - shouldn't happen but just in case
         newUnreadCount = 0;
       }

      // Update chats list
      setChats(prev => {
        const chatExists = prev.some(c => c.id === payload.chatId);
        
        if (!chatExists) {
          // Create new group chat if it doesn't exist
          const newChat: Chat = {
            id: payload.chatId,
            type: 'group',
            name: 'Групповой чат', // Will be updated when chat list is refreshed
            participants: [], // Will be populated on next loadChats
            lastMessage: {
              id: payload.messageId,
              content: decryptedContent,
              senderId: payload.senderUserId,
              chatId: payload.chatId,
              type: messageType,
              attachments: extractedAttachments.length > 0 ? extractedAttachments : undefined,
              createdAt: newMessage.createdAt,
              timestamp: newMessage.createdAt,
            },
            unreadCount: newUnreadCount,
            createdAt: newMessage.createdAt,
            updatedAt: newMessage.createdAt,
          };
          
          // Trigger chat list refresh to get full group info from backend
          setTimeout(() => {
            window.dispatchEvent(new CustomEvent('zerochat:sync-complete'));
          }, 100);
          
          return [newChat, ...prev];
        }
        
        return prev.map(chat => {
          if (chat.id === payload.chatId) {
            if (isActiveChat && ws) {
              ws.sendMarkRead(payload.chatId, [messageId]);
            }
            
            return {
              ...chat,
              lastMessage: {
                id: payload.messageId,
                content: decryptedContent,
                senderId: payload.senderUserId,
                chatId: payload.chatId,
                type: messageType,
                attachments: extractedAttachments.length > 0 ? extractedAttachments : undefined,
                createdAt: newMessage.createdAt,
                timestamp: newMessage.createdAt,
              },
              updatedAt: newMessage.createdAt,
              unreadCount: newUnreadCount,
            };
          }
          return chat;
        });
      });

        // Invalidate queries to refresh messages
        void queryClient.invalidateQueries({
          queryKey: queryKeys.messages.chat(payload.chatId),
        });
        console.log('[useGroupChat] Invalidated messages queries for chat:', payload.chatId);
        
        // Invalidate chats cache to refresh sidebar
        void queryClient.invalidateQueries({
          queryKey: queryKeys.chats.lists(),
        });
        console.log('[useGroupChat] Invalidated chats list queries');

     return true;
  } catch (err) {
    console.error('[useGroupChat] Failed to decrypt group message:', err);
    return false;
  }
    }, [signal, setChats, queryClient, activeChatRef, currentUserId, ws, chats]);

  // SECURITY (P0-5): Rotate the local SenderKey for a group and broadcast
  // the new SKDM to the remaining participants via a group_message that
  // carries the SKDM as an attachment. Receivers will import the new SKDM
  // (see handleGroupMessage) before decrypting the body, so they can
  // immediately read the rotation notice and use the new chain going
  // forward.
  //
  // `reason` is included in the broadcast payload so recipients can log
  // why the rotation happened (it is NOT used for any security decision).
  const rotateAndBroadcastSenderKey = useCallback(async (
    chatId: string,
    reason: 'member_added' | 'member_removed' | 'manual',
  ): Promise<void> => {
    if (!signal.isInitialized) {
      console.warn('[useGroupChat] Signal not initialized — skipping SenderKey rotation');
      return;
    }
    if (!ws) {
      console.warn('[useGroupChat] WebSocket not available — skipping SKDM broadcast');
      return;
    }
    try {
      // Atomically archive the old SenderKey + mint a new one.
      const newSkdmBytes = await signalLib.rotateSenderKey(chatId);
      const newSkdmB64 = uint8ArrayToBase64(newSkdmBytes);

      // Encrypt a tiny rotation-notice message with the freshly-minted
      // sender key. Recipients will process the attached SKDM first
      // (handleGroupMessage imports it before decrypting), so this
      // message will decrypt cleanly under the new chain.
      const noticePayload = JSON.stringify({
        type: 'sender_key_rotation',
        reason,
        timestamp: Date.now(),
      });
      const encrypted = await signal.encryptGroupMessage(chatId, noticePayload);
      const contentB64 = uint8ArrayToBase64(encrypted.body);
      const senderDeviceId = String(signal.getDeviceId() ?? 1);
      const messageId = `skdm-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

      await ws.sendGroupMessage(
        chatId,
        currentUserId,
        senderDeviceId,
        contentB64,
        messageId,
        senderDeviceId, // senderKeyId (legacy field — re-used as device id)
        undefined, // replyTo
        undefined, // attachments
        newSkdmB64, // senderKeyDistribution — the new SKDM
        { senderKeyRotation: true, reason },
      );
    } catch (e) {
      console.error('[useGroupChat] SenderKey rotation failed:', e);
    }
  }, [signal, ws, currentUserId]);

  // Handle participant commands (add/remove/role_update)
  const handleParticipantCommand = useCallback(async (data: Record<string, unknown>) => {
    try {
      const event = data as {
        commandId?: string;
        commandType?: string;
        payload?: Record<string, unknown>;
        metadata?: { encrypted?: boolean };
        issuer?: { userId: string; deviceId: number };
      };

      const { commandType, payload } = event;
      if (!commandType || !payload) {
        console.warn('[useGroupChat] Invalid participant command:', event);
        return;
      }

      // Process participant commands
      switch (commandType) {
        case 'participant.add': {
          // Backend sends { chatId, userId, role } — NOT { chatId, user }
          const addPayload = payload as { chatId: string; userId: string; role?: string };
          setChats(prev => prev.map(chat => {
            if (chat.id !== addPayload.chatId) return chat;
            const exists = chat.participants.some(p => p.id === addPayload.userId);
            if (exists) return chat;
            const newUser: User = {
              id: addPayload.userId,
              username: '',
              displayName: '',
              status: 'offline',
            } as User;
            return {
              ...chat,
              participants: [...chat.participants, newUser],
              updatedAt: new Date().toISOString(),
            };
          }));
          void queryClient.invalidateQueries({ queryKey: queryKeys.chats.lists() });

          // SECURITY (P0-5): Rotate our SenderKey so the newly-added
          // participant cannot decrypt any historical group messages
          // (they have no SKDM yet) and receives a fresh chain going
          // forward. Other existing participants get the new SKDM via
          // the broadcast below.
          if (addPayload.userId !== currentUserId) {
            await rotateAndBroadcastSenderKey(addPayload.chatId, 'member_added');
          }
          break;
        }

        case 'participant.remove': {
          const removePayload = payload as { chatId: string; userId: string };
          // If the current user was removed, treat it like chat.leave
          if (removePayload.userId === currentUserId) {
            try {
              await deleteChatAttachments(removePayload.chatId);
              await deleteChatMessages(removePayload.chatId);
              await deleteChatMetadata(removePayload.chatId);
            } catch (e) {
              console.error('[useGroupChat] Failed to cleanup removed chat:', e);
            }
            setChats(prev => prev.filter(chat => chat.id !== removePayload.chatId));
            if (activeChatRef.current?.id === removePayload.chatId) {
              activeChatRef.current = null;
            }
          } else {
            setChats(prev => prev.map(chat => {
              if (chat.id !== removePayload.chatId) return chat;
              return {
                ...chat,
                participants: chat.participants.filter(p => p.id !== removePayload.userId),
                updatedAt: new Date().toISOString(),
              };
            }));

            // SECURITY (P0-5): Someone else was removed. Rotate our
            // SenderKey and broadcast the new SKDM to the remaining
            // participants so the removed user can no longer decrypt
            // future group messages (forward secrecy).
            await rotateAndBroadcastSenderKey(removePayload.chatId, 'member_removed');
          }
          void queryClient.invalidateQueries({ queryKey: queryKeys.chats.lists() });
          break;
        }

        case 'participant.role_update': {
          // Backend sends { chatId, userId, newRole } — NOT { role }
          const rolePayload = payload as {
            chatId: string;
            userId: string;
            newRole: string;
            issuerUserId?: string;
          };
          const issuerUserId = rolePayload.issuerUserId ?? event.issuer?.userId;
          setChats(prev => prev.map(chat => {
            if (chat.id !== rolePayload.chatId) return chat;
            const updatedParticipants = chat.participants.map(p => {
              if (p.id === rolePayload.userId) {
                return { ...p, role: rolePayload.newRole as UserRole };
              }
              // SECURITY (P0-6): On ownership transfer (newRole === 'OWNER'),
              // demote the previous owner (the command issuer) to ADMIN in
              // the local state. Without this, the UI would show two OWNERS
              // and the previous owner could keep issuing owner-only commands
              // client-side (the server enforces its own check, but we want
              // the local UI to reflect the demotion immediately).
              if (
                rolePayload.newRole === 'OWNER' &&
                issuerUserId &&
                p.id === issuerUserId &&
                p.id !== rolePayload.userId
              ) {
                return { ...p, role: 'ADMIN' as UserRole };
              }
              return p;
            });
            return {
              ...chat,
              participants: updatedParticipants,
              updatedAt: new Date().toISOString(),
            };
          }));
          void queryClient.invalidateQueries({ queryKey: queryKeys.chats.lists() });
          break;
        }
      }
    } catch (error) {
      console.error('[useGroupChat] Failed to handle participant command:', error);
    }
  }, [setChats, queryClient, currentUserId, activeChatRef, signal, ws, rotateAndBroadcastSenderKey]);

  // Subscribe to command_event for participant commands
  useEffect(() => {
    if (!ws || !commandBus) return;

    const unsubCommandEvent = ws.subscribe('command_event', (data) => {
      const event = data as Record<string, unknown>;
      const commandType = event.commandType as string | undefined;
      // Only handle participant.* commands
      if (commandType?.startsWith('participant.')) {
        void handleParticipantCommand(event);
      }
    });

    return () => {
      unsubCommandEvent();
    };
  }, [ws, commandBus, handleParticipantCommand]);

  // Public methods for participant management
  //
  // SECURITY (P0-5): On the initiator side we also rotate the SenderKey
  // immediately after sending the command. The server-side event will
  // eventually trigger `handleParticipantCommand` for everyone (including
  // us), but that handler only rotates when someone *else* is the
  // subject of the command — so we rotate explicitly here on the
  // initiator side to cover the "I added/removed someone" case.
  const addParticipant = useCallback(async (chatId: string, userId: string, role: UserRole = 'MEMBER') => {
    if (!commandBus) throw new Error('CommandBus not available');
    const commandId = `cmd-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    await commandBus.sendCommand(
      'participant.add',
      {
        commandId,
        chatId,
        userId,
        role,
      },
      { encrypt: false }
    );
    // Rotate + broadcast new SKDM to remaining participants.
    if (userId !== currentUserId) {
      await rotateAndBroadcastSenderKey(chatId, 'member_added');
    }
    // F8: the backend now emits `system.participant_joined` via
    // `broadcastSystemEvent` to all participants (including this
    // client). The system message is persisted on the receiving side
    // by `useChatWebSocket.handleCommandEvent` → no local annotation
    // needed here (the previous client-side `addSystemMessage` call
    // would have created a duplicate once the backend event arrives).
  }, [commandBus, currentUserId, rotateAndBroadcastSenderKey, queryClient]);

  const removeParticipant = useCallback(async (chatId: string, userId: string) => {
    if (!commandBus) throw new Error('CommandBus not available');
    const commandId = `cmd-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    await commandBus.sendCommand(
      'participant.remove',
      {
        commandId,
        chatId,
        userId,
      },
      { encrypt: false }
    );
    // Rotate + broadcast new SKDM to remaining participants.
    if (userId !== currentUserId) {
      await rotateAndBroadcastSenderKey(chatId, 'member_removed');
    }
    // F8: removed the local `addSystemMessage` annotation — the
    // backend doesn't currently emit a `system.participant_left`
    // event for `participant.remove` (only `participant.add` emits
    // `system.participant_joined`). If we add `system.participant_left`
    // emission in the future, the handler in `useChatWebSocket` will
    // take care of persisting it. For now, no system message is
    // shown for removals — consistent with WhatsApp's UX where
    // removals are silent (the participant just disappears from the
    // member list).
  }, [commandBus, currentUserId, rotateAndBroadcastSenderKey, queryClient]);

  const updateParticipantRole = useCallback(async (chatId: string, userId: string, role: UserRole) => {
    if (!commandBus) throw new Error('CommandBus not available');
    const commandId = `cmd-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    await commandBus.sendCommand(
      'participant.role_update',
      {
        commandId,
        chatId,
        userId,
        newRole: role,
      },
      { encrypt: false }
    );
  }, [commandBus]);

  return {
    handleGroupSync,
    handleGroupKeyUpdate,
    handleGroupMessage,
    addParticipant,
    removeParticipant,
    updateParticipantRole,
  };
}
