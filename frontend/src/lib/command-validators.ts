/**
 * Command Validators - Zod schemas for validating command payloads
 * Ensures type safety and data integrity before sending commands
 */

import { z } from 'zod';
import type { MessageUnreactPayload } from '@/types';

// ==================== Base Schemas ====================

// UUID v4 format. Rejects obviously-invalid strings like 'not-a-uuid'.
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const idSchema = z.string().min(1, 'ID cannot be empty').regex(UUID_REGEX, 'Invalid UUID');
const nonEmptyStringSchema = z.string().min(1, 'String cannot be empty');
const timestampSchema = z.number().int().positive('Timestamp must be positive integer');
const userIdSchema = idSchema;
const chatIdSchema = idSchema;
const messageIdSchema = idSchema;
const deviceIdSchema = z.string().min(1, 'Device ID required'); // Device IDs can be non-UUID strings
const signalDeviceIdSchema = z.number().int().min(1).max(127);
const userRoleSchema = z.enum(['OWNER', 'ADMIN', 'MODERATOR', 'MEMBER']);

// ==================== Command Metadata Schema ====================

export const CommandMetadataSchema = z.object({
  version: z.number().int().positive(),
  issuer: z.object({
    userId: userIdSchema,
    deviceId: deviceIdSchema,
    signalDeviceId: signalDeviceIdSchema.optional(),
  }),
  priority: z.enum(['low', 'normal', 'high', 'critical']),
  encrypted: z.boolean().optional(),
  createdAt: timestampSchema,
});

// ==================== Message Payload Schemas ====================

export const MessageDeletePayloadSchema = z.object({
  messageId: messageIdSchema,
  chatId: chatIdSchema,
  deleteForEveryone: z.boolean(),
});

export const MessageEditPayloadSchema = z.object({
  messageId: messageIdSchema,
  chatId: chatIdSchema,
  content: nonEmptyStringSchema.max(10000, 'Message content too long'),
  editTimestamp: timestampSchema,
});

export const MessagePinPayloadSchema = z.object({
  messageId: messageIdSchema,
  chatId: chatIdSchema,
  pinTimestamp: timestampSchema,
});

export const MessageUnpinPayloadSchema = z.object({
  messageId: messageIdSchema,
  chatId: chatIdSchema,
});

export const MessageReactPayloadSchema = z.object({
  messageId: messageIdSchema,
  chatId: chatIdSchema,
  emoji: z.string().min(1, 'Emoji required'),
  add: z.boolean(),
  userId: userIdSchema, // ID пользователя, поставившего реакцию
});

export const MessageUnreactPayloadSchema = z.object({
  messageId: messageIdSchema,
  chatId: chatIdSchema,
  emoji: z.string().min(1, 'Emoji required'),
  userId: userIdSchema, // ID пользователя, чью реакцию снимаем (должен совпадать с текущим пользователем)
});

export const MessageReplyPayloadSchema = z.object({
  messageId: messageIdSchema,
  chatId: chatIdSchema,
  replyToMessageId: messageIdSchema,
});

// ==================== Chat Payload Schemas ====================

export const ChatDeletePayloadSchema = z.object({
  chatId: chatIdSchema,
  deleteMessages: z.boolean(),
});

export const ChatLeavePayloadSchema = z.object({
  chatId: chatIdSchema,
  userId: userIdSchema,
});

export const ChatUpdatePayloadSchema = z.object({
  chatId: chatIdSchema,
  updates: z.object({
    name: nonEmptyStringSchema.optional(),
    avatar: z.string().url().optional().or(z.literal('')),
    description: z.string().optional(),
  }),
});

export const ChatMutePayloadSchema = z.object({
  chatId: chatIdSchema,
  mutedUntil: z.string().datetime().optional().or(z.null()),
});

export const ChatUnmutePayloadSchema = z.object({
  chatId: chatIdSchema,
});

export const ChatPinPayloadSchema = z.object({
  chatId: chatIdSchema,
});

export const ChatUnpinPayloadSchema = z.object({
  chatId: chatIdSchema,
});

export const ChatArchivePayloadSchema = z.object({
  chatId: chatIdSchema,
});

export const ChatUnarchivePayloadSchema = z.object({
  chatId: chatIdSchema,
});

// ==================== Folder Payload Schemas ====================

export const FolderCreatePayloadSchema = z.object({
  name: nonEmptyStringSchema,
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Invalid HEX color').optional(),
  order: z.number().int().nonnegative(),
});

export const FolderUpdatePayloadSchema = z.object({
  folderId: idSchema,
  updates: z.object({
    name: nonEmptyStringSchema.optional(),
    color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Invalid HEX color').optional(),
    order: z.number().int().nonnegative().optional(),
  }).refine(data => Object.keys(data).length > 0, 'At least one field must be provided'),
});

