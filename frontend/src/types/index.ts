// ==================== Chat Types ====================

export type ChatType = 'private' | 'group' | 'system' | 'favorites';

 export interface Chat {
   id: string;
   name?: string;
   type: ChatType;
   avatar?: string;
   participants: User[];
   lastMessage?: LastMessageInfo;
   unreadCount?: number;
   isPinned?: boolean;
   isMuted?: boolean;
   mutedUntil?: number | string | null; // Timestamp when mute expires
   isArchived?: boolean;
  isSystem?: boolean;  // Системный чат ZeroChat
  isFavorites?: boolean; // Избранное (Saved Messages)
  // Folder support (Command Bus)
  folderId?: string;
  // Group-specific fields
  isGroup?: boolean;
   requireApproval?: boolean;
   historyAccess?: HistoryAccess;
   createdById?: string;
   inviteCode?: string;
   inviteCodeExpiresAt?: string;
   description?: string | null;
    createdAt: string;
    updatedAt: string;
    // Virtual chat flag (chat not yet created on server)
    isVirtual?: boolean;
  }

export interface LastMessageInfo {
  id: string;
  content: string | null;  // Prisma String? может вернуть null
  senderId: string;
  chatId?: string;
  type?: MessageType;
  status?: MessageStatus;
  createdAt: string;
  timestamp?: string;
  attachments?: Attachment[];
}

export interface Message {
  id: string;
  chatId: string;
  senderId: string;
  content: string;
  type: MessageType;
  status: MessageStatus;
  createdAt: string;
  sender?: User;
  senderUsername?: string; // Direct username access (populated from stored message)
  replyTo?: string;
  replyToOriginalSenderId?: string; // Original sender ID when replying to a forwarded message
  reactions?: Reaction[];
  attachments?: Attachment[];
  isEdited?: boolean;
  isPinned?: boolean;
  pinnedAt?: number;
  metadata?: any; // Для системных сообщений с дополнительной информацией
}

export type MessageType = 'TEXT' | 'IMAGE' | 'FILE' | 'AUDIO' | 'VIDEO' | 'SYSTEM';

// U7: MessageStatus is the union of all variants that have historically been
// written to storage / received from the server. Callers should normalize via
// `normalizeMessageStatus` (see MessageBubble.tsx) before branching on a
// specific value — the canonical normalized form is lowercase.
export type MessageStatus =
  | 'SENT'
  | 'DELIVERED'
  | 'READ'
  | 'SENDING'
  | 'FAILED'
  | 'sending'
  | 'sent'
  | 'failed';

// ==================== User Types ====================

export interface User {
  id: string;
  username: string;
  displayName?: string;
  avatar?: string;
  status?: UserStatus;
  lastSeen?: string;
  createdAt?: string;
  // Signal Protocol fields
  deviceId?: number;
  needsSession?: boolean;
}

export type UserStatus = 'online' | 'offline' | 'away';

export interface UserProfile {
  id: string;
  username: string;
  displayName?: string;
  avatar?: string;
  status: UserStatus;
  lastSeen?: string;
}

// ==================== Reaction & Attachment ====================

export interface Reaction {
  emoji: string;
  userId: string;
  count: number;
}

export interface Attachment {
  id: string;
  type: 'image' | 'video' | 'audio' | 'voice' | 'file';
  fileName: string;
  mimeType: string;
  size: number;
  contentHash: string;  // SHA-256 для дедупликации
  data?: string;        // Base64 при отправке (зашифрованные данные, расшифрованные на клиенте)
  dimensions?: { width: number; height: number };
  duration?: number;
  wasCompressed?: boolean;
  originalSize?: number;
}

// ==================== Auth Types ====================

/**
 * Auth tokens - NOTE: refreshToken is stored in httpOnly cookie
 * This interface only represents the access token stored in JS
 */
export interface AuthTokens {
  accessToken: string;
}

export interface LoginCredentials {
  username: string;
  password: string;
}

export interface RegisterData {
  username: string;
  password: string;
  displayName?: string;
}

export interface AuthResponse {
  user: User;
  tokens: AuthTokens;
}

// ==================== Settings Types ====================

export type ThemeMode = 'light' | 'dark' | 'system';

export interface UserSettings {
  theme: ThemeMode;
  notifications: boolean;
  sound: boolean;
  showOnlineStatus: boolean;
  readReceipts: boolean;
  autoSaveMedia: boolean;
}

// ==================== WebSocket Types ====================

export interface OnlineStatus {
  userId: string;
  status: UserStatus;
  timestamp: string;
}

