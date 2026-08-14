/**
 * Attachments Storage Service
 * Provides IndexedDB storage for decrypted attachments with deduplication
 * 
 * Stage 5.3.4: File storage with content-hash based deduplication
 * - Stores binary data indexed by SHA-256 hash
 * - LRU cleanup strategy based on timestamp and access count
 * - Default storage limit: 500 MB per device
 */

import { fileLogger } from '@/lib/utils/file-logger';

import { initMessagesDB,MESSAGE_STORES } from './db';

// ==================== Types ====================

/**
 * Stored attachment record in IndexedDB
 * Keyed by contentHash for deduplication
 */
export interface StoredAttachment {
  id: string;              // contentHash (SHA-256)
  data: Uint8Array;        // Binary attachment data
  size: number;            // Size in bytes
  timestamp: number;       // Last access time (for LRU)
  accessCount: number;     // Access frequency
  createdAt: number;       // Initial storage time
}

/**
 * Storage statistics
 */
export interface StorageInfo {
  usedBytes: number;
  itemCount: number;
}

/**
 * Cleanup result
 */
export interface CleanupResult {
  deleted: number;
  freedBytes: number;
}

// ==================== Configuration ====================

const DEFAULT_MAX_SIZE_BYTES = 500 * 1024 * 1024; // 500 MB default
const CLEANUP_TARGET_PERCENTAGE = 0.8; // Clean up to 80% of max when limit reached

// ==================== Private Helpers ====================

/**
 * Get database instance
 */
async function getDB(): Promise<IDBDatabase> {
  return initMessagesDB();
}

/**
 * Timeout wrapper for IndexedDB operations
 */