export const FolderDeletePayloadSchema = z.object({
  folderId: idSchema,
  moveChatsTo: z.string().min(1).optional().or(z.null()),
});

export const FolderAddChatPayloadSchema = z.object({
  folderId: idSchema,
  chatId: chatIdSchema,
});

export const FolderRemoveChatPayloadSchema = z.object({
  folderId: idSchema,
  chatId: chatIdSchema,
});

export const FolderReorderPayloadSchema = z.object({
  folderId: idSchema,
  newOrder: z.number().int().nonnegative(),
});

// ==================== Participant Payload Schemas ====================

export const ParticipantAddPayloadSchema = z.object({
  chatId: chatIdSchema,
  userId: userIdSchema,
  role: userRoleSchema.optional(),
});

export const ParticipantRemovePayloadSchema = z.object({
  chatId: chatIdSchema,
  userId: userIdSchema,
});

export const ParticipantRoleUpdatePayloadSchema = z.object({
  chatId: chatIdSchema,
  userId: userIdSchema,
  newRole: userRoleSchema,
});

// ==================== System Payload Schemas ====================

export const SystemClearChatPayloadSchema = z.object({
  chatId: chatIdSchema,
  clearFor: z.enum(['me', 'everyone']),
});

export const SystemExportChatPayloadSchema = z.object({
  chatId: chatIdSchema,
  format: z.enum(['json', 'txt', 'pdf']),
  includeMedia: z.boolean().optional(),
});

export const SystemReportMessagePayloadSchema = z.object({
  messageId: messageIdSchema,
  chatId: chatIdSchema,
  reason: z.enum(['spam', 'abuse', 'inappropriate', 'other']),
  description: z.string().optional(),
});

// ==================== System Event Payload Schemas (auto) ====================

export const SystemParticipantJoinedPayloadSchema = z.object({
  chatId: chatIdSchema,
  userId: userIdSchema,
  username: nonEmptyStringSchema,
  joinedAt: timestampSchema,
  inviterId: userIdSchema.optional(),
});

export const SystemParticipantLeftPayloadSchema = z.object({
  chatId: chatIdSchema,
  userId: userIdSchema,
  leftAt: timestampSchema,
});

export const SystemRoleChangedPayloadSchema = z.object({
  chatId: chatIdSchema,
  userId: userIdSchema,
  newRole: userRoleSchema,
  changedAt: timestampSchema,
  changedById: userIdSchema,
});

export const SystemChatCreatedPayloadSchema = z.object({
  chatId: chatIdSchema,
  createdAt: timestampSchema,
});

// ==================== Device Payload Schemas ====================

export const DeviceVerificationRequestPayloadSchema = z.object({
  newDeviceId: deviceIdSchema,
  newDeviceName: nonEmptyStringSchema,
});


// ==================== Command Type Enum ====================

export const CommandTypeEnum = [
  // Messages
  'message.delete',
  'message.edit',
  'message.pin',
  'message.unpin',
  'message.react',
  'message.unreact',
  'message.reply',
  // Chats
  'chat.delete',
  'chat.leave',
  'chat.update',
  'chat.mute',
  'chat.unmute',
  'chat.pin',
  'chat.unpin',
  'chat.archive',
  'chat.unarchive',
  // Folders
  'folder.create',
  'folder.update',
  'folder.delete',
  'folder.add_chat',
  'folder.remove_chat',
  'folder.reorder',
  // Participants
  'participant.add',
  'participant.remove',
  'participant.role_update',
  // System (manual)
  'system.clear_chat',
  'system.export_chat',
  'system.report_message',
  // System (auto)
  'system.participant_joined',
  'system.participant_left',
  'system.role_changed',
  'system.chat_created',
  // Devices
  'device.verification_request',
] as const;

export type CommandType = (typeof CommandTypeEnum)[number];

export const CommandPriorityEnum = ['low', 'normal', 'high', 'critical'] as const;
export type CommandPriority = (typeof CommandPriorityEnum)[number];

export const CommandAckStatusEnum = ['received', 'executed', 'failed'] as const;
export type CommandAckStatus = (typeof CommandAckStatusEnum)[number];

// ==================== Union Schema for all payloads ====================

