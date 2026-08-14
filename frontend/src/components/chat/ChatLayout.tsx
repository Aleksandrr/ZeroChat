import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';

import { useChat } from '@/contexts';
import { useIsMobile } from '@/hooks/use-mobile';
import { useChatSwipeNavigation } from '@/hooks/useChatSwipeNavigation';
import type { SendMode } from '@/lib/media';
import type { Chat, User } from '@/types';

import { ChatHeader } from './ChatHeader';
import { ChatMessages } from './ChatMessages';
import { DragDropOverlay } from './DragDropOverlay';
import { GalleryViewer } from './GalleryViewer';
import { MessageInput } from './MessageInput';
import { ForwardDialog } from './ForwardDialog';
import { ContactCard } from '@/components/contacts/ContactCard';
import { DeleteChatDialog } from './DeleteChatDialog';

interface ChatLayoutProps {
  chat: Chat;
  currentUser: User;
  /** @deprecated not used internally — ChatLayout uses useChat().sendMessage directly */
  onSendMessage?: (content: string) => void;
  onBack?: () => void;
}

export function ChatLayout({
  chat,
  currentUser,
  onBack
}: ChatLayoutProps) {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const { markAsRead, chats, sendMessage, sendFavoritesMessage, openContactCard, contactCardOpen, contactUserId, contactChatId, closeContactCard, deleteChat, selectChat } = useChat();

  // Swipe navigation between chats on mobile
  const { handlers: chatSwipeHandlers } = useChatSwipeNavigation({
    chats,
    currentChatId: chat.id,
    onSelectChat: selectChat,
  });
    
  // Track last marked chat to prevent duplicate markAsRead calls
  // This happens due to React StrictMode double-invoking effects in development
  const lastMarkedRef = useRef<{ chatId: string; unreadCount: number } | null>(null);
 
  // Drag & drop state
  const [dragState, setDragState] = useState<{
    visible: boolean;
    fileTypes: string[]; // MIME types of dragged files (from DataTransferItem.type)
  }>({ visible: false, fileTypes: [] });
 
  // Ref for debounce timeout
  const dragTimeoutRef = useRef<NodeJS.Timeout | null>(null);
 
  // Ref to MessageInput for external control
  const messageInputRef = useRef<{
    openFileDialog: (files: File[], mode: SendMode) => void;
  }>(null);
 
    // Container ref for drag detection
    const containerRef = useRef<HTMLDivElement>(null);

    // Mark messages as read when chat is opened
  useEffect(() => {
    // Only mark if there are unread messages
    if (chat.id && chat.unreadCount && chat.unreadCount > 0) {
      // Skip if we already marked this exact state (prevents double calls)
      if (lastMarkedRef.current?.chatId === chat.id &&
          lastMarkedRef.current?.unreadCount === chat.unreadCount) {
        return;
      }
      
      lastMarkedRef.current = { chatId: chat.id, unreadCount: chat.unreadCount };
      void markAsRead(chat.id);
    }
  }, [chat.id, chat.unreadCount, markAsRead]);

   // Forward dialog state
   const [forwardDialogOpen, setForwardDialogOpen] = useState(false);
   const [forwardMessageData, setForwardMessageData] = useState<{
     messageId: string;
     chatId: string;
     content: string;
     attachments?: any[];
     senderName: string;
     senderId: string;
     metadata?: any;
   } | null>(null);

   // Delete chat dialog state
   const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
   const [deleteChatId, setDeleteChatId] = useState<string | null>(null);

   // Handler for opening delete dialog from ChatHeader
   const handleOpenDeleteDialog = (chatId: string) => {
     setDeleteChatId(chatId);
     setDeleteDialogOpen(true);
   };
   
   // Handle forward message event
   useEffect(() => {
     const handler = (evt: CustomEvent<{
       messageId: string;
       chatId: string;
       content: string;
       attachments?: any[];
       senderName: string;
       senderId: string;
       metadata?: any;
     }>) => {
       setForwardMessageData(evt.detail);
       setForwardDialogOpen(true);
     };
     
     window.addEventListener('zerochat:forward-message', handler as EventListener);
     return () => window.removeEventListener('zerochat:forward-message', handler as EventListener);
   }, []);
    
  // Handle drop on background (outside zones)
  const handleBackgroundDrop = useCallback(() => {
    setDragState({ visible: false, fileTypes: [] });
  }, []);
 
  // Handle drop on zone
  const handleZoneDrop = useCallback((files: File[], mode: SendMode) => {
    // Call MessageInput's openFileDialog method
    messageInputRef.current?.openFileDialog(files, mode);
    setDragState({ visible: false, fileTypes: [] });
  }, []);
 
  // Set up drag event listeners on containerRef using native events
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    
    const handleDragEnter = (e: Event) => {
      const dragEvent = e as DragEvent;
      dragEvent.preventDefault();
      // Не делаем ничего - пусть dragover управляет видимостью
    };
    
    const handleDragOver = (e: Event) => {
      const dragEvent = e as DragEvent;
      dragEvent.preventDefault();
      const dataTransfer = dragEvent.dataTransfer;

      // Check if there are file items (we can't get actual File objects during dragover due to browser security)
      // Collect MIME types for zone detection
      if (dataTransfer && dataTransfer.items) {
        const fileTypes: string[] = [];
        for (let i = 0; i < dataTransfer.items.length; i++) {
          const item = dataTransfer.items[i];
          if (item && item.kind === 'file') {
            fileTypes.push(item.type || 'application/octet-stream');
          }
        }
        
        if (fileTypes.length > 0) {
          // Debounce: cancel any pending hide
          if (dragTimeoutRef.current) {
            clearTimeout(dragTimeoutRef.current);
            dragTimeoutRef.current = null;
          }
          setDragState({ visible: true, fileTypes });
        }
      }
    };
    
    const handleDragLeave = (e: Event) => {
      const dragEvent = e as DragEvent;
      dragEvent.preventDefault();
      
      // Check if leaving to outside the container
      if (!dragEvent.relatedTarget || !container.contains(dragEvent.relatedTarget as Node)) {
        // Debounce hide to avoid flicker when moving to overlay zones
        if (dragTimeoutRef.current) {
          clearTimeout(dragTimeoutRef.current);
        }
        dragTimeoutRef.current = setTimeout(() => {
          setDragState({ visible: false, fileTypes: [] });
          dragTimeoutRef.current = null;
        }, 50); // Small delay to allow re-entry
      }
    };
    
    const handleDrop = (e: Event) => {
      const dragEvent = e as DragEvent;
      dragEvent.preventDefault();
      // Drop handled by overlay zones or background
    };
    
    // Use capture phase to get events before children
    container.addEventListener('dragenter', handleDragEnter, true);
    container.addEventListener('dragover', handleDragOver, true);
    container.addEventListener('dragleave', handleDragLeave, true);
    container.addEventListener('drop', handleDrop, true);
    
    return () => {
      container.removeEventListener('dragenter', handleDragEnter, true);
      container.removeEventListener('dragover', handleDragOver, true);
      container.removeEventListener('dragleave', handleDragLeave, true);
      container.removeEventListener('drop', handleDrop, true);
    };
  }, []);

   // Get other participant ID for private chats
   const otherParticipantId = chat.type === 'private'
     ? chat.participants.find(p => p.id !== currentUser.id)?.id || null
     : null;
   
   return (
     <div className="flex flex-col h-full min-h-0 bg-background" {...(isMobile ? chatSwipeHandlers : {})}>
       {/* Chat header */}
       <ChatHeader
         chat={chat}
         currentUser={currentUser}
         onOpenContactCard={openContactCard}
         onOpenDeleteDialog={handleOpenDeleteDialog}
         onBack={isMobile ? onBack : undefined}
       />

      {/* Messages and Input area with overlay */}
       <div
          ref={containerRef}
          className="flex-1 flex flex-col min-h-0 relative pointer-events-auto"
       >
        {/* ChatMessages - рендерим для всех чатов, включая системный */}
        <ChatMessages chat={chat} />
        
        {/* MessageInput - только для несистемных чатов */}
        {!chat.isSystem && (
          <MessageInput
            ref={messageInputRef}
            chatId={chat.id}
            chatType={chat.type}
            recipientId={
              chat.type === 'private'
                ? otherParticipantId ?? undefined
                : chat.type === 'favorites'
                  ? currentUser.id
                  : undefined
            }
          />
        )}
        
          {/* Drag & Drop Overlay - только над messages + input */}
          <DragDropOverlay
            visible={dragState.visible}
            fileTypes={dragState.fileTypes}
            onZoneDrop={handleZoneDrop}
            onBackgroundDrop={handleBackgroundDrop}
          />
        </div>
        
        {/* Forward Dialog */}
        {forwardMessageData && (
           <ForwardDialog
             open={forwardDialogOpen}
             onOpenChange={setForwardDialogOpen}
             messageData={forwardMessageData}
             availableChats={chats.filter(c => c.id !== forwardMessageData.chatId && c.type !== 'system')}
             onSend={async (targetChat: Chat) => {
                 // Forward message to selected chat - use the chat's id to get chat object
                 const chatObj = chats.find(c => c.id === targetChat.id);
                 if (chatObj) {
                   // Determine the original sender from forwarded metadata chain
                   let originalSenderId = forwardMessageData.senderId;
                   let originalSenderName = forwardMessageData.senderName;
                   let originalChatId = forwardMessageData.chatId;
                   let originalMessageId = forwardMessageData.messageId;
                   let originalContent = forwardMessageData.content;

                   // If the message being forwarded is already a forwarded message,
                   // preserve the original source from metadata.forwardedFrom
                   if (forwardMessageData.metadata?.forwardedFrom) {
                     originalSenderId = forwardMessageData.metadata.forwardedFrom.senderId;
                     originalSenderName = forwardMessageData.metadata.forwardedFrom.senderName;
                     originalChatId = forwardMessageData.metadata.forwardedFrom.chatId;
                     originalMessageId = forwardMessageData.metadata.forwardedFrom.messageId;
                     originalContent = forwardMessageData.metadata.forwardedFrom.content;
                   }

                   // Create metadata for forwarded message
                   const metadata: Record<string, any> = {
                     forwardedFrom: {
                       messageId: originalMessageId,
                       chatId: originalChatId,
                       senderId: originalSenderId,
                       senderName: originalSenderName,
                       content: originalContent, // Include original content for preview
                     }
                   };

                    // Use sendFavoritesMessage for favorites chats, sendMessage for others
                    if (chatObj.type === 'favorites') {
                      await sendFavoritesMessage(forwardMessageData.content, chatObj, undefined, metadata);
                    } else {
                      await sendMessage(forwardMessageData.content, chatObj, undefined, metadata);
                    }
                  }
                  setForwardDialogOpen(false);
                  setForwardMessageData(null);
                }}
           />
         )}
         
        {/* Contact Card Dialog */}
        {contactUserId && (
          <ContactCard
            open={contactCardOpen}
            onOpenChange={closeContactCard}
            userId={contactUserId}
            chatId={contactChatId || undefined}
            onOpenChat={(chatId) => navigate({ to: '/chat/$chatId', params: { chatId } })}
          />
        )}

        {/* Global Image Gallery Viewer - рендерим ПОСЛЕ всех модалок, чтобы быть поверх */}
        <GalleryViewer />

        {/* Delete Chat Dialog - глобальный диалог для всех чатов */}
        {deleteChatId && (
          <DeleteChatDialog
            chatId={deleteChatId}
            isGroup={chat.type === 'group'}
            onDelete={async (chatId: string, deleteMessages: boolean) => {
              await deleteChat(chatId, deleteMessages);
              setDeleteDialogOpen(false);
              setDeleteChatId(null);
            }}
            open={deleteDialogOpen}
            onOpenChange={(open: boolean) => {
              setDeleteDialogOpen(open);
              if (!open) setDeleteChatId(null);
            }}
          />
        )}
    </div>
  );
}
