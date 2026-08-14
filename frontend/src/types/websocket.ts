/**
 * WebSocket Message Types for ZeroChat-TS
 * Defines message formats for real-time communication
 */

// ==================== Base Types ====================

export interface WSMessage {
  type: WSMessageType;
  payload: unknown;
  timestamp: number;
  messageId: string;
}

export type WSMessageType =
  | 'handshake'
  | 'message'
  | 'ack'
  | 'typing'
  | 'presence'
  | 'ping'
  | 'pong'
  | 'error'
  | 'session_sync'
  | 'message_retry'
  | 'mark_read'
  | 'read'
  | 'read_ack'
  | 'multi_message'  // Multi-device message (Sesame protocol)
  // Favorites/Saved messages
  | 'favorites_message'      // Saved messages to self (multi-device)
  | 'favorites_ack'          // Acknowledgment for favorites message
  // P2P Multi-device sync
  | 'sync_request'    // Request history from active device
  | 'sync_history'    // Encrypted history response
  | 'sync_ack'        // Acknowledgment of sync completion
  | 'device_online'   // Notification about new device online
  | 'ready'           // Client is ready to receive pending messages
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
  | 'sender_key_distribution_message';  // Sender Key distribution message (SKDM)

// ==================== Client → Server Messages ====================

// Handshake - WebSocket authentication
export interface WSHandshakePayload {
  token: string;
  deviceId?: number;
  platform?: string;
}

export interface WSHandshake extends WSMessage {
  type: 'handshake';
  payload: WSHandshakePayload;
}

// Message - Send encrypted message
export interface WSMessagePayload {
  chatId: string;
  content: string;  // Base64 encoded encrypted content
  recipientId: string;
  messageType: number;  // Signal message type (2=SignalMessage, 3=PreKeySignalMessage)
  replyTo?: string;
  attachments?: WSAttachment[];
}

export interface WSAttachment {
  id: string;
  type: 'image' | 'file' | 'audio' | 'video';
  fileName: string;
  size: number;
  mimeType: string;
  data: string; // Base64 encrypted data
  contentHash: string; // SHA-256 hash for deduplication
}

export interface WSChatMessage extends WSMessage {
  type: 'message';
  payload: WSMessagePayload;
}

// Multi-Device Message Types (Sesame protocol)
// Each device gets its own encrypted copy
export interface WSEncryptedMessageForDevice {
  deviceId: number;        // Signal device ID (1-127)
  content: string;         // Base64 encrypted content for this device
  messageType: number;     // 2 = SignalMessage, 3 = PreKeyMessage
}

export interface WSMultiDeviceMessagePayload {
  chatId: string;
  recipientId: string;                              // Recipient user ID
  recipientMessages: WSEncryptedMessageForDevice[]; // Encrypted for each recipient device
  senderMessages?: WSEncryptedMessageForDevice[];   // Encrypted for sender's other devices (self-delivery)
  replyTo?: string;
  attachments?: WSAttachment[];
  metadata?: Record<string, any>; // Optional metadata (e.g., forwardedFrom)
  messageId: string; // Client-generated UUID for consistent message identification
}

export interface WSMultiDeviceMessage extends WSMessage {
  type: 'multi_message';
  payload: WSMultiDeviceMessagePayload;
}

// ACK - Acknowledgment of message receipt
export interface WSAckPayload {
  messageId: string;
  chatId?: string;
}

export interface WSAck extends WSMessage {
  type: 'ack';
  payload: WSAckPayload;
}

// Typing - Typing indicator
export interface WSTypingPayload {
  chatId: string;
  isTyping: boolean;
}

export interface WSTyping extends WSMessage {
  type: 'typing';
  payload: WSTypingPayload;
}

// Presence - Online/offline status
export interface WSPresencePayload {
  userId?: string;
  status: 'online' | 'offline' | 'away';
}

export interface WSPresence extends WSMessage {
  type: 'presence';
  payload: WSPresencePayload;
}

// ==================== Server → Client Messages ====================

// Delivered - Message delivered confirmation
export interface WSDeliveredPayload {
  messageId: string;
  chatId: string;
  deliveredAt: number;
}

export interface WSDelivered extends WSMessage {
  type: 'ack';
  payload: WSDeliveredPayload;
}

// Read - Message read confirmation
export interface WSReadPayload {
  messageId: string;
  chatId: string;
  readAt: number;
}

export interface WSRead extends WSMessage {
  type: 'ack';
  payload: WSReadPayload;
}

