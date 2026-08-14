/**
 * IndexedDB Storage for Decrypted Messages
 * Persists plaintext messages locally for offline access
 */

// Database configuration
const MESSAGES_DB_NAME = 'ZeroChatMessagesDB';
const MESSAGES_DB_VERSION = 5; // Bumped for contacts and user_cache stores

// Store names
export const MESSAGE_STORES = {
  MESSAGES: 'messages',
  CHAT_METADATA: 'chatMetadata',
  MESSAGE_RECORDS: 'messageRecords', // For Sesame retry (RC-4)
  ATTACHMENTS: 'attachments', // For file deduplication (Stage 5.3.4)
  MESSAGE_REACTIONS: 'messageReactions', // For message reactions (Command Bus)
  FOLDERS: 'folders', // For chat folders (Command Bus)
  CHAT_FOLDER_ITEMS: 'chatFolderItems', // For chat-folder mapping (Command Bus)
  CONTACTS: 'contacts', // For user address book
  USER_CACHE: 'userCache', // For cached users (chat participants, message senders)
} as const;

// Database instance
let messagesDb: IDBDatabase | null = null;

// RC-8 fix: Mutex to prevent parallel DB initialization
let messagesDbInitPromise: Promise<IDBDatabase> | null = null;

// Write queue mutex to prevent parallel write operations
// IndexedDB transactions can conflict when multiple writes happen simultaneously
let writeQueue: Promise<void> = Promise.resolve();

/**
 * Execute a write operation in a queue to prevent parallel IndexedDB writes
 * This prevents TransactionInactiveError and AbortError when multiple
 * write operations are triggered simultaneously
 */
async function withWriteQueue<T>(operation: () => Promise<T>): Promise<T> {
  const currentQueue = writeQueue;
  let releaseQueue: () => void;
  
  const queuePromise = new Promise<void>(resolve => {
    releaseQueue = resolve;
  });
  
  writeQueue = queuePromise;
  
  try {
    // Wait for previous operations to complete
    await currentQueue;
    // Execute the operation
    return await operation();
  } finally {
    // Release the queue for next operation
    releaseQueue!();
  }
}

// Separate write queue for attachments to avoid blocking message operations
let attachmentWriteQueue: Promise<void> = Promise.resolve();

/**
 * Execute an attachment write operation in a separate queue
 * Attachments have their own queue to avoid blocking message operations
 */
async function withAttachmentWriteQueue<T>(operation: () => Promise<T>): Promise<T> {
  const currentQueue = attachmentWriteQueue;
  let releaseQueue: () => void;
  
  const queuePromise = new Promise<void>(resolve => {
    releaseQueue = resolve;
  });
  
  attachmentWriteQueue = queuePromise;
  
  try {
    await currentQueue;
    return await operation();
  } finally {
    releaseQueue!();
  }
}

/**
 * Timeout wrapper for IndexedDB operations
 * Prevents hanging if operation never completes
 */