export type WSEventType =
  | 'message'
  | 'message_delivered'
  | 'message_read'
  | 'user_online'
  | 'user_offline'
  | 'typing'
  | 'chat_updated'
  | 'chat_deleted'
  | 'favorites_message'
  | 'favorites_message_ack'
  | 'NEW_MESSAGE'
  | 'MESSAGE_DELIVERED'
  | 'MESSAGE_READ'
  | 'USER_ONLINE'
  | 'USER_OFFLINE';

export interface WSEvent {
  type: WSEventType;
  payload: unknown;
  timestamp: string;
}

export interface WSNewMessagePayload {
  id: string;
  chatId: string;
  senderId: string;
  content: string;
  type: MessageType;
  status: MessageStatus;
  createdAt: string;
}

export interface WSFavoritesMessagePayload {
  id: string;
  chatId: string;
  senderId: string;
  senderDeviceId: number;
  content: string; // Base64 encoded encrypted content
  type: MessageType;
  status: MessageStatus;
  createdAt: string;
  // Multi-device delivery info
  targetDevices?: { deviceId: number; content: string; messageType: number }[];
}

export interface WSMessageStatusPayload {
  chatId: string;
  messageId: string;
  status: 'DELIVERED' | 'READ';
}

export interface WSPresencePayload {
  userId: string;
  status: UserStatus;
}

// ==================== Command Bus Types ====================

export type CommandPriority = 'low' | 'normal' | 'high' | 'critical';

export type CommandAckStatus = 'received' | 'executed' | 'failed';

export type CommandType =
  // === Сообщения ===
  | 'message.delete'
  | 'message.edit'
  | 'message.pin'
  | 'message.unpin'
  | 'message.react'
  | 'message.unreact'
  | 'message.reply'
  
  // === Чаты ===
  | 'chat.delete'
  | 'chat.leave'
  | 'chat.update'
  | 'chat.mute'
  | 'chat.unmute'
  | 'chat.pin'
  | 'chat.unpin'
  | 'chat.archive'
  | 'chat.unarchive'
  
  // === Папки чатов ===
  | 'folder.create'
  | 'folder.update'
  | 'folder.delete'
  | 'folder.add_chat'
  | 'folder.remove_chat'
  | 'folder.reorder'
  
  // === Участники ===
  | 'participant.add'
  | 'participant.remove'
  | 'participant.role_update'
  
  // === Системные (ручные) ===
  | 'system.clear_chat'
  | 'system.export_chat'
  | 'system.report_message'
  
  // === Системные (автоматические) ===
  | 'system.participant_joined'
  | 'system.participant_left'
  | 'system.role_changed'
  | 'system.chat_created'
  
  // === Устройства ===
  | 'device.verification_request';

// Command Issuer Metadata
export interface CommandIssuer {
  userId: string;
  deviceId: string;
  signalDeviceId?: number;
}

// Command Metadata
export interface CommandMetadata {
  version: number;
  issuer: CommandIssuer;
  priority: CommandPriority;
  encrypted?: boolean;
  createdAt: number;
}

// Base Command Message
export interface CommandMessage<P extends CommandPayload = CommandPayload> {
  commandId: string;
  command: CommandType;
  payload: P;
  metadata: CommandMetadata;
}

// Encrypted Payload Wrapper
export interface EncryptedPayload {
  encryptedBase64: string;
  encryptionType: 'signal_pqxdh';
}

// ========== Message Payloads ==========
export interface MessageDeletePayload {
  messageId: string;
  chatId: string;
  deleteForEveryone: boolean;
}

export interface MessageEditPayload {
  messageId: string;
  chatId: string;
  content: string;
  editTimestamp: number;
}

export interface MessagePinPayload {
  messageId: string;
  chatId: string;
  pinTimestamp: number;
}

export interface MessageReactPayload {
  messageId: string;
  chatId: string;
  emoji: string;
  add: boolean;
  userId: string; // ID пользователя, поставившего реакцию
}

export interface MessageUnreactPayload {
  messageId: string;
  chatId: string;
  emoji: string;
  userId: string; // ID пользователя, чью реакцию снимаем (должен совпадать с текущим пользователем)
}

export interface MessageReplyPayload {
  messageId: string;
  chatId: string;
  replyToMessageId: string;
}

// ========== Chat Payloads ==========
export interface ChatDeletePayload {
  chatId: string;
  deleteMessages: boolean;
}

export interface ChatLeavePayload {
  chatId: string;
  userId: string;
}