// Incoming message
export interface WSIncomingMessagePayload {
  chatId: string;
  content: string;
  senderId: string;
  senderDeviceId: number;
  messageId: string;
  timestamp: number;
  type: number;  // Signal message type (PreKey, Signal, SenderKey)
  replyTo?: string;
  attachments?: WSAttachment[];
}

export interface WSIncomingMessage extends WSMessage {
  type: 'message';
  payload: WSIncomingMessagePayload;
}

// Typing indicator from other users
export interface WSTypingIndicatorPayload {
  chatId: string;
  userId: string;
  isTyping: boolean;
}

export interface WSTypingIndicator extends WSMessage {
  type: 'typing';
  payload: WSTypingIndicatorPayload;
}

// Presence update from server
export interface WSPresenceUpdatePayload {
  userId: string;
  status: 'online' | 'offline' | 'away';
  lastSeen?: string;
}

export interface WSPresenceUpdate extends WSMessage {
  type: 'presence';
  payload: WSPresenceUpdatePayload;
}

// Error
export interface WSErrorPayload {
  code: number;
  message: string;
  details?: unknown;
}

export interface WSError extends WSMessage {
  type: 'error';
  payload: WSErrorPayload;
}

// Pong response
export interface WSPongPayload {
  latency: number;
}

export interface WSPong extends WSMessage {
  type: 'pong';
  payload: WSPongPayload;
}

// Session Sync - Notify other party about session state change (for retry handling)
export interface WSSessionSyncPayload {
  userId: string;
  deviceId: number;
  reason: 'session_refresh' | 'new_device' | 'retry_request';
}

export interface WSSessionSync extends WSMessage {
  type: 'session_sync';
  payload: WSSessionSyncPayload;
}

// Message Retry Request - Request sender to resend message with fresh session
export interface WSMessageRetryRequestPayload {
  originalMessageId: string;
  chatId: string;
  senderId: string;
  senderDeviceId: number;
  reason: 'decryption_failed';
}

export interface WSMessageRetryRequest extends WSMessage {
  type: 'message_retry';
  payload: WSMessageRetryRequestPayload;
}

// ==================== Mark as Read Types ====================

// Mark Read - Client requests to mark messages as read
export interface WSMarkReadPayload {
  chatId: string;
  messageIds?: string[];  // Optional: specific messages. If omitted, all unread in chat
}

export interface WSMarkRead extends WSMessage {
  type: 'mark_read';
  payload: WSMarkReadPayload;
}

// Read - Server notifies message author that messages were read
export interface WSReadEventPayload {
  chatId: string;
  readBy: string;        // userId who read the messages
  readAt: string;        // ISO timestamp
  messageIds: string[];  // Which messages were read
}

export interface WSReadEvent extends WSMessage {
  type: 'read';
  payload: WSReadEventPayload;
}

// Read Ack - Server acknowledges mark_read request
export interface WSReadAckPayload {
  chatId: string;
  markedCount: number;   // Number of messages marked as read
  readAt: string;        // ISO timestamp
  messageIds?: string[]; // IDs of marked messages (optional)
}

export interface WSReadAck extends WSMessage {
  type: 'read_ack';
  payload: WSReadAckPayload;
}

// ==================== Union Types ====================

export type ClientWSMessage = WSHandshake | WSChatMessage | WSAck | WSTyping | WSPresence | WSSessionSync | WSMessageRetryRequest | WSMarkRead;

export type ServerWSMessage = 
  | WSDelivered 
  | WSRead 
  | WSIncomingMessage 
  | WSTypingIndicator 
  | WSPresenceUpdate 
  | WSError 
  | WSPong
  | WSReadEvent
  | WSReadAck;

// ==================== Utility Functions ====================

export function createWSMessage<T extends WSMessageType>(
  type: T,
  payload: any
): WSMessage {
  return {
    type,
    payload,
    timestamp: Date.now(),
    messageId: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
  };
}

export function isWSMessageType(value: string): value is WSMessageType {
  return [
    'handshake',
    'message',
    'ack',
    'typing',
    'presence',
    'ping',
    'pong',
    'error',
    'session_sync',
    'message_retry',
    'mark_read',
    'read',
    'read_ack',
    'multi_message',
    'sync_request',
    'sync_history',
    'sync_ack',
    'device_online',
    'ready',
    'sync_invite',
    'sync_accept',
    'sync_cancel',
    'sync_reject',
    'group_message',
    'group_key_update',
    'group_sync',
    'group_message_ack',
  ].includes(value);
}

