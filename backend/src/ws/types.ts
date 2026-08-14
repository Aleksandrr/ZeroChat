// ==================== WebSocket Types ====================

import { UserRole } from '../types';

// Base Message Types
export interface WSMessage<T = unknown> {
  type: WSMessageType;
  payload: T;
  timestamp: number;
  id: string;
  messageId?: string;
}

export type WSMessageType =
  | 'auth' | 'prekey' | 'message' | 'ack' | 'error' | 'heartbeat'
  | 'handshake' | 'handshake_ack' | 'delivery' | 'typing' | 'presence'
  | 'session_sync' | 'message_retry'
  | 'mark_read' | 'read' | 'read_ack'
  | 'ping' | 'pong'
  | 'sync_event'  // New type for sync events
  | 'multi_message' // Multi-device message (Sesame protocol)
  | 'favorites_message' // Favorites/Saved messages (multi-device to self)
  // Multi-device sync (P2P between devices)
  | 'sync_request'    // Request history from active device
  | 'sync_history'    // Encrypted history response
  | 'sync_ack'        // Acknowledgment of sync completion
  | 'device_online'   // Notification about new device online
  | 'ready'           // Client is ready to receive pending messages
  | 'message_ack'     // Client confirms receipt + processing of pending message
  // Two-phase P2P sync (invite/accept protocol)
  | 'sync_invite'     // New device invites existing devices to sync
  | 'sync_accept'     // Existing device accepts sync request
  | 'sync_cancel'     // Cancel sync invite (after accept or timeout)
  | 'sync_reject'    // Explicit rejection of sync request
  // Group chat messages
  | 'group_message'          // Encrypted group message (Sender Key)
  | 'group_key_update'       // Sender Key update notification
  | 'group_sync'             // Sync Sender Keys between devices
  | 'group_message_ack'      // Group message acknowledgment
  | 'sender_key_distribution_message'  // Sender Key distribution message (SKDM)
  // Command Bus (unified command protocol)
  | 'command'        // Command message (P2P encrypted or server-mediated)
  | 'command_ack'    // Command acknowledgment
  | 'command_event'  // Command execution event (broadcast)
  | 'command_error'  // Command execution error
  // WebRTC Call Signaling (relay-only, media is DTLS-SRTP encrypted)
  | 'call_offer'     // Caller → callee: start call (with SDP)
  | 'call_answer'    // Callee → caller: accept call (with SDP)
  | 'call_reject'    // Callee → caller: reject call
  | 'call_end'       // Either side: end call
  | 'call_ice'       // Trickle ICE candidate exchange
  | 'call_busy';     // Callee → caller: already in a call

// WebRTC Call Signaling
export type CallType = 'audio' | 'video';

export interface CallOfferPayload {
  callId: string;
  recipientId: string;
  callerId: string;
  callerName: string;
  callType: CallType;
  chatId?: string;
  sdp?: string;  // SDP offer (optional — can be sent separately)
}

export interface CallAnswerPayload {
  callId: string;
  callerId: string;
  answer: string;  // SDP answer
}

export interface CallIcePayload {
  callId: string;
  candidate: string;  // ICE candidate JSON
  toUserId: string;
}

export interface CallEndPayload {
  callId: string;
  reason?: 'ended' | 'rejected' | 'busy' | 'timeout' | 'failed';
}

// Auth Message Types
export interface AuthPayload {
  accessToken: string;
  deviceId: string;
}

export interface HandshakePayload {
  token: string;
  deviceId?: string;
  platform?: string;
  language?: string;
}

// PreKey Message Types
export interface PreKeyPayload {
  chatId: string;
  recipientId: string;
  recipientDeviceId: number;
  preKeyBundle: {
    registrationId: number;
    identityKey: string;
    signedPreKeyId: number;
    signedPreKey: string;
    signedPreKeySignature: string;
    preKeyId: number;
    preKey: string;
    kyberPreKeyId: number;
    kyberPreKey: string;
    kyberPreKeySignature: string;
  };
}

