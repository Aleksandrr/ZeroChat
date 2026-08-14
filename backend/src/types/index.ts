// Base types for the ZeroChat-TS backend

export interface ApiResponse<T = any> {
  success: boolean;
  message?: string;
  data?: T;
  error?: string;
  errors?: string[];
}

export interface PaginatedResponse<T> {
  success: boolean;
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface JWTPayload {
  userId: string;
  username: string;
  deviceId?: string;
  tokenId: string; // ID конкретного refresh токена
  iat?: number;
  exp?: number;
}

// Расширение типов Fastify для добавления user
declare module 'fastify' {
  interface FastifyRequest {
    user?: JWTPayload;
  }
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: string | number;
  tokenId: string;
}

export interface AuthResult {
  user: {
    id: string;
    username: string;
    displayName?: string;
    createdAt: string;
  };
  tokens: TokenPair;
  deviceId: string;
}

export interface User {
  id: string;
  username: string;
  displayName?: string;
  avatar?: string;
  status: UserStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Chat {
  id: string;
  name?: string;
  type: ChatType;
  avatar?: string;
  isGroup: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  lastMessage?: Message;
  participants?: User[];
}

export interface Message {
  id: string;
  content?: string;
  type: MessageType;
  encrypted: boolean;
  metadata?: any;
  createdAt: string;
  updatedAt: string;
  chatId: string;
  authorId: string;
  author: User;
  file?: File;
}

export interface File {
  id: string;
  filename: string;
  originalName: string;
  mimetype: string;
  size: number;
  path: string;
  encrypted: boolean;
  key?: string;
  iv?: string;
  createdAt: string;
}

export interface Device {
  id: string;
  deviceId: string;
  name: string;
  type: DeviceType;
  pushToken?: string;
  lastSeen?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  userId: string;
}

export interface ChatUser {
  id: string;
  chatId: string;
  userId: string;
  role: UserRole;
  joinedAt: string;
}

// Enums
export enum UserStatus {
  ONLINE = 'ONLINE',
  OFFLINE = 'OFFLINE',
  AWAY = 'AWAY',
  BUSY = 'BUSY',
}

export enum ChatType {
  PRIVATE = 'PRIVATE',
  GROUP = 'GROUP',
  CHANNEL = 'CHANNEL',
  SYSTEM = 'SYSTEM',
  FAVORITES = 'FAVORITES',
}

export enum MessageType {
  TEXT = 'TEXT',
  IMAGE = 'IMAGE',
  FILE = 'FILE',
  AUDIO = 'AUDIO',
  VIDEO = 'VIDEO',
  SYSTEM = 'SYSTEM',
}

export enum HistoryAccess {
  ALL = 'ALL',
  FROM_NOW = 'FROM_NOW',
  NONE = 'NONE',
}

export enum UserRole {
  OWNER = 'OWNER',
  ADMIN = 'ADMIN',
  MODERATOR = 'MODERATOR',
  MEMBER = 'MEMBER',
}

export enum DeviceType {
  DESKTOP = 'DESKTOP',
  MOBILE = 'MOBILE',
  TABLET = 'TABLET',
  WEB = 'WEB',
}

// WebSocket message types
export interface WebSocketMessage {
  type: string;
  data?: any;
  timestamp: string;
  clientId?: string;
}

export interface ChatWebSocketMessage extends WebSocketMessage {
  type: 'chat';
  message: string;
  chatId: string;
}

export interface AuthWebSocketMessage extends WebSocketMessage {
  type: 'auth';
  token: string;
}

export interface PingWebSocketMessage extends WebSocketMessage {
  type: 'ping';
}

export interface PongWebSocketMessage extends WebSocketMessage {
  type: 'pong';
}

// Form types
export interface RegisterForm {
  username: string;
  displayName?: string;
  password: string;
  confirmPassword: string;
}

export interface LoginForm {
  username: string;
  password: string;
  rememberMe: boolean;
}

export interface CreateChatForm {
  name: string;
  type: ChatType;
  participants?: string[];
}

export interface SendMessageForm {
  content?: string;
  type: MessageType;
  chatId: string;
  file?: File;
}

// ==================== Message Metadata Types ====================

/**
 * Metadata for message attachments and additional properties
 * Stored as JSON in the database metadata field
 */
export interface MessageMetadata {
  hasAttachments?: boolean;
  attachmentSizes?: number[];
  totalAttachmentSize?: number;
}

// ==================== Mark-as-Read Types ====================

export interface MarkAsReadRequest {
  messageIds?: string[]; // Optional: specific messages. If omitted, all unread in chat
}

export interface MarkAsReadResponse {
  success: boolean;
  data: {
    markedCount: number;      // Number of messages marked as read
    chatId: string;
    readAt: string;           // ISO timestamp
    messageIds: string[];     // IDs of marked messages
  };
}

export interface ReadStatusInfo {
  messageId: string;
  userId: string;
  readAt: Date;
}

export interface UnreadCountResponse {
  chatId: string;
  unreadCount: number;
}

export interface ChatUserReadStatus {
  chatId: string;
  userId: string;
  lastReadAt?: Date;
  unreadCount: number;
}

// ==================== Sync Types ====================

/**
 * Vector clock for causal ordering of sync events
 * Maps device_id -> highest seen seq from that device
 */
export interface VectorClock {
  [deviceId: string]: number;
}

/**
 * Incoming sync event from client (for push)
 */
export interface IncomingSyncEvent {
  event_id: string;      // UUID
  entity: string;        // 'chat' | 'message' | 'settings' | 'device'
  entity_id: string;     // ID of the entity
  op: string;            // 'upsert' | 'delete' | 'tombstone'
  version: number;       // Version for conflict resolution
  payload: string;       // Base64 encrypted payload
  device_id: string;     // Sender device ID
  seq: number;           // Sequence number (vector clock)
}

/**
 * Sync event stored in database
 */
export interface SyncEvent {
  id: string;
  userId: string;
  deviceId: string;
  seq: number;
  entity: string;
  entityId: string;
  op: 'upsert' | 'delete' | 'tombstone';
  version: number;
  payloadCiphertext: string;
  serverReceivedAt: Date;
}

/**
 * Request for push endpoint
 */
export interface SyncPushRequest {
  events: IncomingSyncEvent[];
}

/**
 * Response from push endpoint
 */
export interface SyncPushResponse {
  accepted: string[];      // Accepted event_ids
  rejected: Array<{
    event_id: string;
    reason: string;
  }>;
}

/**
 * Request for pull endpoint
 */
export interface SyncPullRequest {
  vector_clock: VectorClock;
}

/**
 * Response from pull endpoint
 */
export interface SyncPullResponse {
  events: Array<{
    event_id: string;
    user_id: string;
    device_id: string;
    seq: number;
    entity: string;
    entity_id: string;
    op: string;
    version: number;
    payload: string;       // Base64 encrypted
    server_received_at: string;
  }>;
  server_vector_clock: VectorClock;
}

/**
 * Full sync request (push + pull combined)
 */
export interface SyncRequest {
  vectorClock: VectorClock;
  events?: IncomingSyncEvent[];
}

/**
 * Full sync response
 */
export interface SyncResponse {
  success: boolean;
  vectorClock: VectorClock;
  events: SyncEvent[];
}

// ==================== Group Chat Types ====================

export interface CreateGroupRequest {
  name: string;
  participants: string[]; // usernames
  requireApproval?: boolean;
  historyAccess?: HistoryAccess;
  avatar?: string;
}

export interface GroupInfo {
  id: string;
  name: string;
  avatar?: string;
  isGroup: boolean;
  requireApproval: boolean;
  historyAccess: HistoryAccess;
  createdAt: string;
  createdBy: {
    id: string;
    username: string;
  };
  participants: GroupParticipant[];
  inviteCode?: string;
  inviteCodeExpiresAt?: string;
}

export interface GroupParticipant {
  userId: string;
  username: string;
  displayName?: string;
  avatar?: string;
  role: UserRole;
  joinedAt: string;
}

export interface AddParticipantRequest {
  usernames: string[]; // usernames to add
}

export interface UpdateParticipantRoleRequest {
  role: UserRole;
}

export interface CreateInviteLinkResponse {
  success: boolean;
  data: {
    chatId: string;
    inviteCode: string;
    expiresAt?: string;
    inviteUrl: string;
  };
}

export interface JoinByInviteResponse {
  success: boolean;
  data: {
    chatId: string;
    chatName: string;
    isNewChat: boolean;
  };
}

export interface LeaveGroupResponse {
  success: boolean;
  message: string;
}