// ==================== P2P Multi-Device Sync Types ====================

// Vector Clock for causal ordering of events
export type VectorClock = Record<string, number>; // device_id -> sequence number

// Client -> Server: Request history from active device (new device sends this)
export interface WSSyncRequestPayload {
  requestingDeviceId: string;      // UUID of the requesting device
  requestingSignalDeviceId?: number; // Signal Protocol device ID (1-127) for encryption
  vectorClock: VectorClock;        // Current vector clock of the requesting device
  targetDeviceId?: string;         // For two-phase sync: specific device to request from
  requestingDeviceName?: string;   // Human-readable device name (from server)
}

export interface WSSyncRequest extends WSMessage {
  type: 'sync_request';
  payload: WSSyncRequestPayload;
}

// Client -> Server: Encrypted history response (active device sends this)
export interface WSSyncHistoryPayload {
  targetDeviceId: string;         // UUID of the target device to receive history
  senderDeviceId: string;         // UUID of the device sending history
  senderSignalDeviceId?: number;  // Signal Protocol device ID (1-127) for decryption
  encryptedHistory: string;       // Base64 encrypted history payload
  vectorClock: VectorClock;       // Updated vector clock after this sync
}

export interface WSSyncHistory extends WSMessage {
  type: 'sync_history';
  payload: WSSyncHistoryPayload;
}

// Client -> Server: Acknowledgment of sync completion
export interface WSSyncAckPayload {
  deviceId: string;            // UUID of the device acknowledging sync
  newVectorClock: VectorClock; // New vector clock after applying history
}

export interface WSSyncAck extends WSMessage {
  type: 'sync_ack';
  payload: WSSyncAckPayload;
}

// Server -> Client: Notification about device coming online
export interface WSDeviceOnlinePayload {
  userId: string;
  deviceId: string;           // UUID of the device that came online
  signalDeviceId: number;     // Signal Protocol device ID (1-127)
  deviceName?: string;        // Human-readable device name
}

export interface WSDeviceOnline extends WSMessage {
  type: 'device_online';
  payload: WSDeviceOnlinePayload;
}

// Encrypted history payload structure (for reference, not transmitted as-is)
// This is what gets encrypted inside encryptedHistory field
export interface WSEncryptedHistoryPayload {
  messages: {
    chatId: string;
    senderId: string;
    senderDeviceId: number;
    content: string;          // Already encrypted message content
    messageId: string;
    timestamp: number;
    messageType: number;
  }[];
  vectorClock: VectorClock;
}

// ==================== Two-Phase P2P Sync Types ====================

// Client -> Server: New device invites existing devices to sync
// Server forwards to all online devices of the same user
export interface WSSyncInvitePayload {
  invitingDeviceId: string;      // UUID of the new device requesting sync
  invitingDeviceName?: string;   // Human-readable device name (for UI)
  timestamp: number;             // When the invite was created
}

export interface WSSyncInvite extends WSMessage {
  type: 'sync_invite';
  payload: WSSyncInvitePayload;
}

// Client -> Server: Existing device accepts sync request
// Server forwards to the inviting device and sends sync_cancel to others
export interface WSSyncAcceptPayload {
  acceptingDeviceId: string;     // UUID of the device that will send history
  targetDeviceId: string;        // UUID of the new device (invite sender)
  timestamp: number;             // When the accept was created
}

export interface WSSyncAccept extends WSMessage {
  type: 'sync_accept';
  payload: WSSyncAcceptPayload;
}

// Server -> Client: Cancel sync invite
// Sent to all devices except the one that accepted
export interface WSSyncCancelPayload {
  invitingDeviceId: string;      // UUID of the device that sent the invite
  acceptedByDeviceId: string;    // UUID of the device that accepted
  reason: 'accepted' | 'timeout' | 'rejected' | 'no_devices';
}

export interface WSSyncCancel extends WSMessage {
  type: 'sync_cancel';
  payload: WSSyncCancelPayload;
}

// Client -> Server: Explicit rejection of sync request (optional)
export interface WSSyncRejectPayload {
  rejectingDeviceId: string;     // UUID of the device rejecting
  targetDeviceId: string;        // UUID of the inviting device
  timestamp: number;
}

export interface WSSyncReject extends WSMessage {
  type: 'sync_reject';
  payload: WSSyncRejectPayload;
}

// ==================== Group Chat Message Types ====================

/**
 * Client -> Server: Send encrypted group message (Sender Key)
 * The message is encrypted with Sender Key and broadcast to all group members
 */