// Chat Message Types (legacy - single device)
export interface MessagePayload {
  chatId: string;
  content: string;
  recipientId: string;
  recipientDeviceId: number;
  messageType: number;
  replyTo?: string;
  attachments?: WSAttachment[];
}

// Multi-Device Message Types (Sesame protocol)
// Each device gets its own encrypted copy
export interface EncryptedMessageForDevice {
  deviceId: number;        // Signal device ID (1-127)
  content: string;         // Base64 encrypted content for this device
  messageType: number;     // 2 = SignalMessage, 3 = PreKeyMessage
}

export interface MultiDeviceMessagePayload {
  chatId: string;
  recipientId: string;                              // Recipient user ID
  recipientMessages: EncryptedMessageForDevice[];   // Encrypted for each recipient device
  senderMessages?: EncryptedMessageForDevice[];     // Encrypted for sender's other devices (self-delivery)
  replyTo?: string;
  attachments?: WSAttachment[];
  metadata?: Record<string, any>; // Additional metadata (e.g., forwardedFrom)
  messageId?: string; // Client-generated UUID for consistent message identification
}

// Favorites Message Types (Saved Messages)
// For favorites chat, recipient is the sender themselves
// No echo to sending device - local echo handled by client
export interface FavoritesMessagePayload {
  chatId: string;
  messages: EncryptedMessageForDevice[];   // Encrypted for each device
  replyTo?: string;
  attachments?: WSAttachment[];
  messageId?: string; // Client-generated UUID for consistent message identification
}

export interface WSAttachment {
  id: string;
  type: string;
  size: number;
  mimeType: string;
  encryptionKey?: string;
}

// ACK Message Types
export interface AckPayload {
  messageId: string;
  chatId?: string;
  status: 'received' | 'read' | 'processed';
}

// Error Message Types
export interface ErrorPayload {
  code: number | string;  // number для legacy кодов, string для именованных ошибок (STORAGE_QUOTA_EXCEEDED)
  message: string;
  messageId?: string;
  details?: unknown;
}

// Storage Quota Error Details
export interface StorageQuotaErrorDetails {
  code: 'STORAGE_QUOTA_EXCEEDED';
  usedBytes: number;
  maxBytes: number;
  availableBytes: number;
  percentUsed: number;
  requiredBytes?: number;  // Сколько байт требуется для текущей операции
}

// WebSocket Error Codes
export const WSErrorCode = {
  STORAGE_QUOTA_EXCEEDED: 'STORAGE_QUOTA_EXCEEDED',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  PAYLOAD_SIZE_MISMATCH: 'PAYLOAD_SIZE_MISMATCH',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
} as const;

// File rate limit error details
export interface FileRateLimitErrorDetails {
  code: 'RATE_LIMIT_MESSAGES' | 'RATE_LIMIT_BYTES';
  retryAfter: number; // seconds until retry
  currentMessages: number;
  currentBytes: number;
  limitMessages: number;
  limitBytes: number;
}

// Payload size error details
export interface PayloadSizeErrorDetails {
  code: 'PAYLOAD_TOO_LARGE' | 'PAYLOAD_SIZE_MISMATCH';
  declaredSize?: number;
  actualSize: number;
  maxSize: number;
}

// Delivery Status Types
export interface DeliveryStatusPayload {
  messageId: string;
  chatId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  deviceId?: number | string; // Can be numeric signalDeviceId or UUID
  timestamp: number;
}

// Typing Indicator Types
export interface TypingPayload {
  chatId: string;
  isTyping: boolean;
}

// Presence Types
export interface PresencePayload {
  userId: string;
  status: 'online' | 'offline' | 'away';
  lastSeen?: string;
}

// Authenticated Device (from auth module)
export interface AuthenticatedDevice {
  id: string;
  deviceId: string;        // UUID для идентификации устройства
  signalDeviceId: number; // Signal Protocol device ID (1-127)
  name: string;
  type: string;
  userId: string;
  username: string;
  isActive: boolean;
}