export interface ChatUpdatePayload {
  chatId: string;
  updates: {
    name?: string;
    avatar?: string;
    description?: string;
  };
}

export interface ChatMutePayload {
  chatId: string;
  mutedUntil?: string | null;
}

export interface ChatUnmutePayload {
  chatId: string;
}

export interface ChatPinPayload {
  chatId: string;
}

export interface ChatUnpinPayload {
  chatId: string;
}

export interface ChatArchivePayload {
  chatId: string;
}

export interface ChatUnarchivePayload {
  chatId: string;
}

// ========== Folder Payloads ==========
export interface FolderCreatePayload {
  name: string;
  color?: string;
  order: number;
}

export interface FolderUpdatePayload {
  folderId: string;
  updates: {
    name?: string;
    color?: string;
    order?: number;
  };
}

export interface FolderDeletePayload {
  folderId: string;
  moveChatsTo?: string | null;
}

export interface FolderAddChatPayload {
  folderId: string;
  chatId: string;
}

export interface FolderRemoveChatPayload {
  folderId: string;
  chatId: string;
}

export interface FolderReorderPayload {
  folderId: string;
  newOrder: number;
}

// ========== Participant Payloads ==========
export interface ParticipantAddPayload {
  chatId: string;
  userId: string;
  role?: UserRole;
}

export interface ParticipantRemovePayload {
  chatId: string;
  userId: string;
}

export interface ParticipantRoleUpdatePayload {
  chatId: string;
  userId: string;
  newRole: UserRole;
}

// ========== System Payloads ==========
export interface SystemClearChatPayload {
  chatId: string;
  clearFor: 'me' | 'everyone';
}

export interface SystemExportChatPayload {
  chatId: string;
  format: 'json' | 'txt' | 'pdf';
  includeMedia?: boolean;
}

export interface SystemReportMessagePayload {
  messageId: string;
  chatId: string;
  reason: 'spam' | 'abuse' | 'inappropriate' | 'other';
  description?: string;
}

// ========== System Event Payloads (auto) ==========
export interface SystemParticipantJoinedPayload {
  chatId: string;
  userId: string;
  username: string;
  joinedAt: number;
  inviterId?: string;
}

export interface SystemParticipantLeftPayload {
  chatId: string;
  userId: string;
  username: string;
  leftAt: number;
  reason: 'left_voluntarily' | 'removed_by_admin' | 'banned';
  removedBy?: string;
}

export interface SystemRoleChangedPayload {
  chatId: string;
  userId: string;
  username: string;
  oldRole: UserRole;
  newRole: UserRole;
  changedBy: string;
  changedAt: number;
}

export interface SystemChatCreatedPayload {
  chatId: string;
  chatType: 'PRIVATE' | 'GROUP';
  name?: string;
  createdBy: {
    userId: string;
    username: string;
  };
  createdAt: number;
}

// Union type for all payloads
export type CommandPayload =
  // Messages
  | MessageDeletePayload
  | MessageEditPayload
  | MessagePinPayload
  | MessageReactPayload
  | MessageUnreactPayload
  | MessageReplyPayload
  // Chats
  | ChatDeletePayload
  | ChatLeavePayload
  | ChatUpdatePayload
  | ChatMutePayload
  | ChatUnmutePayload
  | ChatPinPayload
  | ChatUnpinPayload
  | ChatArchivePayload
  | ChatUnarchivePayload
  // Folders
  | FolderCreatePayload
  | FolderUpdatePayload
  | FolderDeletePayload
  | FolderAddChatPayload
  | FolderRemoveChatPayload
  | FolderReorderPayload
  // Participants
  | ParticipantAddPayload
  | ParticipantRemovePayload
  | ParticipantRoleUpdatePayload
  // System (manual)
  | SystemClearChatPayload
  | SystemExportChatPayload
  | SystemReportMessagePayload
  // System (auto)
  | SystemParticipantJoinedPayload
  | SystemParticipantLeftPayload
  | SystemRoleChangedPayload
  | SystemChatCreatedPayload;

// ========== Command Ack & Event ==========
export interface CommandAckPayload {
  commandId: string;
  commandType: string;
  status: CommandAckStatus;
  error?: {
    code: string;
    message: string;
  };
  result?: unknown;
  executedAt: number;
}

export interface CommandEventPayload {
  commandId: string;
  commandType: string;
  issuer: CommandIssuer;
  timestamp: number;
  payload: CommandPayload;
  result?: unknown;
}

export interface CommandErrorPayload {
  commandId: string;
  commandType: string;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  timestamp: number;
}

