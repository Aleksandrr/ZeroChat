/**
 * Chat Components - Index file for all chat-related components
 */

export { ChatHeader } from './ChatHeader';
export { ChatLayout } from './ChatLayout';
export { ChatMessages } from './ChatMessages';
export { GroupChatCreateDialog } from './GroupChatCreateDialog';
export { GroupChatInfo } from './GroupChatInfo';
export { GroupEditDialog } from './GroupEditDialog';
export { GroupMemberItem } from './GroupMemberItem';
export { MessageBubble } from './MessageBubble';
export { MessageInput } from './MessageInput';
export { NewChatDialog } from './NewChatDialog';

// File sharing components
export { AttachmentPreview, AttachmentPreviewList } from './AttachmentPreview';
export { FileSendDialog } from './FileSendDialog';
export { MessageAttachment, MessageAttachments } from './MessageAttachment';

// Re-export types
export type { FileUploadItem, UseFileUploadOptions, UseFileUploadResult } from '@/hooks/useFileUpload';