// Session Sync Message Types
export interface SessionSyncPayload {
  userId: string;
  deviceId: number;
  reason: 'session_refresh' | 'new_device' | 'retry_request';
}

// Message Retry Request Types
export interface MessageRetryPayload {
  originalMessageId: string;
  chatId: string;
  senderId: string;
  senderDeviceId: number;
  reason: 'decryption_failed';
}

// ==================== Sync Event Types ====================

export interface SyncEventPayload {
  eventId: string;
  type: 'upsert' | 'delete' | 'tombstone';
  entityType: 'message' | 'chat' | 'contact' | 'device' | 'profile';
  entityId: string;
  timestamp: number;
  vectorClock: Record<string, number>; // Vector clock for causal ordering
  encryptedPayload?: string; // Encrypted payload for sensitive data
  metadata?: Record<string, any>; // Additional metadata about the event
}

// ==================== Mark-as-Read Types ====================

// Client -> Server: Mark messages as read
export interface MarkReadPayload {
  chatId: string;
  messageIds?: string[]; // Optional: specific messages. If omitted, all unread in chat
}

// Server -> Client: Read event notification (to message authors)
export interface ReadEventPayload {
  chatId: string;
  readBy: string;        // userId who read the messages
  readAt: string;         // ISO timestamp
  messageIds: string[];   // Which messages were read
}

// Server -> Client: Acknowledgment to the marking client
export interface ReadAckPayload {
  chatId: string;
  markedCount: number;    // Number of messages marked as read
  unreadCount: number;    // Current unread count (should be 0 after reading)
  readAt: string;         // ISO timestamp
  messageIds: string[];   // IDs of marked messages
}

// ==================== Multi-Device Sync Types (P2P) ====================

// Vector Clock for causal ordering of events
export type VectorClock = Record<string, number>; // device_id -> sequence number

// Client -> Server: Request history from active device (new device sends this)
export interface SyncRequestPayload {
  requestingDeviceId: string;  // UUID of the requesting device
  vectorClock: VectorClock;    // Current vector clock of the requesting device
}

// Client -> Server: Encrypted history response (active device sends this)
export interface SyncHistoryPayload {
  targetDeviceId: string;       // UUID of the target device to receive history
  senderDeviceId: string;       // UUID of the device sending history
  senderSignalDeviceId?: number; // Signal Protocol device ID (1-127) for decryption
  encryptedHistory: string;     // Base64 encrypted history payload
  vectorClock: VectorClock;     // Updated vector clock after this sync
}

// Client -> Server: Acknowledgment of sync completion
export interface SyncAckPayload {
  deviceId: string;            // UUID of the device acknowledging sync
  newVectorClock: VectorClock; // New vector clock after applying history
}

// Server -> Client: Notification about device coming online
export interface DeviceOnlinePayload {
  userId: string;
  deviceId: string;           // UUID of the device that came online
  signalDeviceId: number;     // Signal Protocol device ID (1-127)
  deviceName?: string;        // Human-readable device name
}

// ==================== Two-Phase P2P Sync Types ====================

// Client -> Server: New device invites existing devices to sync
// Server forwards to all online devices of the same user
export interface SyncInvitePayload {
  invitingDeviceId: string;      // UUID of the new device requesting sync
  invitingDeviceName?: string;   // Human-readable device name (for UI)
  timestamp: number;             // When the invite was created
}

// Client -> Server: Existing device accepts sync request
// Server forwards to the inviting device and sends sync_cancel to others
export interface SyncAcceptPayload {
  acceptingDeviceId: string;     // UUID of the device that will send history
  targetDeviceId: string;        // UUID of the new device (invite sender)
  timestamp: number;             // When the accept was created
}

// Server -> Client: Cancel sync invite
// Sent to all devices except the one that accepted
export interface SyncCancelPayload {
  invitingDeviceId: string;      // UUID of the device that sent the invite
  acceptedByDeviceId: string;    // UUID of the device that accepted
  reason: 'accepted' | 'timeout' | 'rejected' | 'no_devices';
}