// ========== User Role (from backend) ==========
export type UserRole = 'OWNER' | 'ADMIN' | 'MODERATOR' | 'MEMBER';

// ========== Message Reaction Record (IndexedDB) ==========
export interface MessageReactionRecord {
  id: string; // compound key: `${messageId}:${userId}:${emoji}`
  messageId: string;
  userId: string;
  emoji: string;
  createdAt: number;
}

// ========== Folder Records (IndexedDB) ==========
export interface FolderRecord {
  id: string;
  userId: string;
  name: string;
  color: string | null;
  order: number;
  createdAt: number;
  updatedAt: number;
}

export interface ChatFolderItemRecord {
  chatId: string;
  folderId: string;
  order: number;
}

// ========== Extended Chat with Command Fields ==========
export interface ChatWithCommandFields extends Omit<Chat, 'isPinned' | 'isMuted'> {
  isPinned: boolean;
  isMuted: boolean;
  mutedUntil: string | null;
  isArchived: boolean;
  description: string | null;
}

// ========== Extended Message with Command Fields ==========
export interface MessageWithCommandFields extends Omit<Message, 'isEdited'> {
  isPinned: boolean;
  editedAt: number;
}

// ==================== Test Types ====================

export interface TestChat extends Omit<Chat, 'participants'> {
  participants: TestUser[];
  messages: TestMessage[];
}

export interface TestUser extends Omit<User, 'status'> {
  status: UserStatus;
}

export interface TestMessage extends Omit<Message, 'senderId'> {
  senderId: string;
}

// ==================== Form Types ====================

export interface LoginFormData {
  username: string;
  password: string;
}

export interface RegisterFormData {
  username: string;
  password: string;
  confirmPassword: string;
  displayName?: string;
}

export interface Device {
  id: string;
  userId: string;
  deviceId: string;
  signalDeviceId?: number;
  name: string;
  type: string;
  isActive: boolean;
  isCurrentDevice?: boolean;
  lastSeen?: string;
  createdAt: string;
  lastUsedAt?: string;
}

export interface DevicesResponse {
  devices: Device[];
  currentDeviceId: string;
}

export interface PaginatedMessagesResponse {
  messages: Message[];
  hasMore: boolean;
  nextOffset?: number;
}

export interface ChatCreateResponse {
  chatId: string;
  chatType: 'PRIVATE' | 'GROUP';
  participants: {
    userId: string;
    username: string;
    displayName?: string;
    status?: 'online' | 'offline' | 'away';
    lastSeen?: string;
    deviceId?: string;
    needsSession: boolean;
  }[];
  x3dhStatus: 'initiated' | 'completed' | 'pending';
  requiresPreKeyFetch: boolean;
}

export interface UserSearchResult {
  id: string;
  username: string;
  displayName?: string;
  avatar?: string;
  status?: 'online' | 'offline' | 'away';
  deviceId?: number;  // Signal Protocol device ID for key exchange
}

// ==================== Group Chat Types ====================

export type HistoryAccess = 'ALL' | 'FROM_NOW' | 'NONE';

export interface GroupParticipant {
  userId: string;
  username: string;
  displayName?: string;
  avatar?: string;
  role: UserRole;
  joinedAt: string;
  status?: 'online' | 'offline' | 'away';
  lastSeen?: string;
}

export interface GroupInfo {
  id: string;
  name: string;
  avatar?: string;
  description?: string | null;
  isGroup: boolean;
  requireApproval: boolean;
  historyAccess: HistoryAccess;
  createdBy: {
    id: string;
    username: string;
  };
  inviteCode?: string;
  inviteCodeExpiresAt?: string;
  participants: GroupParticipant[];
}

export interface CreateGroupData {
  name: string;
  participants: string[]; // usernames
  requireApproval?: boolean;
  historyAccess?: HistoryAccess;
}

export interface CreateGroupResponse {
  success: boolean;
  data: {
    chatId: string;
    chatType: 'GROUP';
    name: string;
    participants: {
      userId: string;
      username: string;
      displayName?: string;
      role: UserRole;
      joinedAt: string;
    }[];
  };
  message: string;
}

export interface InviteLinkResponse {
  success: boolean;
  data: {
    chatId: string;
    inviteCode: string;
    expiresAt: string;
    inviteUrl: string;
  };
}

export interface JoinByInviteResponse {
  success: boolean;
  data: {
    chatId: string;
    isNewChat: boolean;
    chatType: 'GROUP';
    message: string;
  };
}