async function withTimeout<T>(
  promise: Promise<T>,
  ms = 5000,
  errorMsg = 'Attachment operation timed out'
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(errorMsg)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

// Write queue for attachments (separate from messages to avoid blocking)
let attachmentWriteQueue: Promise<void> = Promise.resolve();

/**
 * Execute a write operation in a queue to prevent parallel IndexedDB writes
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

// ==================== Public API ====================

/**
 * Store decrypted attachment in IndexedDB (deduplicated by hash)
 * 
 * @param contentHash - SHA-256 hash of the content (used as primary key)
 * @param data - Binary attachment data
 * @returns Promise that resolves when storage is complete
 */
export async function storeAttachment(
  contentHash: string,
  data: Uint8Array
): Promise<void> {
  return withAttachmentWriteQueue(() =>
    withTimeout(
      new Promise(async (resolve, reject) => {
        const db = await getDB();
        const transaction = db.transaction(MESSAGE_STORES.ATTACHMENTS, 'readwrite');
        const store = transaction.objectStore(MESSAGE_STORES.ATTACHMENTS);

        // Check if attachment already exists (idempotent)
        const getRequest = store.get(contentHash);
        
        getRequest.onsuccess = () => {
          if (getRequest.result) {
            // Attachment already exists, update access timestamp
            const existing = getRequest.result as StoredAttachment;
            fileLogger.logDeduplicationHit(contentHash, existing.size);
            
            const updated: StoredAttachment = {
              ...existing,
              timestamp: Date.now(),
              accessCount: existing.accessCount + 1,
            };
            
            const putRequest = store.put(updated);
            putRequest.onsuccess = () => {
              fileLogger.logStorageSave(contentHash, data.length, true);
              resolve();
            };
            putRequest.onerror = () => reject(putRequest.error);
          } else {
            // Store new attachment
            const attachment: StoredAttachment = {
              id: contentHash,
              data,
              size: data.length,
              timestamp: Date.now(),
              accessCount: 1,
              createdAt: Date.now(),
            };
            
            const putRequest = store.put(attachment);
            putRequest.onsuccess = () => {
              fileLogger.logStorageSave(contentHash, data.length, false);
              resolve();
            };
            putRequest.onerror = () => reject(putRequest.error);
          }
        };
        
        getRequest.onerror = () => reject(getRequest.error);
      }),
      10000,
      'storeAttachment timed out'
    )
  );
}

/**
 * Retrieve attachment from IndexedDB
 * Updates access timestamp and count on successful retrieval
 * 
 * @param contentHash - SHA-256 hash of the content
 * @returns Binary data or null if not found
 */
export async function getAttachment(
  contentHash: string
): Promise<Uint8Array | null> {
  return withTimeout(
    new Promise(async (resolve, reject) => {
      const db = await getDB();
      const transaction = db.transaction(MESSAGE_STORES.ATTACHMENTS, 'readwrite');
      const store = transaction.objectStore(MESSAGE_STORES.ATTACHMENTS);

      const request = store.get(contentHash);
      
      request.onsuccess = () => {
        if (!request.result) {
          fileLogger.logCacheMiss(contentHash);
          resolve(null);
          return;
        }

        const attachment = request.result as StoredAttachment;
        fileLogger.logStorageLoad(contentHash, attachment.data.length);
        
        // Update access metadata (async, don't block return)
        const updated: StoredAttachment = {
          ...attachment,
          timestamp: Date.now(),
          accessCount: attachment.accessCount + 1,
        };
        store.put(updated);
        
        resolve(attachment.data);
      };
      
      request.onerror = () => reject(request.error);
    }),
    5000,
    'getAttachment timed out'
  );
}

/**
 * Check if attachment exists (for deduplication)
 * Does not update access metadata
 * 
 * @param contentHash - SHA-256 hash of the content
 * @returns True if attachment exists in storage
 */
export async function hasAttachment(contentHash: string): Promise<boolean> {
  return withTimeout(
    new Promise(async (resolve, reject) => {
      const db = await getDB();
      const transaction = db.transaction(MESSAGE_STORES.ATTACHMENTS, 'readonly');
      const store = transaction.objectStore(MESSAGE_STORES.ATTACHMENTS);

      const request = store.get(contentHash);
      
      request.onsuccess = () => {
        const exists = !!request.result;
        if (exists) {
          fileLogger.logCacheHit(contentHash, 0); // Size unknown at this point
        } else {
          fileLogger.logCacheMiss(contentHash);
        }
        resolve(exists);
      };
      
      request.onerror = () => reject(request.error);
    }),
    3000,
    'hasAttachment timed out'
  );
}

/**
 * Delete attachment from IndexedDB
 * Should be called when reference count reaches 0
 * 
 * @param contentHash - SHA-256 hash of the content
 */
export async function deleteAttachment(contentHash: string): Promise<void> {
  return withAttachmentWriteQueue(() =>
    withTimeout(
      new Promise(async (resolve, reject) => {
        const db = await getDB();
        const transaction = db.transaction(MESSAGE_STORES.ATTACHMENTS, 'readwrite');
        const store = transaction.objectStore(MESSAGE_STORES.ATTACHMENTS);

        const request = store.delete(contentHash);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      }),
      5000,
      'deleteAttachment timed out'
    )
  );
}

/**
 * Get storage statistics
 * 
 * @returns Total used bytes and item count
 */
export async function getStorageInfo(): Promise<StorageInfo> {
  return withTimeout(
    new Promise(async (resolve, reject) => {
      const db = await getDB();
      const transaction = db.transaction(MESSAGE_STORES.ATTACHMENTS, 'readonly');
      const store = transaction.objectStore(MESSAGE_STORES.ATTACHMENTS);

      const cursorRequest = store.openCursor();
      let usedBytes = 0;
      let itemCount = 0;

      cursorRequest.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor) {
          const attachment = cursor.value as StoredAttachment;
          usedBytes += attachment.size;
          itemCount++;
          cursor.continue();
        } else {
          resolve({ usedBytes, itemCount });
        }
      };

      cursorRequest.onerror = () => reject(cursorRequest.error);
    }),
    10000,
    'getStorageInfo timed out'
  );
}

/**
 * Cleanup old attachments using LRU strategy
 * Removes oldest and least-accessed items until storage is below target
 * 
 * @param maxSizeBytes - Maximum storage size (default 500 MB)
 * @returns Statistics about deleted items
 */