// Client -> Server: Explicit rejection of sync request (optional)
export interface SyncRejectPayload {
  rejectingDeviceId: string;     // UUID of the device rejecting
  targetDeviceId: string;        // UUID of the inviting device
  timestamp: number;
}

// Encrypted history payload structure (for reference, not transmitted as-is)
// This is what gets encrypted inside encryptedHistory field
export interface EncryptedHistoryPayload {
  messages: Array<{
    chatId: string;
    senderId: string;
    senderDeviceId: number;
    content: string;          // Already encrypted message content
    messageId: string;
    timestamp: number;
    messageType: number;
  }>;
  vectorClock: VectorClock;
}

// ==================== Group Chat Message Types ====================

/**
 * Client -> Server: Send encrypted group message (Sender Key)
 * The message is encrypted with Sender Key and broadcast to all group members
 */
export interface GroupMessagePayload {
  chatId: string;                    // Group chat ID
  senderUserId: string;              // Sender's user ID
  senderDeviceId: string;           // Sender's device UUID
  content: string;                   // Base64 encrypted message content (Sender Key)
  messageId: string;                 // Unique message ID
  senderKeyId?: string;             // Optional: which sender key was used
  replyTo?: string;                  // Optional: message being replied to
  attachments?: WSAttachment[];     // Optional: attachments
  senderKeyDistribution?: string;    // Optional: Base64-encoded SKDM for other members
  metadata?: Record<string, any>; // Additional metadata (e.g., forwardedFrom)
}

/**
 * Server -> Client: Incoming encrypted group message
 */
export interface GroupMessageIncomingPayload {
  chatId: string;
  content: string;                   // Base64 encrypted message content
  senderUserId: string;
  senderDeviceId: string;
  messageId: string;
  timestamp: number;
  senderKeyId?: string;
  replyTo?: string;
  attachments?: WSAttachment[];
  senderKeyDistribution?: string;    // Optional: Base64-encoded SKDM from sender
}

/**
 * Client -> Server: Request to update Sender Key
 * Sent when: member leaves/joins, group admin changes
 */
export interface GroupKeyUpdateRequestPayload {
  chatId: string;                    // Group chat ID
  requestingUserId: string;          // User requesting the update
  requestingDeviceId: string;        // Device requesting the update
  reason: 'member_joined' | 'member_left' | 'admin_changed' | 'manual_request';
}

/**
 * Server -> Client: Sender Key has been updated
 * All group members receive this notification
 */
export interface GroupKeyUpdatePayload {
  chatId: string;
  senderUserId: string;              // Who generated the new key
  senderDeviceId: string;             // Which device generated the key
  senderKeyId: string;                // New sender key ID
  senderKey: string;                  // Base64 encoded Sender Key material (encrypted for each member)
  reason: 'member_joined' | 'member_left' | 'admin_changed';
}

/**
 * Client -> Server: Sync Sender Keys between user's own devices
 * Used for multi-device sync of group Sender Keys
 */
export interface GroupSyncPayload {
  chatId: string;                    // Group chat ID
  senderUserId: string;              // User whose keys these are
  senderKeyId: string;               // Sender key ID
  senderKey: string;                 // Base64 encoded Sender Key material
  senderKeySignature?: string;       // Optional: signature of sender key
  /**
   * C4 (signature-key storage): Optional signing-key material. When
   * present, the server persists them (encrypting the private key at
   * rest) so other devices can verify Sender Key signatures without
   * an extra round-trip. When absent, the server stores empty
   * strings and logs a warning — signature verification must then
   * happen via the SKDM channel (client responsibility).
   */
  signatureKeyPub?: string;          // Base64 public signing key
  signatureKeyPriv?: string;         // Base64 private signing key (encrypted at rest by server)
}