export interface WSGroupMessagePayload {
  chatId: string;                    // Group chat ID
  senderUserId: string;              // Sender's user ID
  senderDeviceId: string;           // Sender's device UUID
  content: string;                   // Base64 encrypted message content (Sender Key)
  messageId: string;                 // Unique message ID
  senderKeyId?: string;              // Optional: which sender key was used
  replyTo?: string;                  // Optional: message being replied to
  attachments?: WSAttachment[];     // Optional: attachments
  metadata?: Record<string, any>;    // Optional metadata (e.g., forwardedFrom)
}

export interface WSGroupMessage extends WSMessage {
  type: 'group_message';
  payload: WSGroupMessagePayload;
}

/**
 * Server -> Client: Incoming encrypted group message
 */
export interface WSGroupMessageIncomingPayload {
  chatId: string;
  content: string;                   // Base64 encrypted message content
  senderUserId: string;
  senderDeviceId: string;
  messageId: string;
  timestamp: number;
  senderKeyId?: string;
  replyTo?: string;
  attachments?: WSAttachment[];
  senderKeyDistribution?: string;   // Base64-encoded SKDM from sender
  unreadCount?: number;             // From backend - source of truth
  isPending?: boolean;              // Flag for pending/offline messages
  isSelfDelivery?: boolean;         // Flag for self-delivery (sender's other devices)
  metadata?: Record<string, any>;    // Optional metadata (e.g., forwardedFrom)
}

export interface WSGroupMessageIncoming extends WSMessage {
  type: 'group_message';
  payload: WSGroupMessageIncomingPayload;
}

/**
 * Client -> Server: Request to update Sender Key
 * Sent when: member leaves/joins, group admin changes
 */
export interface WSGroupKeyUpdateRequestPayload {
  chatId: string;                    // Group chat ID
  requestingUserId: string;          // User requesting the update
  requestingDeviceId: string;        // Device requesting the update
  reason: 'member_joined' | 'member_left' | 'admin_changed' | 'manual_request';
}

export interface WSGroupKeyUpdateRequest extends WSMessage {
  type: 'group_key_update';
  payload: WSGroupKeyUpdateRequestPayload;
}

/**
 * Server -> Client: Sender Key has been updated
 * All group members receive this notification
 */
export interface WSGroupKeyUpdatePayload {
  chatId: string;
  senderUserId: string;              // Who generated the new key
  senderDeviceId: string;             // Which device generated the key
  senderKeyId: string;                // New sender key ID
  senderKey: string;                  // Base64 encoded Sender Key material (encrypted for each member)
  reason: 'member_joined' | 'member_left' | 'admin_changed';
}

export interface WSGroupKeyUpdate extends WSMessage {
  type: 'group_key_update';
  payload: WSGroupKeyUpdatePayload;
}

/**
 * Client -> Server: Sync Sender Keys between user's own devices
 * Used for multi-device sync of group Sender Keys
 */
export interface WSGroupSyncPayload {
  chatId: string;                    // Group chat ID
  senderUserId: string;              // User whose keys these are
  senderKeyId: string;               // Sender key ID
  senderKey: string;                 // Base64 encoded Sender Key material
  senderKeySignature?: string;       // Optional: signature of sender key
}

export interface WSGroupSync extends WSMessage {
  type: 'group_sync';
  payload: WSGroupSyncPayload;
}

/**
 * Server -> Client: Acknowledge group message receipt
 */
export interface WSGroupMessageAckPayload {
  messageId: string;
  chatId: string;
  status: 'received' | 'delivered';
}

export interface WSGroupMessageAck extends WSMessage {
  type: 'group_message_ack';
  payload: WSGroupMessageAckPayload;
}

/**
 * Client <-> Server: Sender Key Distribution Message (SKDM)
 * Used to distribute Sender Key material to new group members
 */
export interface WSSenderKeyDistributionPayload {
  chatId: string;                      // Group chat ID
  senderUserId: string;                // User who owns the Sender Key
  senderDeviceId: number;              // Device that generated the distribution
  receiverUserId: string;              // Target user receiving the SKDM
  receiverDeviceId: number;            // Target device receiving the SKDM
  distributionId: string;              // Unique ID for this distribution
  message: string;                     // Base64 encoded encrypted SKDM
}

export interface WSSenderKeyDistributionMessage extends WSMessage {
  type: 'sender_key_distribution_message';
  payload: WSSenderKeyDistributionPayload;
}
