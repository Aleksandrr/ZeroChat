/**
 * useFavorites - Hook for managing favorites (saved messages)
 * 
 * Features:
 * - Send favorites message with local echo
 * - Multi-device sync via WebSocket
 * - Local storage in IndexedDB
 */

import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import type { SignalContextType } from '@/contexts/SignalContext';
import type { WebSocketContextType } from '@/contexts/WebSocketContext';
import { storeMessage } from '@/lib/messages';
import { encryptMessage, getCurrentDeviceId } from '@/lib/signal';
import type { PreKeyBundle } from '@/lib/signal/types';
import { apiBundleToPreKeyBundle } from '@/lib/signal/utils/bundle-converter';
import { uint8ArrayToBase64 } from '@/lib/utils/buffer';
import { queryKeys } from '@/queries';
import { chatService } from '@/services/chat';
import type { Chat } from '@/types';

interface UseFavoritesOptions {
  user: { id: string; username: string } | null;
  signal: SignalContextType;
  ws: WebSocketContextType;
  setChats: React.Dispatch<React.SetStateAction<Chat[]>>;
}

interface EncryptedDeviceMessage {
  deviceId: number;
  content: string; // base64 encoded encrypted content
  messageType: number;
}

export function useFavorites({ user, signal, ws, setChats }: UseFavoritesOptions) {
  const queryClient = useQueryClient();

  /**
   * Fetch PreKey bundle for a device
   */
  const fetchPreKeyBundle = useCallback(async (
    userId: string,
    deviceId: number
  ): Promise<PreKeyBundle | null> => {
    try {
      const response = await chatService.getPreKeyBundle(userId, String(deviceId));
      return apiBundleToPreKeyBundle({ ...response, identityKeyPub: response.identityKeyPub });
    } catch (error) {
      console.error('[useFavorites] Failed to fetch PreKeyBundle:', error);
      return null;
    }
  }, []);

   /**
    * Send a favorites message
    * - Saves locally with local echo (no encryption needed for local storage)
    * - Encrypts for other devices via Signal Protocol
    * - Sends via WebSocket for multi-device sync
    */
     const sendFavoritesMessage = useCallback(async (
       content: string,
       activeChat: Chat | null,
       replyTo?: string,
       metadata?: Record<string, any>
     ): Promise<void> => {
      if (!user || !activeChat || activeChat.type !== 'favorites') {
        throw new Error('Invalid favorites chat');
      }

      if (!ws.isConnected) {
        throw new Error('WebSocket not connected');
      }

      const chatId = activeChat.id;
      const messageId = crypto.randomUUID(); // Generate proper UUID for message ID
      const timestamp = Date.now();
      const currentDeviceId = getCurrentDeviceId();

        // 1. LOCAL ECHO: Save message locally first (unencrypted for local storage)
        // This ensures immediate UI feedback without waiting for server
        const localMessage = {
          id: messageId, // Use the real UUID from the start
          chatId,
          senderId: user.id,
          senderUsername: user.username,
          senderDeviceId: currentDeviceId,
          content, // Store unencrypted locally
          type: 'TEXT' as const,
          messageType: 0, // Plaintext message type
          isOutgoing: true,
          status: 'sending' as const,
          createdAt: timestamp,
          timestamp,
          isPinned: false,
          editedAt: 0,
          replyTo,
          replyToOriginalSenderId: metadata?.replyTo?.originalSenderId,
          metadata,
        };

    try {
      await storeMessage(localMessage);

      // Invalidate queries to refresh UI
      queryClient.invalidateQueries({
        queryKey: queryKeys.messages.chat(chatId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.chats.lists(),
      });

       // Update lastMessage in chat list for sidebar display
       setChats(prev => prev.map(c => {
         if (c.id === chatId) {
           return {
             ...c,
             lastMessage: {
               id: messageId, // Use the real UUID
               content,
               senderId: user.id,
               chatId,
               type: 'TEXT',
               attachments: undefined,
               createdAt: new Date(timestamp).toISOString(),
               timestamp: new Date(timestamp).toISOString(),
             },
             updatedAt: new Date(timestamp).toISOString(),
           };
         }
         return c;
       }));

      // Dispatch event to scroll to bottom
      window.dispatchEvent(new CustomEvent('zerochat:message-sent'));
    } catch (error) {
      console.error('[useFavorites] Failed to save local echo:', error);
      throw error;
    }

    // 2. MULTI-DEVICE ENCRYPTION: Encrypt for other devices
    const encryptedDevices: EncryptedDeviceMessage[] = [];
    
    try {
      // Get other devices of the same user (using same method as regular messages)
      const currentDeviceId = getCurrentDeviceId();
      const allDevices = await chatService.getRecipientDevices(user.id);
      const otherDevices = allDevices.filter(d => d.deviceId !== currentDeviceId);

      // Encrypt for each device
      for (const device of otherDevices) {
        try {
          // Check if session exists, if not we need to establish it
          const hasSession = await signal.hasSession(
            user.id,
            device.deviceId
          );

          if (!hasSession) {
            // Fetch prekey bundle and establish session
            const bundle = await fetchPreKeyBundle(
              user.id,
              device.deviceId
            );
            
            if (bundle) {
              await signal.processPreKeyBundle(
                user.id,
                device.deviceId,
                bundle
              );
            }
          }

          // Encrypt message for this device
          const encrypted = await encryptMessage(
            user.id,
            device.deviceId,
            content
          );

          encryptedDevices.push({
            deviceId: device.deviceId,
            content: uint8ArrayToBase64(encrypted.body),
            messageType: encrypted.type,
          });
        } catch (error) {
          console.error(
            `[useFavorites] Failed to encrypt for device ${device.deviceId}:`
          );
          console.error(error);
        }
      }
    } catch (error) {
      console.error('[useFavorites] Failed to encrypt for devices:', error);
    }

       // 3. SEND VIA WEBSOCKET: Send to server for delivery to other devices
       try {
         await ws.send('favorites_message', {
           chatId,
           messages: encryptedDevices.length > 0 ? encryptedDevices : [],
           replyTo,
           attachments: undefined,
           messageId, // Include client-generated UUID
           metadata,
         });
       } catch (error) {
       console.error('[useFavorites] Failed to send via WebSocket:', error);
       // Update local message status to failed
       await storeMessage({
         ...localMessage,
         status: 'failed',
       });
       throw error;
     }
  }, [user, signal, ws, setChats, fetchPreKeyBundle]);

  return {
    sendFavoritesMessage,
  };
}
