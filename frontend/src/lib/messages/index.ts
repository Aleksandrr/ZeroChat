/**
 * Messages Persistence Module
 * Provides IndexedDB storage for decrypted messages
 */

export type {
  ChatMetadata,
  ContactRecord,
  MessageAttachment,
  MessageRecord,
  StoredMessage,
  UserCacheRecord,
} from './db';
export {
  cleanupExpiredMessageRecords,
  clearAllMessages,
  clearAllContacts,
  clearAllUserCache,
  clearChatCache,
  clearStaleUserCache,
  deleteChatMessages,
  deleteChatMetadata,
  deleteChatAttachments,
  deleteContact,
  deleteMessage,
  deleteMessageRecord,
  deleteReaction,
  ensureMessagesDBReady,
  getAllChatMetadata,
  getAllContacts,
  getAllMessages,
  getChatParticipants,
  getChatMessageCount,
  getChatMessages,
  getChatMessagesPaginated,
  getChatMetadata,
  getContact,
  getLastMessagesForChats,
  getMessage,
  getMessageCount,
  getMessageRecord,
  getMessageRecordByOriginal,
  getMessagesAround,
  getOlderMessages,
  getOlderMessagesWithCursor,
  getRecentMessages,
  getReactionCounts,
  getReactionsForMessage,
  getUserCache,
  incrementUnreadCount,
  initMessagesDB,
  MESSAGE_STORES,
  pinMessage,
  resetUnreadCount,
  setUnreadCount,
  storeMessage,
  storeReaction,
  unpinMessage,
  updateMessageContent,
  // Contact operations
  addContact,
  updateContact,
  searchContacts,
  getFavoriteContacts,
  toggleContactFavorite,
  // User cache operations
  cacheChatParticipants,
  cacheMessageSender,
  // MessageRecord operations (Sesame §4.1, RC-4)
  storeMessageRecord,
  storeMessages,
  updateChatMetadata,
  updateMessageStatus,
} from './db';

// Stage 5.3.4: Attachments storage with deduplication
export type {
  CleanupResult,
  StorageInfo,
  StoredAttachment} from './attachments';
export {
  cleanupAttachments,
  deleteAttachment,
  getAttachment,
  getStorageInfo,
  hasAttachment,
  storeAttachment,
  storeAttachmentsBatch,
} from './attachments';