async function withTimeout<T>(
  promise: Promise<T>, 
  ms = 5000, 
  errorMsg = 'IndexedDB operation timed out'
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(errorMsg)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

// ==================== Types ====================

// Attachment metadata stored with message (includes data for simplicity)
// TODO: Stage 5.3.4 - Store data separately in attachments store with deduplication
export interface MessageAttachment {
  id: string;
  type: 'image' | 'video' | 'audio' | 'voice' | 'file';
  fileName: string;
  size: number;
  mimeType: string;
  contentHash: string; // SHA-256 hash for deduplication
  data?: string; // Base64 data (temporary storage before deduplication)
}

export interface StoredMessage {
  id: string;
  chatId: string;
  senderId: string;
  senderUsername?: string;
  senderDeviceId: number;
  content: string; // Decrypted plaintext
  timestamp: number;
  createdAt: number;
  messageType: number;
  isOutgoing: boolean;
  status: 'sending' | 'sent' | 'delivered' | 'read' | 'failed';
  replyTo?: string;
  replyToOriginalSenderId?: string; // Original sender ID when replying to a forwarded message
  attachments?: MessageAttachment[];
  type?: string; // Message type (TEXT, SYSTEM, etc.)
  metadata?: any; // Metadata for system messages
  // === Command Bus fields ===
  isPinned?: boolean;     // Message is pinned in chat (default: false)
  editedAt?: number;      // Timestamp of last edit (0 if never edited)
  isEdited?: boolean;     // Convenience flag for quick edited status check
}

export interface ChatMetadata {
  chatId: string;
  lastMessageAt: number;
  lastMessageId: string;
  unreadCount: number;
  updatedAt: number;
  // === Command Bus fields ===
  isMuted: boolean;
  mutedUntil: number | null;
  isPinned: boolean;
  isArchived: boolean;
  description: string | null;
}

/**
 * MessageRecord - Stores plaintext for Sesame retry mechanism (RC-4)
 * Per Sesame §4.1, when recipient can't decrypt, sender must be able to
 * re-encrypt with fresh session using the original plaintext.
 */
export interface MessageRecord {
  id: string;                    // Composite: `${messageId}-${deviceId}`
  originalMessageId: string;     // Original message ID
  recipientId: string;           // Recipient user ID
  recipientDeviceId: number;     // Recipient device ID
  plaintext: string;             // Original plaintext content
  chatId: string;                // Chat ID for context
  createdAt: number;             // When record was created
  expiresAt: number;             // TTL expiration (MAXLATENCY ~7 days)
}

// ========== Command Bus Additional Types ==========

/**
 * MessageReactionRecord - Stores reactions to messages (E2EE)
 */
export interface MessageReactionRecord {
  id: string;              // Compound key: `${messageId}:${userId}:${emoji}`
  messageId: string;
  userId: string;
  emoji: string;
  createdAt: number;
}

/**
 * FolderRecord - User's chat folders
 */
export interface FolderRecord {
  id: string;
  userId: string;
  name: string;
  color: string | null; // HEX color, e.g., #FF5733
  order: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * StoredFolder - Subset of FolderRecord used by the settings UI
 * (FolderManagementDialog). The dialog does not know the current user's
 * id at load time, so `getAllFolders` returns all folders (a single-user
 * device only ever contains one user's folders).
 */
export interface StoredFolder {
  id: string;
  name: string;
  color?: string | null;
  order: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * ChatFolderItemRecord - Mapping between chats and folders (many-to-many)
 */
export interface ChatFolderItemRecord {
  chatId: string;
  folderId: string;
  order: number;
}

// ========== Contacts Types ==========

/**
 * ContactRecord - User's address book entry
 */
export interface ContactRecord {
  id: string;                    // userId (primary key)
  username: string;              // Original username from server
  displayName: string;           // Editable display name
  avatar?: string;               // Cached avatar URL
  addedAt: number;               // Timestamp when added to contacts
  updatedAt: number;             // Timestamp of last update
  notes?: string;                // Notes about the contact
  isFavorite: boolean;           // Favorite contact flag
}

/**
 * UserCacheRecord - Cached user information from chat participation or messaging
 */
export interface UserCacheRecord {
  id: string;                    // Composite key: `${userId}:${chatId}`
  userId: string;                // User ID
  chatId: string;                // Chat where user was encountered
  username: string;              // Username from server
  displayName?: string;          // Display name from server (if available)
  avatar?: string;               // Avatar from server
  role?: string;                 // Role in group chat (for group chats)
  joinedAt?: string;             // Date joined group (for group chats)
  lastSeen?: string;             // Last online timestamp
  cachedAt: number;              // Timestamp of caching
  source: 'chat_participant' | 'message_sender';  // Source of caching
}

// ==================== Database Initialization ====================

/**
 * Initialize Messages IndexedDB
 * 
 * RC-8 fix: Uses promise-based mutex to prevent parallel initialization.
 * If two calls happen simultaneously, both will wait for the same connection.
 */
export async function initMessagesDB(): Promise<IDBDatabase> {
  // Check if we have a valid, open database connection
  if (messagesDb && messagesDb.version !== 0) {
    try {
      const transaction = messagesDb.transaction(MESSAGE_STORES.MESSAGES, 'readonly');
      transaction.commit?.();
      return messagesDb;
    } catch (error) {
      messagesDb = null;
    }
  }
  
  // RC-8 fix: If already initializing, wait for the existing promise
  if (messagesDbInitPromise) {
    return messagesDbInitPromise;
  }
  
  messagesDbInitPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(MESSAGES_DB_NAME, MESSAGES_DB_VERSION);

    request.onerror = () => {
      messagesDbInitPromise = null;
      reject(request.error);
    };

    (request as any).onabort = () => {
      messagesDbInitPromise = null;
      reject(new DOMException('Database upgrade aborted', 'AbortError'));
    };

    request.onsuccess = () => {
      messagesDb = request.result;
      
      // RC-9 fix: Reset init promise
      messagesDbInitPromise = null;
      resolve(messagesDb);
    };

    request.onupgradeneeded = (event) => {
      try {
        const database = (event.target as IDBOpenDBRequest).result;
        const transaction = (event.target as IDBOpenDBRequest).transaction; // Upgrade transaction
        const oldVersion = event.oldVersion;
        const newVersion = event.newVersion;

        // Messages store
        if (!database.objectStoreNames.contains(MESSAGE_STORES.MESSAGES)) {
          const messagesStore = database.createObjectStore(MESSAGE_STORES.MESSAGES, { keyPath: 'id' });
          messagesStore.createIndex('chatId', 'chatId', { unique: false });
          messagesStore.createIndex('timestamp', 'timestamp', { unique: false });
          messagesStore.createIndex('senderId', 'senderId', { unique: false });
          messagesStore.createIndex('chatId_timestamp', ['chatId', 'timestamp'], { unique: false });
        }

        // Chat metadata store
        if (!database.objectStoreNames.contains(MESSAGE_STORES.CHAT_METADATA)) {
          database.createObjectStore(MESSAGE_STORES.CHAT_METADATA, { keyPath: 'chatId' });
        }

        // MessageRecord store for Sesame retry (RC-4)
        if (!database.objectStoreNames.contains(MESSAGE_STORES.MESSAGE_RECORDS)) {
          const recordsStore = database.createObjectStore(MESSAGE_STORES.MESSAGE_RECORDS, { keyPath: 'id' });
          recordsStore.createIndex('originalMessageId', 'originalMessageId', { unique: false });
          recordsStore.createIndex('recipientId', 'recipientId', { unique: false });
          recordsStore.createIndex('expiresAt', 'expiresAt', { unique: false });
        }

        // Attachments store for file deduplication (Stage 5.3.4)
        if (!database.objectStoreNames.contains(MESSAGE_STORES.ATTACHMENTS)) {
          const attachmentsStore = database.createObjectStore(MESSAGE_STORES.ATTACHMENTS, { keyPath: 'id' });
          attachmentsStore.createIndex('timestamp', 'timestamp', { unique: false });
          attachmentsStore.createIndex('size', 'size', { unique: false });
          attachmentsStore.createIndex('timestamp_size', ['timestamp', 'size'], { unique: false });
        }

        // MessageReactions store for Command Bus (message reactions)
        if (!database.objectStoreNames.contains(MESSAGE_STORES.MESSAGE_REACTIONS)) {
          const reactionsStore = database.createObjectStore(MESSAGE_STORES.MESSAGE_REACTIONS, { keyPath: 'id' });
          reactionsStore.createIndex('messageId', 'messageId', { unique: false });
          reactionsStore.createIndex('userId', 'userId', { unique: false });
        }

        // Folders store for Command Bus (chat folders)
        if (!database.objectStoreNames.contains(MESSAGE_STORES.FOLDERS)) {
          const foldersStore = database.createObjectStore(MESSAGE_STORES.FOLDERS, { keyPath: 'id' });
          foldersStore.createIndex('userId', 'userId', { unique: false });
          foldersStore.createIndex('order', 'order', { unique: false });
        }

        // ChatFolderItems store for Command Bus (chat-folder mapping)
        if (!database.objectStoreNames.contains(MESSAGE_STORES.CHAT_FOLDER_ITEMS)) {
          const itemsStore = database.createObjectStore(MESSAGE_STORES.CHAT_FOLDER_ITEMS, { keyPath: ['chatId', 'folderId'] });
          itemsStore.createIndex('folderId', 'folderId', { unique: false });
        }

        // ========== Migration: Version 4 -> 5 (Contacts and User Cache) ==========
        if (oldVersion < 5) {
          // Contacts store for address book
          if (!database.objectStoreNames.contains(MESSAGE_STORES.CONTACTS)) {
            const contactsStore = database.createObjectStore(MESSAGE_STORES.CONTACTS, { keyPath: 'id' });
            contactsStore.createIndex('username', 'username', { unique: false });
            contactsStore.createIndex('displayName', 'displayName', { unique: false });
            contactsStore.createIndex('isFavorite', 'isFavorite', { unique: false });
          }

          // UserCache store for cached users
          if (!database.objectStoreNames.contains(MESSAGE_STORES.USER_CACHE)) {
            const userCacheStore = database.createObjectStore(MESSAGE_STORES.USER_CACHE, { keyPath: 'id' });
            userCacheStore.createIndex('userId', 'userId', { unique: false });
            userCacheStore.createIndex('chatId', 'chatId', { unique: false });
            userCacheStore.createIndex('cachedAt', 'cachedAt', { unique: false });
          }
        }

        // ========== Migration: Version 3 -> 4 (Command Bus fields) ==========
        if (oldVersion < 4) {
          // Migrate Messages: add isPinned and editedAt fields
          if (database.objectStoreNames.contains(MESSAGE_STORES.MESSAGES)) {
            // FIX: Use the upgrade transaction from the event, not a new transaction.
            // The onupgradeneeded event provides a transaction in event.target.transaction.
            const messagesStore = transaction!.objectStore(MESSAGE_STORES.MESSAGES);
            const cursor = messagesStore.openCursor();
            cursor.onsuccess = (event: any) => {
              const cursor = event.target.result;
              if (cursor) {
                const message = cursor.value;
                if (message.isPinned === undefined) message.isPinned = false;
                if (message.editedAt === undefined) message.editedAt = 0;
                cursor.update(message);
                cursor.continue();
              }
            };
            cursor.onerror = (event: any) => {
              console.warn('[db.ts] Message migration cursor error:', event.target.error);
            };
          }

          // Migrate ChatMetadata: add command bus fields
          if (database.objectStoreNames.contains(MESSAGE_STORES.CHAT_METADATA)) {
            // FIX: Use the upgrade transaction from the event
            const chatStore = transaction!.objectStore(MESSAGE_STORES.CHAT_METADATA);
            const cursor = chatStore.openCursor();
            cursor.onsuccess = (event: any) => {
              const cursor = event.target.result;
              if (cursor) {
                const chat = cursor.value;
                if (chat.isMuted === undefined) chat.isMuted = false;
                if (chat.mutedUntil === undefined) chat.mutedUntil = null;
                if (chat.isPinned === undefined) chat.isPinned = false;
                if (chat.isArchived === undefined) chat.isArchived = false;
                if (chat.description === undefined) chat.description = null;
                cursor.update(chat);
                cursor.continue();
              }
            };
            cursor.onerror = (event: any) => {
              console.warn('[db.ts] ChatMetadata migration cursor error:', event.target.error);
            };
          }
        }
      } catch (error) {
        console.error('[db.ts] Error during database upgrade:', error);
        reject(error);
      }
    };
  });
  
  return messagesDbInitPromise;
}

// ==================== Helper Functions ====================

/**
 * Wrapper that auto-reinitializes DB if connection is lost
 * RC-9 fix: Ensures DB is ready before operation to prevent race conditions
 * in React StrictMode where remount can close the connection between initialization
 * and actual query execution.
 */
async function withAutoReinit<T>(operation: () => Promise<T>): Promise<T> {
  // RC-9 fix: Ensure DB is initialized before attempting operation
  // This prevents "DB not initialized" errors when React StrictMode remounts
  // components before the first initialization promise completes
  await ensureMessagesDBReady();
  
  try {
    return await operation();
  } catch (error: any) {
    // Check if error is due to closing/closed connection
    if (error.name === 'InvalidStateError' &&
        (error.message?.includes('closing') || error.message?.includes('closed'))) {
      messagesDb = null;
      await initMessagesDB();
      // Retry operation once after reinit
      return operation();
    }
    throw error;
  }
}

function getStore(storeName: string, mode: IDBTransactionMode = 'readonly'): IDBObjectStore {
  if (!messagesDb) {
    throw new Error('Messages DB not initialized. Call initMessagesDB() first.');
  }
  
  try {
    const transaction = messagesDb.transaction(storeName, mode);
    return transaction.objectStore(storeName);
  } catch (error: any) {
    // Check if error is due to closing connection
    if (error.name === 'InvalidStateError' && error.message?.includes('closing')) {
      messagesDb = null;
    }
    throw error;
  }
}

/**
 * Ensure database is ready, reinitialize if needed
 * Call this before critical operations
 */
export async function ensureMessagesDBReady(): Promise<IDBDatabase> {
  try {
    // Try a test transaction
    if (messagesDb) {
      const transaction = messagesDb.transaction(MESSAGE_STORES.MESSAGES, 'readonly');
      transaction.commit?.();
      return messagesDb;
    }
  } catch (error) {
    messagesDb = null;
  }
  
  // Reinitialize
  return initMessagesDB();
}

// ==================== Message Operations ====================

/**
 * Store a decrypted message
 * Uses write queue to prevent parallel IndexedDB writes
 * Idempotent: skips if message with same ID already exists
 */
export async function storeMessage(message: StoredMessage): Promise<void> {
  console.log('[storeMessage] START:', {
    id: message.id,
    chatId: message.chatId,
    senderId: message.senderId,
    type: message.type,
    hasContent: !!message.content,
    timestamp: new Date(message.timestamp).toISOString()
  });
  
  return withWriteQueue(() =>
    withTimeout(
      withAutoReinit(async () => {
        return new Promise<void>((resolve, reject) => {
          const store = getStore(MESSAGE_STORES.MESSAGES, 'readwrite');
          // Check if message already exists (idempotency)
          const getRequest = store.get(message.id);
          getRequest.onsuccess = () => {
            if (getRequest.result) {
              // Message already exists, skip insertion
              console.log('[storeMessage] Message already exists, skipping:', message.id);
              resolve();
              return;
            }
            // Message doesn't exist, insert it
            const putRequest = store.put(message);
            putRequest.onsuccess = () => {
              console.log('[storeMessage] SUCCESS:', message.id);
              resolve();
            };
            putRequest.onerror = () => {
              console.error('[storeMessage] ERROR:', message.id, putRequest.error);
              reject(putRequest.error);
            };
          };
          getRequest.onerror = () => {
            console.error('[storeMessage] GET ERROR:', message.id, getRequest.error);
            reject(getRequest.error);
          };
        });
      }),
      5000,
      'storeMessage timed out'
    )
  );
}

/**
 * Store multiple messages at once
 * Uses write queue to prevent parallel IndexedDB writes
 * Idempotent: skips messages that already exist
 */
export async function storeMessages(messages: StoredMessage[]): Promise<void> {
  return withWriteQueue(() =>
    withTimeout(
      new Promise((resolve, reject) => {
        const transaction = messagesDb!.transaction(MESSAGE_STORES.MESSAGES, 'readwrite');
        const store = transaction.objectStore(MESSAGE_STORES.MESSAGES);
        
        let completed = 0;
        const total = messages.length;
        
        if (total === 0) {
          resolve();
          return;
        }
        
        // Track which messages need to be inserted
        let inserted = 0;
        
        for (const message of messages) {
          // Check if message exists before inserting (idempotency)
          const getRequest = store.get(message.id);
          getRequest.onsuccess = () => {
            if (!getRequest.result) {
              // Message doesn't exist, insert it
              const putRequest = store.put(message);
              putRequest.onsuccess = () => {
                inserted++;
                completed++;
                if (completed === total) {
                  resolve();
                }
              };
              putRequest.onerror = () => reject(putRequest.error);
            } else {
              // Message already exists, skip
              completed++;
              if (completed === total) {
                resolve();
              }
            }
          };
          getRequest.onerror = () => reject(getRequest.error);
        }
      }),
      10000,
      'storeMessages timed out'
    )
  );
}

/**
 * Get a message by ID
 */
export async function getMessage(messageId: string): Promise<StoredMessage | undefined> {
  return new Promise((resolve, reject) => {
    const store = getStore(MESSAGE_STORES.MESSAGES);
    const request = store.get(messageId);
    request.onsuccess = () => resolve(request.result as StoredMessage);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Get all messages for a chat
 */
export async function getChatMessages(chatId: string): Promise<StoredMessage[]> {
  return withAutoReinit(async () => {
    return new Promise<StoredMessage[]>((resolve, reject) => {
      const store = getStore(MESSAGE_STORES.MESSAGES);
      const index = store.index('chatId');
      const request = index.getAll(chatId);
      request.onsuccess = () => {
        const messages = request.result as StoredMessage[];
        // Sort by timestamp ascending
        messages.sort((a, b) => a.timestamp - b.timestamp);
        resolve(messages);
      };
      request.onerror = () => reject(request.error);
    });
  });
}

/**
 * Get messages for a chat with pagination
 * @param chatId - Chat ID
 * @param limit - Max messages to return
 * @param beforeTimestamp - Load messages older than this timestamp (for scrolling up)
 */
export async function getChatMessagesPaginated(
  chatId: string,
  limit = 50,
  beforeTimestamp?: number
): Promise<StoredMessage[]> {
  return new Promise((resolve, reject) => {
    const store = getStore(MESSAGE_STORES.MESSAGES);
    const index = store.index('chatId_timestamp');
    
    // Use IDBKeyRange for efficient querying
    const range = beforeTimestamp
      ? IDBKeyRange.bound([chatId, 0], [chatId, beforeTimestamp], false, true)
      : IDBKeyRange.bound([chatId, 0], [chatId, Date.now()]);
    
    const request = index.openCursor(range, 'prev');
    const messages: StoredMessage[] = [];
    
    request.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
      if (cursor && messages.length < limit) {
        messages.push(cursor.value as StoredMessage);
        cursor.continue();
      } else {
        // Reverse to get chronological order
        messages.reverse();
        resolve(messages);
      }
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * Get the most recent messages for a chat (from the end)
 * Used for initial load when opening a chat - shows the latest messages
 * @param chatId - Chat ID
 * @param limit - Max messages to return (default 30)
 */
export async function getRecentMessages(
  chatId: string,
  limit = 30
): Promise<StoredMessage[]> {
  console.log('[getRecentMessages] chatId:', chatId, 'limit:', limit);
  return withAutoReinit(async () => {
    return new Promise<StoredMessage[]>((resolve, reject) => {
      const store = getStore(MESSAGE_STORES.MESSAGES);
      const index = store.index('chatId_timestamp');
      
      console.log('[getRecentMessages] Using index:', index);
      
      // Get the latest messages first (descending order)
      // Range: from chatId + smallest timestamp to chatId + largest timestamp
      const range = IDBKeyRange.bound(
        [chatId, 0],
        [chatId, Number.MAX_SAFE_INTEGER],
        false,
        false
      );
      
      console.log('[getRecentMessages] Range:', [chatId, 0], 'to', [chatId, Number.MAX_SAFE_INTEGER]);
      
      // Open cursor in reverse to get newest first
      const request = index.openCursor(range, 'prev');
      const messages: StoredMessage[] = [];
      
      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        console.log('[getRecentMessages] Cursor success:', cursor ? 'found' : 'none', 'messages so far:', messages.length);
        if (cursor && messages.length < limit) {
          messages.push(cursor.value as StoredMessage);
          cursor.continue();
        } else {
          // Reverse to get chronological order (oldest first)
          messages.reverse();
          console.log('[getRecentMessages] Resolving with', messages.length, 'messages');
          resolve(messages);
        }
      };
      request.onerror = (event) => {
        const idbRequest = event.target as IDBRequest;
        console.error('[getRecentMessages] Cursor error:', idbRequest.error);
        reject(idbRequest.error);
      };
    });
  });
}

/**
 * Get messages older than a given timestamp
 * Used for loading older messages when scrolling up
 * @param chatId - Chat ID
 * @param beforeTimestamp - Load messages older than this timestamp
 * @param limit - Max messages to return (default 30)
 * @param maxTimestamp - Optional hard upper bound (pagination cutoff time).
 *   Messages newer than this timestamp will be excluded even if they're older than beforeTimestamp.
 *   This prevents new incoming messages from interfering with pagination.
 */
export async function getOlderMessages(
  chatId: string,
  beforeTimestamp: number,
  limit = 30,
  maxTimestamp?: number
): Promise<StoredMessage[]> {
  return withAutoReinit(async () => {
    return new Promise<StoredMessage[]>((resolve, reject) => {
      const store = getStore(MESSAGE_STORES.MESSAGES);
      const index = store.index('chatId_timestamp');
      
      // Load messages older than beforeTimestamp, but not newer than maxTimestamp (if provided)
      // This isolates pagination from real-time message arrivals
      const upperBound = maxTimestamp !== undefined
        ? Math.min(beforeTimestamp, maxTimestamp)
        : beforeTimestamp;
      
      // Range: from chatId + 0 to chatId + upperBound (exclusive)
      const range = IDBKeyRange.bound(
        [chatId, 0],
        [chatId, upperBound],
        false,
        true  // upperBound exclusive
      );
      
      // Open cursor in reverse to get newest first, then limit
      const request = index.openCursor(range, 'prev');
      const messages: StoredMessage[] = [];
      
      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor && messages.length < limit) {
          messages.push(cursor.value as StoredMessage);
          cursor.continue();
        } else {
          // Reverse to get chronological order (oldest first)
          messages.reverse();
          resolve(messages);
        }
      };
      request.onerror = () => reject(request.error);
    });
  });
}

/**
 * Get messages older than a cursor message (cursor-based pagination)
 * Uses message ID as cursor for stable pagination without duplicates/skips
 * @param chatId - Chat ID
 * @param cursorMessageId - ID of the oldest message in current page (acts as cursor)
 * @param limit - Max messages to return (default 30)
 */
export async function getOlderMessagesWithCursor(
  chatId: string,
  cursorMessageId: string,
  limit = 30
): Promise<StoredMessage[]> {
  return withAutoReinit(async () => {
    return new Promise<StoredMessage[]>((resolve, reject) => {
      const store = getStore(MESSAGE_STORES.MESSAGES);
      
      // 1. First get the timestamp of the cursor message
      const cursorRequest = store.get(cursorMessageId);
      
      cursorRequest.onsuccess = () => {
        if (!cursorRequest.result) {
          resolve([]);
          return;
        }
        
        const cursorTimestamp = (cursorRequest.result as StoredMessage).timestamp;
        const index = store.index('chatId_timestamp');
        
        // 2. Query: messages OLDER (smaller timestamp) than cursor
        // Use chatId_timestamp composite index
        const range = IDBKeyRange.bound(
          [chatId, 0],
          [chatId, cursorTimestamp],
          false,  // include lower bound
          true    // exclude upper bound (cursor itself)
        );
        
        const request = index.openCursor(range, 'prev');  // 'prev' = descending (newest first)
        const messages: StoredMessage[] = [];
        
        request.onsuccess = (event) => {
          const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
          if (cursor && messages.length < limit) {
            // FILTER: skip message with same ID as cursor (shouldn't happen but safety check)
            if (cursor.value.id !== cursorMessageId) {
              messages.push(cursor.value as StoredMessage);
            }
            cursor.continue();
          } else {
            // Reverse to get chronological order (oldest first)
            messages.reverse();
            resolve(messages);
          }
        };
        
        request.onerror = () => reject(request.error);
      };
      
      cursorRequest.onerror = () => reject(cursorRequest.error);
    });
  });
}

/**
 * Get messages around a target message (F5).
 *
 * Used by `ChatMessages.scrollToMessage` when the user clicks a reply
 * that points to a message outside the currently-loaded page. We
 * resolve the target's timestamp via a primary-key lookup, then
 * load `pageSize` messages before and `pageSize` messages after it
 * using the `chatId_timestamp` composite index — much cheaper than
 * the naive `getAll(chatId)` approach for large chats.
 *
 * Returns an empty array if the target message does not exist or
 * belongs to a different chat.
 *
 * @param chatId Chat to scope the query to
 * @param targetMessageId ID of the message to centre the window on
 * @param pageSize Number of messages to load on each side (default 30)
 */
export async function getMessagesAround(
  chatId: string,
  targetMessageId: string,
  pageSize = 30
): Promise<StoredMessage[]> {
  return withAutoReinit(async () => {
    return new Promise<StoredMessage[]>((resolve, reject) => {
      const store = getStore(MESSAGE_STORES.MESSAGES);

      // 1. Resolve target message + its timestamp
      const targetReq = store.get(targetMessageId);
      targetReq.onsuccess = () => {
        const target = targetReq.result as StoredMessage | undefined;
        if (!target || target.chatId !== chatId) {
          resolve([]);
          return;
        }

        const targetTs = target.timestamp;
        const index = store.index('chatId_timestamp');

        // We need both older and newer messages. Two cursor queries
        // are simpler than a single bidirectional one and keep the
        // logic readable. Run them sequentially (IDB transactions
        // on the same store share a single tx here).
        const older: StoredMessage[] = [];
        const newer: StoredMessage[] = [];

        // 2a. Older messages (timestamp < targetTs), newest-first
        const olderRange = IDBKeyRange.bound(
          [chatId, 0],
          [chatId, targetTs],
          false,
          true // exclude target itself
        );
        const olderReq = index.openCursor(olderRange, 'prev');
        olderReq.onsuccess = (event) => {
          const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
          if (cursor && older.length < pageSize) {
            older.push(cursor.value as StoredMessage);
            cursor.continue();
          } else {
            // 2b. Newer messages (timestamp > targetTs), oldest-first
            const newerRange = IDBKeyRange.bound(
              [chatId, targetTs],
              [chatId, Number.MAX_SAFE_INTEGER],
              true, // exclude target itself
              false
            );
            const newerReq = index.openCursor(newerRange, 'next');
            newerReq.onsuccess = (ev) => {
              const cur = (ev.target as IDBRequest<IDBCursorWithValue>).result;
              if (cur && newer.length < pageSize) {
                newer.push(cur.value as StoredMessage);
                cur.continue();
              } else {
                // Combine: older (reversed → ascending) + target + newer (already ascending)
                older.reverse();
                resolve([...older, target, ...newer]);
              }
            };
            newerReq.onerror = () => reject(newerReq.error);
          }
        };
        olderReq.onerror = () => reject(olderReq.error);
      };
      targetReq.onerror = () => reject(targetReq.error);
    });
  });
}
/**
 * Update message status
 */
export async function updateMessageStatus(
  messageId: string,
  status: StoredMessage['status']
): Promise<void> {
  const message = await getMessage(messageId);
  if (message) {
    message.status = status;
    await storeMessage(message);
  }
}

/**
 * Delete a message
 * Uses write queue to prevent parallel IndexedDB writes
 */
export async function deleteMessage(messageId: string): Promise<void> {
  return withWriteQueue(() =>
    withTimeout(
      new Promise((resolve, reject) => {
        const store = getStore(MESSAGE_STORES.MESSAGES, 'readwrite');
        const request = store.delete(messageId);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      }),
      5000,
      'deleteMessage timed out'
    )
  );
}

/**
 * Delete all messages for a chat
 * Uses write queue to prevent parallel IndexedDB writes
 */
export async function deleteChatMessages(chatId: string): Promise<void> {
  return withWriteQueue(() =>
    withTimeout(
      new Promise((resolve, reject) => {
        const store = getStore(MESSAGE_STORES.MESSAGES, 'readwrite');
        const index = store.index('chatId');
        const request = index.openCursor(chatId);
        
        request.onsuccess = (event) => {
          const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          } else {
            resolve();
          }
        };
        request.onerror = () => reject(request.error);
      }),
      10000,
      'deleteChatMessages timed out'
    )
  );
}

// ==================== Chat Metadata Operations ====================

/**
 * Update chat metadata
 * Uses write queue to prevent parallel IndexedDB writes
 */
export async function updateChatMetadata(metadata: ChatMetadata): Promise<void> {
  console.log('[updateChatMetadata] chatId:', metadata.chatId, 'unreadCount:', metadata.unreadCount, 'updatedAt:', new Date(metadata.updatedAt).toISOString());
  // Note: This function should be called from within a withWriteQueue context (e.g., resetUnreadCount, setUnreadCount)
  // to avoid parallel writes. Do NOT add withWriteQueue here to prevent deadlock.
  return withTimeout(
    withAutoReinit(async () => {
      return new Promise<void>((resolve, reject) => {
        const store = getStore(MESSAGE_STORES.CHAT_METADATA, 'readwrite');
        const request = store.put(metadata);
        request.onsuccess = () => {
          console.log('[updateChatMetadata] SUCCESS chatId:', metadata.chatId);
          resolve();
        };
        request.onerror = () => {
          console.error('[updateChatMetadata] ERROR chatId:', metadata.chatId, 'error:', request.error);
          reject(request.error);
        };
      });
    }),
    5000,
    'updateChatMetadata timed out'
  );
}

/**
 * Get chat metadata
 * Uses withAutoReinit to handle DB connection loss (RC-9)
 */
export async function getChatMetadata(chatId: string): Promise<ChatMetadata | undefined> {
  return withAutoReinit(async () => {
    return new Promise<ChatMetadata | undefined>((resolve, reject) => {
      const store = getStore(MESSAGE_STORES.CHAT_METADATA);
      const request = store.get(chatId);
      request.onsuccess = () => resolve(request.result as ChatMetadata | undefined);
      request.onerror = () => reject(request.error);
    });
  });
}

/**
 * Get all chat metadata
 * Uses withAutoReinit to handle DB connection loss (RC-9)
 */
export async function getAllChatMetadata(): Promise<ChatMetadata[]> {
  return withAutoReinit(async () => {
    return new Promise<ChatMetadata[]>((resolve, reject) => {
      const store = getStore(MESSAGE_STORES.CHAT_METADATA);
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result as ChatMetadata[]);
      request.onerror = () => reject(request.error);
    });
  });
}

/**
 * Get all messages from all chats (for sync purposes)
 */
export async function getAllMessages(): Promise<StoredMessage[]> {
  return withAutoReinit(async () => {
    return new Promise<StoredMessage[]>((resolve, reject) => {
      const store = getStore(MESSAGE_STORES.MESSAGES);
      const request = store.getAll();
      request.onsuccess = () => {
        const messages = request.result as StoredMessage[];
        // Sort by timestamp ascending
        messages.sort((a, b) => a.timestamp - b.timestamp);
        resolve(messages);
      };
      request.onerror = () => reject(request.error);
    });
  });
}

/**
 * Increment unread count for a chat atomically using a transaction
 * This prevents race conditions when multiple messages arrive simultaneously
 */
export async function incrementUnreadCount(chatId: string): Promise<void> {
  return withWriteQueue(() =>
    withTimeout(
      withAutoReinit(async () => {
        return new Promise<void>((resolve, reject) => {
          if (!messagesDb) {
            reject(new Error('Messages DB not initialized'));
            return;
          }
          
          // Use a transaction to make read-modify-write atomic
          const transaction = messagesDb.transaction(
            [MESSAGE_STORES.CHAT_METADATA],
            'readwrite'
          );
          
          const store = transaction.objectStore(MESSAGE_STORES.CHAT_METADATA);
          
          // First, get the current metadata
          const getRequest = store.get(chatId);
          
          getRequest.onsuccess = () => {
            const metadata = getRequest.result as ChatMetadata | undefined;
            
            if (metadata) {
              // Update existing metadata
              metadata.unreadCount = metadata.unreadCount + 1;
              metadata.updatedAt = Date.now();
              
              const putRequest = store.put(metadata);
              putRequest.onsuccess = () => {
                resolve();
              };
              putRequest.onerror = () => reject(putRequest.error);
            } else {
               // Create new metadata
               const newMetadata: ChatMetadata = {
                 chatId,
                 lastMessageAt: Date.now(),
                 lastMessageId: '',
                 unreadCount: 1,
                 updatedAt: Date.now(),
                 isMuted: false,
                 mutedUntil: null,
                 isPinned: false,
                 isArchived: false,
                 description: null,
               };
              
              const putRequest = store.put(newMetadata);
              putRequest.onsuccess = () => {
                resolve();
              };
              putRequest.onerror = () => reject(putRequest.error);
            }
          };
          
          getRequest.onerror = () => reject(getRequest.error);
          
          transaction.onerror = () => reject(transaction.error);
        });
      }),
      5000,
      'incrementUnreadCount timed out'
    )
  );
}

/**
 * Reset unread count for a chat
 * Uses withWriteQueue and withAutoReinit to prevent race conditions (RC-9)
 */
export async function resetUnreadCount(chatId: string): Promise<void> {
  console.log("[resetUnreadCount] START chatId:", chatId, "timestamp:", Date.now());
  return withWriteQueue(() =>
    withTimeout(
      withAutoReinit(async () => {
        console.log("[resetUnreadCount] after withAutoReinit chatId:", chatId, "timestamp:", Date.now());
        if (!chatId || typeof chatId !== 'string') {
          console.error('[resetUnreadCount] Invalid chatId:', chatId);
          throw new Error(`Invalid chatId: ${chatId}`);
        }
        console.log("[resetUnreadCount] about to call getChatMetadata chatId:", chatId, "timestamp:", Date.now());
        const startGet = Date.now();
        const metadata = await getChatMetadata(chatId);
        console.log("[resetUnreadCount] getChatMetadata completed chatId:", chatId, "duration:", Date.now() - startGet, "ms, timestamp:", Date.now());
        if (metadata) {
          console.log("[resetUnreadCount] metadata found, setting unreadCount=0 chatId:", chatId, "oldCount:", metadata.unreadCount, "timestamp:", Date.now());
          metadata.unreadCount = 0;
          metadata.updatedAt = Date.now();
          const startUpdate = Date.now();
          await updateChatMetadata(metadata);
          console.log("[resetUnreadCount] updateChatMetadata completed chatId:", chatId, "duration:", Date.now() - startUpdate, "ms, timestamp:", Date.now());
        } else {
          console.log("[resetUnreadCount] metadata NOT FOUND chatId:", chatId, "timestamp:", Date.now());
        }
        console.log("[resetUnreadCount] END chatId:", chatId, "timestamp:", Date.now());
      }),
      20000,
      'resetUnreadCount timed out'
    )
  );
}

/**
 * Set unread count for a chat to a specific value (from backend)
 * Backend is the source of truth - this sets the exact value from backend
 */
export async function setUnreadCount(chatId: string, count: number): Promise<void> {
  console.log("[setUnreadCount] START chatId:", chatId, "count:", count, "timestamp:", Date.now());
  return withWriteQueue(() =>
    withTimeout(
      withAutoReinit(async () => {
        console.log("[setUnreadCount] after withAutoReinit chatId:", chatId, "count:", count, "timestamp:", Date.now());
        return new Promise<void>((resolve, reject) => {
          if (!messagesDb) {
            reject(new Error('Messages DB not initialized'));
            return;
          }
          
          if (!chatId || typeof chatId !== 'string') {
            console.error('[setUnreadCount] Invalid chatId:', chatId);
            reject(new Error(`Invalid chatId: ${chatId}`));
            return;
          }
          
          const transaction = messagesDb.transaction(
            [MESSAGE_STORES.CHAT_METADATA],
            'readwrite'
          );
          
          const store = transaction.objectStore(MESSAGE_STORES.CHAT_METADATA);
          
          // First, get the current metadata
          const getRequest = store.get(chatId);
          const startGet = Date.now();
          
          getRequest.onsuccess = () => {
            console.log("[setUnreadCount] getRequest.onsuccess chatId:", chatId, "duration:", Date.now() - startGet, "ms, timestamp:", Date.now());
            const metadata = getRequest.result as ChatMetadata | undefined;
            
            if (metadata) {
              // Update existing metadata with new unreadCount from backend
              metadata.unreadCount = count;
              metadata.updatedAt = Date.now();
              
              const putRequest = store.put(metadata);
              putRequest.onsuccess = () => {
                console.log("[setUnreadCount] putRequest.onsuccess chatId:", chatId, "timestamp:", Date.now());
                resolve();
              };
              putRequest.onerror = () => {
                console.error('[setUnreadCount] putRequest.onerror chatId:', chatId, 'error:', putRequest.error);
                reject(putRequest.error);
              };
             } else {
               // Create new metadata with the count from backend
               console.log("[setUnreadCount] metadata not found, creating new chatId:", chatId, "timestamp:", Date.now());
               const newMetadata: ChatMetadata = {
                 chatId,
                 lastMessageAt: Date.now(),
                 lastMessageId: '',
                 unreadCount: count,
                 updatedAt: Date.now(),
                 isMuted: false,
                 mutedUntil: null,
                 isPinned: false,
                 isArchived: false,
                 description: null,
               };
             
               const putRequest = store.put(newMetadata);
               putRequest.onsuccess = () => {
                 console.log("[setUnreadCount] putRequest.onsuccess (new) chatId:", chatId, "timestamp:", Date.now());
                 resolve();
               };
               putRequest.onerror = () => {
                 console.error('[setUnreadCount] putRequest.onerror (new) chatId:', chatId, 'error:', putRequest.error);
                 reject(putRequest.error);
               };
             }
          };
          
          getRequest.onerror = () => {
            console.error('[setUnreadCount] getRequest.onerror chatId:', chatId, 'error:', getRequest.error);
            reject(getRequest.error);
          };
          
          transaction.onerror = () => reject(transaction.error);
        });
      }),
      20000,
      'setUnreadCount timed out'
    )
  );
}

// ==================== Utility Operations ====================

/**
 * Clear all messages (for logout)
 * Uses write queue to prevent parallel IndexedDB writes
 */
export async function clearAllMessages(): Promise<void> {
  return withWriteQueue(async () => {
    const storeNames = Object.values(MESSAGE_STORES);
    
    for (const storeName of storeNames) {
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          const store = getStore(storeName, 'readwrite');
          const request = store.clear();
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        }),
        10000,
        `clearAllMessages (${storeName}) timed out`
      );
    }
  });
}