export async function cleanupAttachments(
  maxSizeBytes: number = DEFAULT_MAX_SIZE_BYTES
): Promise<CleanupResult> {
  return withAttachmentWriteQueue(() =>
    withTimeout(
      new Promise(async (resolve, reject) => {
        const db = await getDB();
        const transaction = db.transaction(MESSAGE_STORES.ATTACHMENTS, 'readwrite');
        const store = transaction.objectStore(MESSAGE_STORES.ATTACHMENTS);
        
        // Use timestamp index to get items sorted by last access (oldest first)
        const index = store.index('timestamp');
        const cursorRequest = index.openCursor();
        
        let currentSize = 0;
        const attachments: { hash: string; size: number; timestamp: number; accessCount: number }[] = [];

        // Collect all attachments with metadata
        cursorRequest.onsuccess = (event) => {
          const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
          if (cursor) {
            const attachment = cursor.value as StoredAttachment;
            attachments.push({
              hash: attachment.id,
              size: attachment.size,
              timestamp: attachment.timestamp,
              accessCount: attachment.accessCount,
            });
            currentSize += attachment.size;
            cursor.continue();
          } else {
            // All items collected, now decide what to delete
            const targetSize = maxSizeBytes * CLEANUP_TARGET_PERCENTAGE;
            
            if (currentSize <= targetSize) {
              // No cleanup needed
              resolve({ deleted: 0, freedBytes: 0 });
              return;
            }

            // Sort by access count (ascending), then by timestamp (oldest first)
            // This prioritizes removing rarely accessed items, then oldest
            attachments.sort((a, b) => {
              if (a.accessCount !== b.accessCount) {
                return a.accessCount - b.accessCount; // Least accessed first
              }
              return a.timestamp - b.timestamp; // Oldest first
            });

            let freedBytes = 0;
            let deleted = 0;
            const toDelete: string[] = [];

            // Delete until we're under target
            for (const item of attachments) {
              if (currentSize - freedBytes <= targetSize) {
                break;
              }
              toDelete.push(item.hash);
              freedBytes += item.size;
              deleted++;
            }

            // Perform deletions
            const deletePromises = toDelete.map(hash => 
              new Promise<void>((delResolve, delReject) => {
                const delRequest = store.delete(hash);
                delRequest.onsuccess = () => delResolve();
                delRequest.onerror = () => delReject(delRequest.error);
              })
            );

            Promise.all(deletePromises)
              .then(() => resolve({ deleted, freedBytes }))
              .catch(reject);
          }
        };

        cursorRequest.onerror = () => reject(cursorRequest.error);
      }),
      30000,
      'cleanupAttachments timed out'
    )
  );
}

/**
 * Pre-warm cache with multiple attachments
 * Efficiently stores multiple attachments in a single transaction
 * 
 * @param attachments - Array of {contentHash, data} to store
 */
export async function storeAttachmentsBatch(
  attachments: { contentHash: string; data: Uint8Array }[]
): Promise<void> {
  return withAttachmentWriteQueue(() =>
    withTimeout(
      new Promise(async (resolve, reject) => {
        const db = await getDB();
        const transaction = db.transaction(MESSAGE_STORES.ATTACHMENTS, 'readwrite');
        const store = transaction.objectStore(MESSAGE_STORES.ATTACHMENTS);

        let completed = 0;
        let failed = 0;

        for (const { contentHash, data } of attachments) {
          const attachment: StoredAttachment = {
            id: contentHash,
            data,
            size: data.length,
            timestamp: Date.now(),
            accessCount: 0, // Not accessed yet
            createdAt: Date.now(),
          };

          const request = store.put(attachment);
          
          request.onsuccess = () => {
            completed++;
            if (completed + failed === attachments.length) {
              if (failed > 0) {
                reject(new Error(`Batch storage failed for ${failed} items`));
              } else {
                resolve();
              }
            }
          };
          
          request.onerror = () => {
            failed++;
            if (completed + failed === attachments.length) {
              reject(new Error(`Batch storage failed for ${failed} items`));
            }
          };
        }

        // Handle empty array
        if (attachments.length === 0) {
          resolve();
        }
      }),
      30000,
      'storeAttachmentsBatch timed out'
    )
  );
}