/**
 * Server -> Client: Acknowledge group message receipt
 */
export interface GroupMessageAckPayload {
  messageId: string;
  chatId: string;
  status: 'received' | 'delivered';
}

/**
 * Client <-> Server: Sender Key Distribution Message (SKDM)
 * Used to distribute Sender Key material to new group members
 */
export interface SenderKeyDistributionPayload {
  chatId: string;                      // Group chat ID
  senderUserId: string;                // User who owns the Sender Key
  senderDeviceId: number;              // Device that generated the distribution
  receiverUserId: string;              // Target user receiving the SKDM
  receiverDeviceId: number;            // Target device receiving the SKDM
  distributionId: string;              // Unique ID for this distribution
  message: string;                     // Base64 encoded encrypted SKDM
}

// ==================== Command Bus Types ====================

// Command priority levels
export type CommandPriority = 'low' | 'normal' | 'high' | 'critical';

// Command issuer metadata
export interface CommandIssuer {
  userId: string;
  deviceId: string;
  signalDeviceId?: number; // For E2EE (Signal Protocol device ID)
}

// Command metadata
export interface CommandMetadata {
  version: number;
  issuer: CommandIssuer;
  priority: CommandPriority;
  encrypted?: boolean; // Whether payload is E2EE encrypted
  createdAt: number;
}

// Command types (23 types)
export type CommandType =
  // === Messages ===
  | 'message.delete'
  | 'message.edit'
  | 'message.pin'
  | 'message.unpin'
  | 'message.react'
  | 'message.unreact'
  | 'message.reply'
  
  // === Chats ===
  | 'chat.delete'
  | 'chat.leave'
  | 'chat.update'
  | 'chat.mute'
  | 'chat.unmute'
  | 'chat.pin'
  | 'chat.unpin'
  | 'chat.archive'
  | 'chat.unarchive'
  
  // === Chat Folders ===
  | 'folder.create'
  | 'folder.update'
  | 'folder.delete'
  | 'folder.add_chat'
  | 'folder.remove_chat'
  | 'folder.reorder'
  
   // === Participants ===
   | 'participant.add'
   | 'participant.remove'
   | 'participant.role_update'
   
   // === Device ===
   | 'device.verification_request'  // Запрос на генерацию кода верификации
   
   // === System (manual) ===
  | 'system.clear_chat'
  | 'system.export_chat'
  | 'system.report_message'
  
  // === System (automatic events) ===
  | 'system.participant_joined'
  | 'system.participant_left'
  | 'system.role_changed'
  | 'system.chat_created';

// Command payloads (union type)
export type CommandPayload =
  // === Messages ===
  | MessageDeletePayload
  | MessageEditPayload
  | MessagePinPayload
  | MessageUnpinPayload
  | MessageReactPayload
  | MessageUnreactPayload
  | MessageReplyPayload
  
  // === Chats ===
  | ChatDeletePayload
  | ChatLeavePayload
  | ChatUpdatePayload
  | ChatMutePayload
  | ChatUnmutePayload
  | ChatPinPayload
  | ChatUnpinPayload
  | ChatArchivePayload
  | ChatUnarchivePayload
  
  // === Chat Folders ===
  | FolderCreatePayload
  | FolderUpdatePayload
  | FolderDeletePayload
  | FolderAddChatPayload
  | FolderRemoveChatPayload
  | FolderReorderPayload
  
   // === Participants ===
   | ParticipantAddPayload
   | ParticipantRemovePayload
   | ParticipantRoleUpdatePayload
   
   // === Device ===
   | DeviceVerificationRequestPayload
   
   // === System (manual) ===
  | SystemClearChatPayload
  | SystemExportChatPayload
  | SystemReportMessagePayload
  
  // === System (automatic) ===
  | SystemParticipantJoinedPayload
  | SystemParticipantLeftPayload
  | SystemRoleChangedPayload
  | SystemChatCreatedPayload;