/**
 * Get total message count
 */
export async function getMessageCount(): Promise<number> {
  return new Promise((resolve, reject) => {
    const store = getStore(MESSAGE_STORES.MESSAGES);
    const request = store.count();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Get message count for a chat
 */
export async function getChatMessageCount(chatId: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const store = getStore(MESSAGE_STORES.MESSAGES);
    const index = store.index('chatId');
    const request = index.count(chatId);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Get last message for each chat (for sidebar preview)
 * Returns a map of chatId -> last message
 */
export async function getLastMessagesForChats(chatIds: string[]): Promise<Map<string, StoredMessage>> {
  const result = new Map<string, StoredMessage>();
  
  if (chatIds.length === 0) {
    return result;
  }
  
  // Get all messages and find the latest for each chat
  return new Promise((resolve, reject) => {
    const store = getStore(MESSAGE_STORES.MESSAGES);
    const request = store.getAll();
    
    request.onsuccess = () => {
      const allMessages = request.result as StoredMessage[];
      
      // Group by chatId and find latest
      const chatLatest = new Map<string, StoredMessage>();
      for (const msg of allMessages) {
        if (chatIds.includes(msg.chatId)) {
          const existing = chatLatest.get(msg.chatId);
          if (!existing || msg.timestamp > existing.timestamp) {
            chatLatest.set(msg.chatId, msg);
          }
        }
      }
      
      resolve(chatLatest);
    };
    request.onerror = () => reject(request.error);
  });
}

// ==================== MessageRecord Operations (Sesame §4.1, RC-4) ====================

/**
 * Store a MessageRecord for potential retry
 * Called when sending a message to enable re-encryption if recipient fails to decrypt
 */
export async function storeMessageRecord(record: MessageRecord): Promise<void> {
  return withAutoReinit(async () => {
    return new Promise<void>((resolve, reject) => {
      const store = getStore(MESSAGE_STORES.MESSAGE_RECORDS, 'readwrite');
      const request = store.put(record);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  });
}

/**
 * Get a MessageRecord by composite ID
 */
export async function getMessageRecord(id: string): Promise<MessageRecord | undefined> {
  return new Promise((resolve, reject) => {
    const store = getStore(MESSAGE_STORES.MESSAGE_RECORDS);
    const request = store.get(id);
    request.onsuccess = () => resolve(request.result as MessageRecord);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Get MessageRecord by original message ID and recipient device
 */
export async function getMessageRecordByOriginal(
  originalMessageId: string,
  recipientId: string,
  recipientDeviceId: number
): Promise<MessageRecord | undefined> {
  return new Promise((resolve, reject) => {
    const store = getStore(MESSAGE_STORES.MESSAGE_RECORDS);
    const index = store.index('originalMessageId');
    const request = index.getAll(originalMessageId);
    
    request.onsuccess = () => {
      const records = request.result as MessageRecord[];
      const match = records.find(
        r => r.recipientId === recipientId && r.recipientDeviceId === recipientDeviceId
      );
      resolve(match);
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * Delete a MessageRecord
 */
export async function deleteMessageRecord(id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const store = getStore(MESSAGE_STORES.MESSAGE_RECORDS, 'readwrite');
    const request = store.delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/**
 * Clean up expired MessageRecords
 * Should be called periodically to remove records past MAXLATENCY
 */
export async function cleanupExpiredMessageRecords(): Promise<number> {
  return new Promise((resolve, reject) => {
    const store = getStore(MESSAGE_STORES.MESSAGE_RECORDS, 'readwrite');
    const index = store.index('expiresAt');
    const now = Date.now();
    const range = IDBKeyRange.upperBound(now);
    
    let deleted = 0;
    const request = index.openCursor(range);
    
    request.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
      if (cursor) {
        cursor.delete();
        deleted++;
        cursor.continue();
      } else {
        resolve(deleted);
      }
    };
    request.onerror = () => reject(request.error);
  });
}

// ==================== Command Bus Operations ====================

/**
 * Pin a message
 * Updates isPinned flag and stores pinTimestamp in metadata
 */
export async function pinMessage(messageId: string, pinTimestamp: number): Promise<void> {
  return withWriteQueue(() =>
    withTimeout(
      withAutoReinit(async () => {
        const message = await getMessage(messageId);
        if (!message) {
          throw new Error(`Message ${messageId} not found`);
        }
        
        message.isPinned = true;
        const metadata = message.metadata || {};
        metadata.pinnedAt = pinTimestamp;
        message.metadata = metadata;
        
        await storeMessage(message);
      }),
      5000,
      'pinMessage timed out'
    )
  );
}

/**
 * Unpin a message
 */
export async function unpinMessage(messageId: string): Promise<void> {
  return withWriteQueue(() =>
    withTimeout(
      withAutoReinit(async () => {
        const message = await getMessage(messageId);
        if (!message) {
          throw new Error(`Message ${messageId} not found`);
        }
        
        message.isPinned = false;
        const metadata = message.metadata || {};
        delete metadata.pinnedAt;
        message.metadata = metadata;
        
        await storeMessage(message);
      }),
      5000,
      'unpinMessage timed out'
    )
  );
}

/**
 * Delete a message (soft delete - mark as deleted, keep in DB for sync)
 * For command_event handling - removes from local view but keeps for sync
 */
export async function deleteMessageFromDB(messageId: string): Promise<void> {
  // For now, hard delete from IndexedDB
  // In future, might want soft delete with metadata.deleted = true
  return deleteMessage(messageId);
}

/**
 * Add a reaction to a message
 * Stores in MESSAGE_REACTIONS store
 */
export async function addMessageReaction(
  messageId: string,
  userId: string,
  emoji: string
): Promise<void> {
  return withWriteQueue(() =>
    withTimeout(
      new Promise<void>((resolve, reject) => {
        const store = getStore(MESSAGE_STORES.MESSAGE_REACTIONS, 'readwrite');
        const id = `${messageId}:${userId}:${emoji}`;
        const request = store.put({
          id,
          messageId,
          userId,
          emoji,
          createdAt: Date.now(),
        });
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      }),
      5000,
      'addMessageReaction timed out'
    )
  );
}

/**
 * Remove a reaction from a message
 */
export async function removeMessageReaction(
  messageId: string,
  userId: string,
  emoji: string
): Promise<void> {
  return withWriteQueue(() =>
    withTimeout(
      new Promise<void>((resolve, reject) => {
        const store = getStore(MESSAGE_STORES.MESSAGE_REACTIONS, 'readwrite');
        const id = `${messageId}:${userId}:${emoji}`;
        const request = store.delete(id);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      }),
      5000,
      'removeMessageReaction timed out'
    )
  );
}

/**
 * Get reactions for a message
 */
export async function getMessageReactions(messageId: string): Promise<MessageReactionRecord[]> {
  return new Promise((resolve, reject) => {
    const store = getStore(MESSAGE_STORES.MESSAGE_REACTIONS);
    const index = store.index('messageId');
    const request = index.getAll(messageId);
    request.onsuccess = () => resolve(request.result as MessageReactionRecord[]);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Update chat mute status
 */
export async function updateChatMuteStatus(
  chatId: string,
  mutedUntil: number | null
): Promise<void> {
  return withWriteQueue(() =>
    withTimeout(
      withAutoReinit(async () => {
        const metadata = await getChatMetadata(chatId);
        if (!metadata) {
          throw new Error(`Chat ${chatId} metadata not found`);
        }
        
        metadata.isMuted = mutedUntil !== null;
        metadata.mutedUntil = mutedUntil;
        metadata.updatedAt = Date.now();
        
        await updateChatMetadata(metadata);
      }),
      5000,
      'updateChatMuteStatus timed out'
    )
  );
}

/**
 * Update chat archive status
 */
export async function updateChatArchiveStatus(
  chatId: string,
  isArchived: boolean
): Promise<void> {
  return withWriteQueue(() =>
    withTimeout(
      withAutoReinit(async () => {
        const metadata = await getChatMetadata(chatId);
        if (!metadata) {
          throw new Error(`Chat ${chatId} metadata not found`);
        }
        
        metadata.isArchived = isArchived;
        metadata.updatedAt = Date.now();
        
        await updateChatMetadata(metadata);
      }),
      5000,
      'updateChatArchiveStatus timed out'
    )
  );
}

/**
 * Update chat pin status
 */
export async function updateChatPinStatus(
  chatId: string,
  isPinned: boolean
): Promise<void> {
  return withWriteQueue(() =>
    withTimeout(
      withAutoReinit(async () => {
        const metadata = await getChatMetadata(chatId);
        if (!metadata) {
          throw new Error(`Chat ${chatId} metadata not found`);
        }
        
        metadata.isPinned = isPinned;
        metadata.updatedAt = Date.now();
        
        await updateChatMetadata(metadata);
      }),
      5000,
      'updateChatPinStatus timed out'
    )
  );
}

/**
 * Update chat description
 */
export async function updateChatDescription(
  chatId: string,
  description: string | null
): Promise<void> {
  return withWriteQueue(() =>
    withTimeout(
      withAutoReinit(async () => {
        const metadata = await getChatMetadata(chatId);
        if (!metadata) {
          throw new Error(`Chat ${chatId} metadata not found`);
        }
        
        metadata.description = description;
        metadata.updatedAt = Date.now();
        
        await updateChatMetadata(metadata);
      }),
      5000,
      'updateChatDescription timed out'
    )
  );
}

/**
 * Update message content (for message.edit command)
 */
export async function updateMessageContent(
  messageId: string,
  content: string,
  editedAt: number
): Promise<void> {
  return withWriteQueue(() =>
    withTimeout(
      withAutoReinit(async () => {
        const message = await getMessage(messageId);
        if (!message) {
          throw new Error(`Message ${messageId} not found`);
        }
        
        message.content = content;
        message.editedAt = editedAt;
        message.isEdited = true;
        
        await storeMessage(message);
      }),
      5000,
      'updateMessageContent timed out'
    )
  );
}

/**
 * Update message replyTo (for message.reply command)
 */
export async function updateMessageReply(
  messageId: string,
  replyTo: string
): Promise<void> {
  return withWriteQueue(() =>
    withTimeout(
      withAutoReinit(async () => {
        const message = await getMessage(messageId);
        if (!message) {
          throw new Error(`Message ${messageId} not found`);
        }
        
        message.replyTo = replyTo;
        await storeMessage(message);
      }),
      5000,
      'updateMessageReply timed out'
    )
  );
}

/**
 * Delete chat metadata (for chat.delete command)
 */
export async function deleteChatMetadata(chatId: string): Promise<void> {
  return withWriteQueue(() =>
    withTimeout(
      withAutoReinit(async () => {
        const store = getStore(MESSAGE_STORES.CHAT_METADATA, 'readwrite');
        const request = store.delete(chatId);
        request.onsuccess = () => {};
        request.onerror = () => { throw request.error; };
      }),
      5000,
      'deleteChatMetadata timed out'
    )
  );
}

/**
 * Delete attachments associated with a chat (for chat.delete command)
 * Removes attachment records from ATTACHMENTS store only if they are not used in other chats.
 * Uses deduplication: one attachment file can be shared across multiple messages/chats.
 */
export async function deleteChatAttachments(chatId: string): Promise<void> {
  // Step 1: Collect all contentHashes from attachments in this chat's messages
  const chatAttachmentHashes = new Set<string>();
  
  await withWriteQueue(() =>
    withTimeout(
      new Promise<void>((resolve, reject) => {
        const store = getStore(MESSAGE_STORES.MESSAGES, 'readonly');
        const index = store.index('chatId');
        const request = index.openCursor(chatId);
        
        request.onsuccess = (event) => {
          const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
          if (cursor) {
            const message = cursor.value as StoredMessage;
            if (message.attachments && Array.isArray(message.attachments)) {
              for (const att of message.attachments) {
                if (att.contentHash) {
                  chatAttachmentHashes.add(att.contentHash);
                }
              }
            }
            cursor.continue();
          } else {
            resolve();
          }
        };
        request.onerror = () => reject(request.error);
      }),
      10000,
      'deleteChatAttachments: collect from chat timed out'
    )
  );
  
  if (chatAttachmentHashes.size === 0) {
    return; // No attachments in this chat
  }
  
  // Step 2: Build a map of contentHash -> Set<chatId> across ALL messages
  const hashChatsMap = new Map<string, Set<string>>();
  
  await withWriteQueue(() =>
    withTimeout(
      new Promise<void>((resolve, reject) => {
        const store = getStore(MESSAGE_STORES.MESSAGES, 'readonly');
        const request = store.openCursor();
        
        request.onsuccess = (event) => {
          const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
          if (cursor) {
            const message = cursor.value as StoredMessage;
            if (message.attachments && Array.isArray(message.attachments)) {
              for (const att of message.attachments) {
                if (att.contentHash) {
                  const hash = att.contentHash;
                  if (!hashChatsMap.has(hash)) {
                    hashChatsMap.set(hash, new Set());
                  }
                  hashChatsMap.get(hash)!.add(message.chatId);
                }
              }
            }
            cursor.continue();
          } else {
            resolve();
          }
        };
        request.onerror = () => reject(request.error);
      }),
      30000, // 30 seconds for full scan (large DBs)
      'deleteChatAttachments: scan all messages timed out'
    )
  );
  
  // Step 3: Determine which hashes are used ONLY in this chat
  const hashesToDelete = new Set<string>();
  for (const hash of chatAttachmentHashes) {
    const chats = hashChatsMap.get(hash);
    if (!chats || (chats.size === 1 && chats.has(chatId))) {
      hashesToDelete.add(hash);
    }
  }
  
  // Step 4: Delete attachment records from ATTACHMENTS store
  for (const hash of hashesToDelete) {
    await withAttachmentWriteQueue(() =>
      withTimeout(
        new Promise<void>(async (resolve, reject) => {
          const db = await initMessagesDB();
          const transaction = db.transaction(MESSAGE_STORES.ATTACHMENTS, 'readwrite');
          const store = transaction.objectStore(MESSAGE_STORES.ATTACHMENTS);
          const request = store.delete(hash);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        }),
        5000,
        `deleteChatAttachments: delete ${hash} timed out`
      )
    );
  }
}

/**
 * Remove participant from chat (for participant.remove and chat.leave commands)
 * Note: Participants are stored in Chat object (Zustand), not in IndexedDB.
 * This function is a no-op for IndexedDB, but kept for API consistency.
 */
export async function removeParticipantFromChat(
  chatId: string,
  userId: string
): Promise<void> {
  // Participants are managed via Zustand store and server sync.
  // No IndexedDB operation needed.
  return Promise.resolve();
}

/**
 * Update chat participants (for participant.add/role_update commands)
 * Note: Participants are stored in Chat object (Zustand), not in IndexedDB.
 * This function is a no-op for IndexedDB, but kept for API consistency.
 */
export async function updateChatParticipants(
  chatId: string,
  participants: Array<{ userId: string; role: string }>
): Promise<void> {
  // Participants are managed via Zustand store and server sync.
  // No IndexedDB operation needed.
  return Promise.resolve(  );
}

// ==================== Reaction Operations ====================

/**
 * Store a reaction (add or update)
 * Idempotent: if reaction exists, it's a no-op (client handles toggle logic)
 */
export async function storeReaction(
  messageId: string,
  userId: string,
  emoji: string
): Promise<void> {
  return withWriteQueue(() =>
    withTimeout(
      withAutoReinit(async () => {
        const store = getStore(MESSAGE_STORES.MESSAGE_REACTIONS, 'readwrite');
        const id = `${messageId}:${userId}:${emoji}`;
        
        // Check if already exists (idempotency)
        const getRequest = store.get(id);
        getRequest.onsuccess = () => {
          if (getRequest.result) {
            // Reaction already exists, skip
            return;
          }
          // Insert new reaction
          const putRequest = store.put({
            id,
            messageId,
            userId,
            emoji,
            createdAt: Date.now(),
          });
          putRequest.onsuccess = () => {};
          putRequest.onerror = () => { throw putRequest.error; };
        };
        getRequest.onerror = () => { throw getRequest.error; };
      }),
      5000,
      'storeReaction timed out'
    )
  );
}

/**
 * Delete a reaction
 */
export async function deleteReaction(
  messageId: string,
  userId: string,
  emoji: string
): Promise<void> {
  return withWriteQueue(() =>
    withTimeout(
      withAutoReinit(async () => {
        const store = getStore(MESSAGE_STORES.MESSAGE_REACTIONS, 'readwrite');
        const id = `${messageId}:${userId}:${emoji}`;
        const request = store.delete(id);
        request.onsuccess = () => {};
        request.onerror = () => { throw request.error; };
      }),
      5000,
      'deleteReaction timed out'
    )
  );
}

/**
 * Get all reactions for a message
 */
export async function getReactionsForMessage(messageId: string): Promise<MessageReactionRecord[]> {
  return new Promise((resolve, reject) => {
    const store = getStore(MESSAGE_STORES.MESSAGE_REACTIONS);
    const index = store.index('messageId');
    const request = index.getAll(messageId);
    request.onsuccess = () => resolve(request.result as MessageReactionRecord[]);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Get reaction counts for a message (aggregated by emoji)
 * Returns Map<emoji, { count: number; users: string[] }>
 */
export async function getReactionCounts(messageId: string): Promise<Map<string, { count: number; users: string[] }>> {
  const reactions = await getReactionsForMessage(messageId);
  const map = new Map<string, { count: number; users: string[] }>();
  
  for (const reaction of reactions) {
    const existing = map.get(reaction.emoji) || { count: 0, users: [] };
    map.set(reaction.emoji, {
      count: existing.count + 1,
      users: [...existing.users, reaction.userId],
    });
  }
  
  return map;
}

// ==================== Folder Operations ====================

/**
 * Store a folder (create or update)
 */
export async function storeFolder(folder: FolderRecord): Promise<void> {
  return withWriteQueue(() =>
    withTimeout(
      withAutoReinit(async () => {
        const store = getStore(MESSAGE_STORES.FOLDERS, 'readwrite');
        const request = store.put(folder);
        request.onsuccess = () => {};
        request.onerror = () => { throw request.error; };
      }),
      5000,
      'storeFolder timed out'
    )
  );
}

/**
 * Get a folder by ID
 */
export async function getFolder(folderId: string): Promise<FolderRecord | undefined> {
  return new Promise((resolve, reject) => {
    const store = getStore(MESSAGE_STORES.FOLDERS);
    const request = store.get(folderId);
    request.onsuccess = () => resolve(request.result as FolderRecord | undefined);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Get all folders for a user
 */
export async function getFoldersByUserId(userId: string): Promise<FolderRecord[]> {
  return new Promise((resolve, reject) => {
    const store = getStore(MESSAGE_STORES.FOLDERS);
    const index = store.index('userId');
    const request = index.getAll(userId);
    request.onsuccess = () => resolve(request.result as FolderRecord[]);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Delete a folder
 * Also removes all chat-folder mappings for this folder
 */
export async function deleteFolder(folderId: string): Promise<void> {
  return withWriteQueue(() =>
    withTimeout(
      withAutoReinit(async () => {
        // Delete folder
        const folderStore = getStore(MESSAGE_STORES.FOLDERS, 'readwrite');
        const folderRequest = folderStore.delete(folderId);
        folderRequest.onsuccess = () => {};
        folderRequest.onerror = () => { throw folderRequest.error; };

        // Delete all chat-folder mappings for this folder
        const itemsStore = getStore(MESSAGE_STORES.CHAT_FOLDER_ITEMS, 'readwrite');
        const index = itemsStore.index('folderId');
        const range = IDBKeyRange.only(folderId);
        const cursorRequest = index.openCursor(range);

        await new Promise<void>((resolve, reject) => {
          cursorRequest.onsuccess = (event) => {
            const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
            if (cursor) {
              cursor.delete();
              cursor.continue();
            } else {
              resolve();
            }
          };
          cursorRequest.onerror = () => reject(cursorRequest.error);
        });
      }),
      10000,
      'deleteFolder timed out'
    )
  );
}

/**
 * Add a chat to a folder
 */
export async function addChatToFolder(chatId: string, folderId: string, order: number = 0): Promise<void> {
  return withWriteQueue(() =>
    withTimeout(
      withAutoReinit(async () => {
        const store = getStore(MESSAGE_STORES.CHAT_FOLDER_ITEMS, 'readwrite');
        const request = store.put({
          chatId,
          folderId,
          order,
        });
        request.onsuccess = () => {};
        request.onerror = () => { throw request.error; };
      }),
      5000,
      'addChatToFolder timed out'
    )
  );
}

/**
 * Remove a chat from a folder
 */
export async function removeChatFromFolder(chatId: string, folderId: string): Promise<void> {
  return withWriteQueue(() =>
    withTimeout(
      withAutoReinit(async () => {
        const store = getStore(MESSAGE_STORES.CHAT_FOLDER_ITEMS, 'readwrite');
        const request = store.delete([chatId, folderId]);
        request.onsuccess = () => {};
        request.onerror = () => { throw request.error; };
      }),
      5000,
      'removeChatFromFolder timed out'
    )
  );
}

/**
 * Get all folders for a chat
 */
export async function getChatFolders(chatId: string): Promise<ChatFolderItemRecord[]> {
  return new Promise((resolve, reject) => {
    const store = getStore(MESSAGE_STORES.CHAT_FOLDER_ITEMS);
    const index = store.index('folderId');
    const request = index.getAll(chatId);
    request.onsuccess = () => resolve(request.result as ChatFolderItemRecord[]);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Reorder chats within a folder
 * Updates the order field for multiple chat-folder mappings
 */
export async function reorderFolder(
  folderId: string,
  chatOrders: Array<{ chatId: string; order: number }>
): Promise<void> {
  return withWriteQueue(() =>
    withTimeout(
      withAutoReinit(async () => {
        const store = getStore(MESSAGE_STORES.CHAT_FOLDER_ITEMS, 'readwrite');

        for (const { chatId, order } of chatOrders) {
          // First check if the mapping exists
          const getRequest = store.get([chatId, folderId]);
          const exists = await new Promise<boolean>((resolve, reject) => {
            getRequest.onsuccess = () => resolve(!!getRequest.result);
            getRequest.onerror = () => reject(getRequest.error);
          });

          if (!exists) {
            // If mapping doesn't exist, create it
            const putRequest = store.put({ chatId, folderId, order });
            putRequest.onsuccess = () => {};
            putRequest.onerror = () => { throw putRequest.error; };
          } else {
            // Update existing mapping
            const updateRequest = store.put({ chatId, folderId, order });
            updateRequest.onsuccess = () => {};
            updateRequest.onerror = () => { throw updateRequest.error; };
          }
        }
      }),
      10000,
      'reorderFolder timed out'
    )
  );
}

/**
 * Clear all folders (for logout/debug)
 */
export async function clearAllFolders(): Promise<void> {
  return withWriteQueue(() =>
    withTimeout(
      new Promise<void>((resolve, reject) => {
        const storeNames = [MESSAGE_STORES.FOLDERS, MESSAGE_STORES.CHAT_FOLDER_ITEMS];
        let completed = 0;

        for (const storeName of storeNames) {
          const store = getStore(storeName, 'readwrite');
          const request = store.clear();
          request.onsuccess = () => {
            completed++;
            if (completed === storeNames.length) {
              resolve();
            }
          };
          request.onerror = () => reject(request.error);
        }
      }),
      10000,
      'clearAllFolders timed out'
    )
  );
}

/**
 * Get ALL folders stored on this device, sorted by `order` ascending.
 *
 * Unlike `getFoldersByUserId(userId)`, this does not require a userId —
 * it is intended for UI surfaces (e.g. FolderManagementDialog) that
 * load folders at dialog-open time without having to plumb the user id
 * through. On a single-user device the two functions return the same set.
 */
export async function getAllFolders(): Promise<StoredFolder[]> {
  const db = await initMessagesDB();
  const tx = db.transaction(MESSAGE_STORES.FOLDERS, 'readonly');
  const store = tx.objectStore(MESSAGE_STORES.FOLDERS);
  const all = await new Promise<StoredFolder[]>((resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => resolve((request.result as StoredFolder[]) ?? []);
    request.onerror = () => reject(request.error);
  });
  // Wait for the transaction to complete before returning. `tx.done` is a
  // Promise available on modern browsers; fall back to event listeners for
  // older/TypeScript DOM lib versions that don't expose it.
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  return all.sort((a, b) => a.order - b.order);
}

/**
 * Save (create or update) a folder. Wraps the existing `storeFolder` with a
 * UI-friendly signature accepting the StoredFolder shape.
 */
export async function saveFolder(folder: StoredFolder): Promise<void> {
  const record: FolderRecord = {
    id: folder.id,
    userId: '', // Filled by the server / useChatWebSocket on folder.create
    name: folder.name,
    color: folder.color ?? null,
    order: folder.order,
    createdAt: folder.createdAt,
    updatedAt: folder.updatedAt,
  };
  await storeFolder(record);
}

/**
 * Delete a folder from IndexedDB (UI-friendly alias for `deleteFolder`).
 * Also cascades to chat-folder mappings for the deleted folder.
 */
export async function deleteFolderFromDb(folderId: string): Promise<void> {
  await deleteFolder(folderId);
}

// ==================== Contacts Operations ====================

/**
 * Get all contacts from address book
 * Sorted by: favorites first, then by addedAt (newest first)
 */
export async function getAllContacts(): Promise<ContactRecord[]> {
  return withAutoReinit(async () => {
    return new Promise<ContactRecord[]>((resolve, reject) => {
      const store = getStore(MESSAGE_STORES.CONTACTS);
      const request = store.getAll();
      request.onsuccess = () => {
        const contacts = request.result as ContactRecord[];
        // Sort: favorites first, then by addedAt descending
        contacts.sort((a, b) => {
          if (a.isFavorite !== b.isFavorite) {
            return b.isFavorite ? 1 : -1;
          }
          return b.addedAt - a.addedAt;
        });
        resolve(contacts);
      };
      request.onerror = () => reject(request.error);
    });
  });
}

/**
 * Get a contact by user ID
 */
export async function getContact(userId: string): Promise<ContactRecord | null> {
  return withAutoReinit(async () => {
    return new Promise<ContactRecord | null>((resolve, reject) => {
      const store = getStore(MESSAGE_STORES.CONTACTS);
      const request = store.get(userId);
      request.onsuccess = () => resolve(request.result as ContactRecord | null);
      request.onerror = () => reject(request.error);
    });
  });
}

/**
 * Add a new contact
 * Throws error if contact already exists
 */
export async function addContact(userId: string, username: string, displayName: string, avatar?: string, notes?: string, isFavorite: boolean = false): Promise<ContactRecord> {
  return withWriteQueue(() =>
    withTimeout(
      withAutoReinit(async () => {
        const store = getStore(MESSAGE_STORES.CONTACTS, 'readwrite');
        
        // Check if contact already exists
        const existing = await new Promise<ContactRecord | null>((resolve, reject) => {
          const request = store.get(userId);
          request.onsuccess = () => resolve(request.result as ContactRecord | null);
          request.onerror = () => reject(request.error);
        });
        
        if (existing) {
          throw new Error('Contact already exists');
        }
        
        const now = Date.now();
        const newContact: ContactRecord = {
          id: userId,
          username,
          displayName,
          avatar,
          notes,
          isFavorite,
          addedAt: now,
          updatedAt: now,
        };
        
        const request = store.put(newContact);
        await new Promise<void>((resolve, reject) => {
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        });
        
        return newContact;
      }),
      5000,
      'addContact timed out'
    )
  );
}

/**
 * Update a contact
 * Only allows updating: displayName, notes, isFavorite
 */
export async function updateContact(userId: string, updates: Partial<Pick<ContactRecord, 'displayName' | 'notes' | 'isFavorite'>>): Promise<void> {
  return withWriteQueue(() =>
    withTimeout(
      withAutoReinit(async () => {
        const store = getStore(MESSAGE_STORES.CONTACTS, 'readwrite');
        
        // Get existing contact
        const existing = await new Promise<ContactRecord | null>((resolve, reject) => {
          const request = store.get(userId);
          request.onsuccess = () => resolve(request.result as ContactRecord | null);
          request.onerror = () => reject(request.error);
        });
        
        if (!existing) {
          throw new Error('Contact not found');
        }
        
        // Update allowed fields
        const updated: ContactRecord = {
          ...existing,
          ...updates,
          updatedAt: Date.now(),
        };
        
        const request = store.put(updated);
        await new Promise<void>((resolve, reject) => {
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        });
      }),
      5000,
      'updateContact timed out'
    )
  );
}

/**
 * Delete a contact
 */
export async function deleteContact(userId: string): Promise<void> {
  return withWriteQueue(() =>
    withTimeout(
      withAutoReinit(async () => {
        const store = getStore(MESSAGE_STORES.CONTACTS, 'readwrite');
        const request = store.delete(userId);
        await new Promise<void>((resolve, reject) => {
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        });
      }),
      5000,
      'deleteContact timed out'
    )
  );
}

/**
 * Search contacts by username or displayName (case-insensitive partial match)
 */
export async function searchContacts(query: string): Promise<ContactRecord[]> {
  const lowerQuery = query.toLowerCase();
  return withAutoReinit(async () => {
    return new Promise<ContactRecord[]>((resolve, reject) => {
      const store = getStore(MESSAGE_STORES.CONTACTS);
      const request = store.getAll();
      request.onsuccess = () => {
        const all = request.result as ContactRecord[];
        const filtered = all.filter(c => 
          c.username.toLowerCase().includes(lowerQuery) ||
          (c.displayName && c.displayName.toLowerCase().includes(lowerQuery))
        );
        resolve(filtered);
      };
      request.onerror = () => reject(request.error);
    });
  });
}

/**
 * Get favorite contacts only
 */
export async function getFavoriteContacts(): Promise<ContactRecord[]> {
  return withAutoReinit(async () => {
    return new Promise<ContactRecord[]>((resolve, reject) => {
      const store = getStore(MESSAGE_STORES.CONTACTS);
      const index = store.index('isFavorite');
      const request = index.getAll(IDBKeyRange.only(true));
      request.onsuccess = () => {
        const favorites = request.result as ContactRecord[];
        favorites.sort((a, b) => b.addedAt - a.addedAt);
        resolve(favorites);
      };
      request.onerror = () => reject(request.error);
    });
  });
}

/**
 * Toggle contact favorite status
 */
export async function toggleContactFavorite(userId: string): Promise<void> {
  return withWriteQueue(() =>
    withTimeout(
      withAutoReinit(async () => {
        const store = getStore(MESSAGE_STORES.CONTACTS, 'readwrite');
        
        const existing = await new Promise<ContactRecord | null>((resolve, reject) => {
          const request = store.get(userId);
          request.onsuccess = () => resolve(request.result as ContactRecord | null);
          request.onerror = () => reject(request.error);
        });
        
        if (!existing) {
          throw new Error('Contact not found');
        }
        
        const updated: ContactRecord = {
          ...existing,
          isFavorite: !existing.isFavorite,
          updatedAt: Date.now(),
        };
        
        const request = store.put(updated);
        await new Promise<void>((resolve, reject) => {
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        });
      }),
      5000,
      'toggleContactFavorite timed out'
    )
  );
}

/**
 * Store multiple contacts with merge logic (for P2P sync)
 * - If contact exists: update fields (except id, username), use max(updatedAt)
 * - If contact doesn't exist: add new
 * - Does NOT delete local contacts that are not in the incoming array
 * 
 * Returns array of results: { success: boolean, contactId: string, error?: string }
 */
export async function storeContacts(contacts: ContactRecord[]): Promise<{ success: boolean; contactId: string; error?: string }[]> {
  const results: { success: boolean; contactId: string; error?: string }[] = [];
  
  for (const contact of contacts) {
    try {
      await withWriteQueue(() =>
        withTimeout(
          withAutoReinit(async () => {
            const store = getStore(MESSAGE_STORES.CONTACTS, 'readwrite');
            
            // Check if contact already exists
            const existing = await new Promise<ContactRecord | null>((resolve, reject) => {
              const request = store.get(contact.id);
              request.onsuccess = () => resolve(request.result as ContactRecord | null);
              request.onerror = () => reject(request.error);
            });
            
            if (existing) {
              // Merge: update allowed fields, preserve id and username
              const merged: ContactRecord = {
                ...existing,
                ...contact,
                id: existing.id,         // Never change id
                username: existing.username, // Never change username
                updatedAt: Math.max(existing.updatedAt, contact.updatedAt),
              };
              
              const request = store.put(merged);
              await new Promise<void>((resolve, reject) => {
                request.onsuccess = () => resolve();
                request.onerror = () => reject(request.error);
              });
            } else {
              // Add new contact
              const request = store.put(contact);
              await new Promise<void>((resolve, reject) => {
                request.onsuccess = () => resolve();
                request.onerror = () => reject(request.error);
              });
            }
          }),
          5000,
          'storeContacts item timed out'
        )
      );
      
      results.push({ success: true, contactId: contact.id });
    } catch (error: any) {
      console.error(`[db.ts] Failed to store contact ${contact.id}:`, error);
      results.push({ 
        success: false, 
        contactId: contact.id, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
    }
  }
  
  return results;
}

// ==================== User Cache Operations ====================

/**
 * Get a cached user by userId and optional chatId
 */
export async function getUserCache(userId: string, chatId?: string): Promise<UserCacheRecord | null> {
  return withAutoReinit(async () => {
    if (chatId) {
      // Search for record with specific userId and chatId
      return new Promise<UserCacheRecord | null>((resolve, reject) => {
        const store = getStore(MESSAGE_STORES.USER_CACHE);
        const index = store.index('userId');
        const request = index.openCursor(IDBKeyRange.only(userId));
        
        request.onsuccess = (event) => {
          const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
          if (cursor) {
            const record = cursor.value as UserCacheRecord;
            if (record.chatId === chatId) {
              resolve(record);
              return;
            }
            cursor.continue();
          } else {
            resolve(null);
          }
        };
        request.onerror = () => reject(request.error);
      });
    } else {
      // Get any cached record for this user (first match)
      return new Promise<UserCacheRecord | null>((resolve, reject) => {
        const store = getStore(MESSAGE_STORES.USER_CACHE);
        const index = store.index('userId');
        const request = index.openCursor(IDBKeyRange.only(userId));
        
        request.onsuccess = (event) => {
          const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
          if (cursor) {
            resolve(cursor.value as UserCacheRecord);
          } else {
            resolve(null);
          }
        };
        request.onerror = () => reject(request.error);
      });
    }
  });
}

/**
 * Cache multiple chat participants at once
 */
export async function cacheChatParticipants(chatId: string, participants: Array<{
  id: string;
  username: string;
  displayName?: string;
  avatar?: string;
  role?: string;
  joinedAt?: string;
}>): Promise<void> {
  return withWriteQueue(() =>
    withTimeout(
      withAutoReinit(async () => {
        const store = getStore(MESSAGE_STORES.USER_CACHE, 'readwrite');
        const now = Date.now();
        
        for (const p of participants) {
          const id = `${p.id}:${chatId}`;
          
          // Check if record exists and is recent (less than 7 days old)
          const existing = await new Promise<UserCacheRecord | null>((resolve, reject) => {
            const request = store.get(id);
            request.onsuccess = () => resolve(request.result as UserCacheRecord | null);
            request.onerror = () => reject(request.error);
          });
          
          const isRecent = existing && (now - existing.cachedAt < 7 * 24 * 60 * 60 * 1000);
          
          if (!existing || !isRecent) {
            // Create or update record
            const record: UserCacheRecord = {
              id,
              userId: p.id,
              chatId,
              username: p.username,
              displayName: p.displayName,
              avatar: p.avatar,
              role: p.role,
              joinedAt: p.joinedAt,
              cachedAt: now,
              source: 'chat_participant',
            };
            
            const request = store.put(record);
            await new Promise<void>((resolve, reject) => {
              request.onsuccess = () => resolve();
              request.onerror = () => reject(request.error);
            });
          }
        }
      }),
      10000,
      'cacheChatParticipants timed out'
    )
  );
}

/**
 * Cache a message sender (if not forwarded)
 */
export async function cacheMessageSender(
  senderId: string,
  senderUsername: string,
  chatId: string,
  sender?: { displayName?: string; avatar?: string },
  metadata?: any
): Promise<void> {
  return withWriteQueue(() =>
    withTimeout(
      withAutoReinit(async () => {
        // Don't cache forwarded message senders
        if (metadata?.forwardedFrom) {
          return;
        }
        
        const store = getStore(MESSAGE_STORES.USER_CACHE, 'readwrite');
        const id = `${senderId}:${chatId}`;
        
        // Check if already exists
        const existing = await new Promise<UserCacheRecord | null>((resolve, reject) => {
          const request = store.get(id);
          request.onsuccess = () => resolve(request.result as UserCacheRecord | null);
          request.onerror = () => reject(request.error);
        });
        
        if (!existing) {
          const record: UserCacheRecord = {
            id,
            userId: senderId,
            chatId,
            username: senderUsername,
            displayName: sender?.displayName,
            avatar: sender?.avatar,
            cachedAt: Date.now(),
            source: 'message_sender',
          };
          
          const request = store.put(record);
          await new Promise<void>((resolve, reject) => {
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
          });
        }
      }),
      5000,
      'cacheMessageSender timed out'
    )
  );
}

/**
 * Get all cached participants for a chat
 */
export async function getChatParticipants(chatId: string): Promise<UserCacheRecord[]> {
  return withAutoReinit(async () => {
    return new Promise<UserCacheRecord[]>((resolve, reject) => {
      const store = getStore(MESSAGE_STORES.USER_CACHE);
      const index = store.index('chatId');
      const request = index.getAll(chatId);
      request.onsuccess = () => {
        const participants = request.result as UserCacheRecord[];
        // Sort: contacts first, then by cachedAt (newest first)
        // Note: We can't easily sort by contacts here without additional lookup,
        // but we can sort by cachedAt
        participants.sort((a, b) => b.cachedAt - a.cachedAt);
        resolve(participants);
      };
      request.onerror = () => reject(request.error);
    });
  });
}

/**
 * Clear user cache for a specific chat
 */
export async function clearChatCache(chatId: string): Promise<void> {
  return withWriteQueue(() =>
    withTimeout(
      withAutoReinit(async () => {
        const store = getStore(MESSAGE_STORES.USER_CACHE, 'readwrite');
        const index = store.index('chatId');
        
        const records = await new Promise<UserCacheRecord[]>((resolve, reject) => {
          const request = index.getAll(chatId);
          request.onsuccess = () => resolve(request.result as UserCacheRecord[]);
          request.onerror = () => reject(request.error);
        });
        
        for (const record of records) {
          const request = store.delete(record.id);
          await new Promise<void>((resolve, reject) => {
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
          });
        }
      }),
      10000,
      'clearChatCache timed out'
    )
  );
}

/**
 * Clear stale entries from user cache
 * @param maxAgeDays - Maximum age in days (default 7)
 */
export async function clearStaleUserCache(maxAgeDays: number = 7): Promise<void> {
  const cutoffTime = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  
  return withWriteQueue(() =>
    withTimeout(
      withAutoReinit(async () => {
        const store = getStore(MESSAGE_STORES.USER_CACHE, 'readwrite');
        const allRecords = await new Promise<UserCacheRecord[]>((resolve, reject) => {
          const request = store.getAll();
          request.onsuccess = () => resolve(request.result as UserCacheRecord[]);
          request.onerror = () => reject(request.error);
        });
        
        const staleIds = allRecords
          .filter(r => r.cachedAt < cutoffTime)
          .map(r => r.id);
        
        for (const id of staleIds) {
          const request = store.delete(id);
          await new Promise<void>((resolve, reject) => {
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
          });
        }
      }),
      30000,
      'clearStaleUserCache timed out'
    )
  );
}

/**
 * Clear all contacts (for logout/debug)
 */
export async function clearAllContacts(): Promise<void> {
  return withWriteQueue(() =>
    withTimeout(
      withAutoReinit(async () => {
        const store = getStore(MESSAGE_STORES.CONTACTS, 'readwrite');
        const request = store.clear();
        await new Promise<void>((resolve, reject) => {
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        });
      }),
      5000,
      'clearAllContacts timed out'
    )
  );
}

/**
 * Clear all user cache (for logout/debug)
 */
export async function clearAllUserCache(): Promise<void> {
  return withWriteQueue(() =>
    withTimeout(
      withAutoReinit(async () => {
        const store = getStore(MESSAGE_STORES.USER_CACHE, 'readwrite');
        const request = store.clear();
        await new Promise<void>((resolve, reject) => {
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        });
      }),
      10000,
      'clearAllUserCache timed out'
    )
  );
}

/**
 * Append a local-only SYSTEM message to a chat (F8).
 *
 * Used to surface group lifecycle events ("X добавил Y", "Группа создана")
 * that the backend doesn't (yet) emit as `system.chat_created` /
 * `system.participant_joined` envelopes. Storing the message in
 * IndexedDB makes it appear in the regular message list on next
 * `useMessages` load — no separate system-message renderer needed.
 *
 * The message is marked with `messageType: 6` and `type: 'SYSTEM'`
 * so the UI can style it differently if desired (currently rendered
 * like a normal text message).
 *
 * NOTE: this is a client-side best-effort annotation. If the backend
 * later starts emitting `system.participant_joined` events we should
 * remove the local calls and rely on the server copy to avoid
 * duplicates.
 *
 * @param chatId Target chat
 * @param content Human-readable text to display
 * @param metadata Optional structured payload (e.g. { kind: 'participant_added', userId })
 * @returns The id of the created message
 */
export async function addSystemMessage(
  chatId: string,
  content: string,
  metadata?: Record<string, unknown>
): Promise<string> {
  const id = `sys-${crypto.randomUUID()}`;
  const now = Date.now();
  await storeMessage({
    id,
    chatId,
    senderId: 'system',
    senderUsername: 'System',
    senderDeviceId: 0,
    content,
    timestamp: now,
    createdAt: now,
    messageType: 6, // SYSTEM
    isOutgoing: false,
    status: 'sent',
    type: 'SYSTEM',
    metadata,
  });
  return id;
}



