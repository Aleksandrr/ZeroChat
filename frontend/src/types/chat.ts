/**
 * Chat types - extracted from ChatContext.tsx
 */
import type { Attachment,Chat, Message, UserRole } from './index';

// Re-export base types
export type { Chat, Message, UserRole };

// Typing indicator status
export interface TypingUser {
  userId: string;
  isTyping: boolean;
  timestamp: number;
}

 // Chat context value type
 export interface ChatContextType {
   chats: Chat[];
   activeChat: Chat | null;
   chatsLoading: boolean;
   typingUsers: Record<string, TypingUser[]>; // chatId -> typing users
   setActiveChat: (chat: Chat | null) => void;
   setChats: React.Dispatch<React.SetStateAction<Chat[]>>; // For external updates (e.g., file upload)
   selectChat: (chat: Chat | null) => void;
   clearActiveChat: () => void;
   loadChats: (forceRefresh?: boolean) => Promise<void>;
   createChat: (username: string, initialMessage?: string) => Promise<Chat>;
    sendMessage: (content: string, chatOrChatId?: Chat | string, replyTo?: string, metadata?: Record<string, any>) => Promise<void>;
     sendFavoritesMessage: (content: string, chatOrChatId?: Chat | string, replyTo?: string, metadata?: Record<string, any>) => Promise<void>;
   markAsRead: (chatId: string, messageIds?: string[]) => Promise<void>;
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
    getTypingUsers: (chatId: string) => TypingUser[];
    // System commands
     clearChat: (chatId: string) => Promise<void>;
     exportChat: (chatId: string) => Promise<Blob>;
     reportMessage: (chatId: string, messageId: string, reason: 'spam' | 'abuse' | 'inappropriate' | 'other') => Promise<void>;
     // Participant management
     addParticipant: (chatId: string, userId: string, role?: UserRole) => Promise<void>;
     removeParticipant: (chatId: string, userId: string) => Promise<void>;
     updateParticipantRole: (chatId: string, userId: string, role: UserRole) => Promise<void>;
     // Folder management
     createFolder: (name: string, color?: string, order?: number) => Promise<string>;
     updateFolder: (folderId: string, updates: { name?: string; color?: string; order?: number }) => Promise<void>;
     deleteFolder: (folderId: string, moveChatsTo?: string | null) => Promise<void>;
     addChatToFolder: (folderId: string, chatId: string) => Promise<void>;
     removeChatFromFolder: (folderId: string, chatId: string) => Promise<void>;
     reorderFolder: (folderId: string, newOrder: number) => Promise<void>;
      // Virtual chat support
      openVirtualChat: (contact: { id: string; username: string; displayName?: string; avatar?: string }) => void;
      // Contact card support
      contactCardOpen: boolean;
      contactUserId: string | null;
      contactChatId: string | null;
      openContactCard: (userId: string) => void;
      closeContactCard: () => void;
    }

// Internal WebSocket message type
export interface InternalWSChatMessage {
  type: 'message';
  payload: {
    chatId: string;
    content: string;
    senderId: string;
    senderUsername?: string;
    senderDeviceId: string;
    timestamp: number;
    messageId: string;
    messageType: number;
    replyTo?: string; // ID of message being replied to
    replyToOriginalSenderId?: string; // Original sender ID when replying to forwarded message
    unreadCount?: number;  // From backend - source of truth
    isPending?: boolean;
    isSelfDelivery?: boolean;
    isSystem?: boolean;
    type?: string;
    metadata?: any;
    attachments?: Attachment[];
  };
}

// Group sync payload
export interface GroupSyncPayload {
  chatId: string;
  senderUserId: string;
  senderKeyId: string;
  senderKey: string;
  senderKeySignature?: string;
}

// Group message payload
export interface GroupMessagePayload {
  chatId: string;
  content: string;
  senderUserId: string;
  senderDeviceId: string;
  messageId: string;
  timestamp: number;
  senderKeyId?: string;
  replyTo?: string;
  attachments?: unknown[];
  senderKeyDistribution?: string;  // Base64-encoded SKDM from sender
  unreadCount?: number;  // From backend - source of truth
  isPending?: boolean;  // Flag for pending/offline messages (already counted in DB)
  isSelfDelivery?: boolean;  // Flag for self-delivery (sender's other devices)
  metadata?: any;  // Metadata for forwarded messages, etc.
  senderUsername?: string;  // Optional username for display (resolved from participants)
}

// Typing indicator payload
export interface TypingIndicatorPayload {
  chatId?: string;
  userId?: string;
  isTyping?: boolean;
}

// Session sync payload
export interface SessionSyncPayload {
  userId: string;
  deviceId: number;
  reason: string;
}

// Message retry payload
export interface MessageRetryPayload {
  originalMessageId: string;
  chatId: string;
  senderId: string;
  senderDeviceId: number;
}