export const CommandPayloadSchema = z.union([
  // Messages
  MessageDeletePayloadSchema,
  MessageEditPayloadSchema,
  MessagePinPayloadSchema,
  MessageReactPayloadSchema,
  MessageUnreactPayloadSchema,
  MessageReplyPayloadSchema,
  // Chats
  ChatDeletePayloadSchema,
  ChatLeavePayloadSchema,
  ChatUpdatePayloadSchema,
  ChatMutePayloadSchema,
  ChatUnmutePayloadSchema,
  ChatPinPayloadSchema,
  ChatUnpinPayloadSchema,
  ChatArchivePayloadSchema,
  ChatUnarchivePayloadSchema,
  // Folders
  FolderCreatePayloadSchema,
  FolderUpdatePayloadSchema,
  FolderDeletePayloadSchema,
  FolderAddChatPayloadSchema,
  FolderRemoveChatPayloadSchema,
  FolderReorderPayloadSchema,
  // Participants
  ParticipantAddPayloadSchema,
  ParticipantRemovePayloadSchema,
  ParticipantRoleUpdatePayloadSchema,
  // System (manual)
  SystemClearChatPayloadSchema,
  SystemExportChatPayloadSchema,
  SystemReportMessagePayloadSchema,
  // System (auto)
  SystemParticipantJoinedPayloadSchema,
  SystemParticipantLeftPayloadSchema,
  SystemRoleChangedPayloadSchema,
  SystemChatCreatedPayloadSchema,
  // Devices
  DeviceVerificationRequestPayloadSchema,
]);

// Full Command Message Schema
export const CommandMessageSchema = z.object({
  commandId: idSchema,
  command: z.enum(CommandTypeEnum),
  payload: CommandPayloadSchema,
  metadata: CommandMetadataSchema,
});

// ==================== Validation Functions ====================

/**
 * Validate a command payload based on command type
 */
export function validateCommandPayload(
  command: CommandType,
  payload: unknown
): Record<string, unknown> {
  // Find the appropriate schema based on command type
  const schemaMap: Record<CommandType, z.ZodType<Record<string, unknown>>> = {
    // Messages
    'message.delete': MessageDeletePayloadSchema,
    'message.edit': MessageEditPayloadSchema,
    'message.pin': MessagePinPayloadSchema,
    'message.unpin': MessageUnpinPayloadSchema,
    'message.react': MessageReactPayloadSchema,
    'message.unreact': MessageUnreactPayloadSchema,
    'message.reply': MessageReplyPayloadSchema,
    // Chats
    'chat.delete': ChatDeletePayloadSchema,
    'chat.leave': ChatLeavePayloadSchema,
    'chat.update': ChatUpdatePayloadSchema,
    'chat.mute': ChatMutePayloadSchema,
    'chat.unmute': ChatUnmutePayloadSchema,
    'chat.pin': ChatPinPayloadSchema,
    'chat.unpin': ChatUnpinPayloadSchema,
    'chat.archive': ChatArchivePayloadSchema,
    'chat.unarchive': ChatUnarchivePayloadSchema,
    // Folders
    'folder.create': FolderCreatePayloadSchema,
    'folder.update': FolderUpdatePayloadSchema,
    'folder.delete': FolderDeletePayloadSchema,
    'folder.add_chat': FolderAddChatPayloadSchema,
    'folder.remove_chat': FolderRemoveChatPayloadSchema,
    'folder.reorder': FolderReorderPayloadSchema,
    // Participants
    'participant.add': ParticipantAddPayloadSchema,
    'participant.remove': ParticipantRemovePayloadSchema,
    'participant.role_update': ParticipantRoleUpdatePayloadSchema,
    // System (manual)
    'system.clear_chat': SystemClearChatPayloadSchema,
    'system.export_chat': SystemExportChatPayloadSchema,
    'system.report_message': SystemReportMessagePayloadSchema,
    // System (auto)
    'system.participant_joined': SystemParticipantJoinedPayloadSchema,
    'system.participant_left': SystemParticipantLeftPayloadSchema,
    'system.role_changed': SystemRoleChangedPayloadSchema,
    'system.chat_created': SystemChatCreatedPayloadSchema,
    // Devices
    'device.verification_request': DeviceVerificationRequestPayloadSchema,
  };

  const schema = schemaMap[command];
  if (!schema) {
    throw new Error(`Unknown command type: ${command}`);
  }

  return schema.parse(payload);
}

/**
 * Validate full command message
 */
export function validateCommandMessage(data: unknown): z.infer<typeof CommandMessageSchema> {
  return CommandMessageSchema.parse(data);
}

/**
 * Generate command metadata
 */
export function createCommandMetadata(
  userId: string,
  deviceId: string,
  signalDeviceId?: number,
  priority: CommandPriority = 'normal',
  encrypted: boolean = false
): z.infer<typeof CommandMetadataSchema> {
  return {
    version: 1,
    issuer: {
      userId,
      deviceId,
      signalDeviceId,
    },
    priority,
    encrypted,
    createdAt: Date.now(),
  };
}