// Unified command message
export interface CommandMessage {
  commandId: string; // UUID (client-generated)
  command: CommandType;
  payload: CommandPayload;
  metadata: CommandMetadata;
}

// Command acknowledgment payload
export interface CommandAckPayload {
  commandId: string;
  commandType: string;
  status: 'received' | 'executed' | 'failed';
  error?: {
    code: string;
    message: string;
  };
  result?: unknown;
  executedAt: number;
}

// Command event payload (broadcast to affected users)
export interface CommandEventPayload {
  commandId: string;
  commandType: string;
  issuer: CommandIssuer;
  timestamp: number;
  payload: CommandPayload;
  result?: unknown;
}

// Command error payload
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

// ==================== Command Payload Types ====================

// === Message Commands ===

export interface MessageDeletePayload {
  messageId: string;
  chatId: string;
  deleteForEveryone: boolean; // true = delete for all, false = only for self
}

export interface MessageEditPayload {
  messageId: string;
  chatId: string;
  content: string;
  editTimestamp: number;
  /**
   * Optional authorship claim. When present, the server uses it as an
   * additional ownership check for delivered messages (which the
   * server does not store). For pending messages, the server
   * authoritatively checks the stored `authorId`.
   */
  expectedAuthorId?: string;
}

export interface MessagePinPayload {
  messageId: string;
  chatId: string;
  pinTimestamp: number;
}

export interface MessageUnpinPayload {
  messageId: string;
  chatId: string;
}

export interface MessageReactPayload {
  messageId: string;
  chatId: string;
  emoji: string;
  add: boolean; // true = add, false = remove
  /**
   * ID пользователя, поставившего реакцию. Optional for forward-compat:
   * newer clients SHOULD omit this — the server uses the authenticated
   * issuer instead. When present, the permission layer verifies
   * `userId === issuerId` to prevent spoofing.
   */
  userId?: string;
}

export interface MessageUnreactPayload {
  messageId: string;
  chatId: string;
  emoji: string;
  userId: string; // ID пользователя, чью реакцию снимаем (должен совпадать с текущим пользователем)
}

export interface MessageReplyPayload {
  messageId: string; // ID of the reply message (new message)
  chatId: string;
  replyToMessageId: string; // ID of the original message being replied to
}

// === Chat Commands ===

export interface ChatDeletePayload {
  chatId: string;
  deleteMessages: boolean; // Whether to delete messages too
}

export interface ChatLeavePayload {
  chatId: string;
  userId: string; // Who is leaving (for group chats)
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
  mutedUntil?: string | null; // ISO timestamp or null (mute forever)
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

// === Chat Folder Commands ===

export interface FolderCreatePayload {
  name: string;
  color?: string; // HEX color
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
  moveChatsTo?: string | null; // Folder ID to move chats to, or null to delete
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

// === Participant Commands ===

export interface ParticipantAddPayload {
  chatId: string;
  userId: string;
  role?: UserRole; // Default: MEMBER
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

// === System Commands (manual) ===

export interface SystemClearChatPayload {
  chatId: string;
  clearFor: 'me' | 'everyone'; // Clear for self or for all participants
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

// === System Commands (automatic events) ===

export interface SystemParticipantJoinedPayload {
  chatId: string;
  userId: string;
  username: string;
  joinedAt: number;
  inviterId?: string; // Who invited (if via invite)
}

export interface SystemParticipantLeftPayload {
  chatId: string;
  userId: string;
  username: string;
  leftAt: number;
  reason: 'left_voluntarily' | 'removed_by_admin' | 'banned';
  removedBy?: string; // Who removed (if removed_by_admin)
}

export interface SystemRoleChangedPayload {
  chatId: string;
  userId: string;
  username: string;
  oldRole: UserRole;
  newRole: UserRole;
  changedBy: string; // Who changed the role
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

// === Device Commands ===

export interface DeviceVerificationRequestPayload {
  newDeviceId: string;      // UUID нового устройства
  newDeviceName?: string;   // Имя нового устройства (опционально)
}
