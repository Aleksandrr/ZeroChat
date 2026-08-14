/**
 * useAttachments - Hook for managing attachment decryption and caching
 * 
 * Stage 5.3.4: File deduplication and preview
 * - Caches decrypted attachments in IndexedDB (deduplicated by contentHash)
 * - Provides LRU cleanup and storage management
 * - Integrates with SignalContext for decryption
 */

import { useCallback, useEffect,useRef, useState } from 'react';

import { useSignal } from '@/contexts/SignalContext';
import {
  cleanupAttachments,
  getAttachment,
  getStorageInfo,
  hasAttachment,
  type StorageInfo,
  storeAttachment,
} from '@/lib/messages/attachments';
import { fileLogger } from '@/lib/utils/file-logger';
import type { Attachment } from '@/types';

// ==================== Types ====================

export interface UseAttachmentsResult {
  /** Get decrypted attachment (from cache or decrypt) */
  getAttachment: (attachment: Attachment, encryptedData?: Uint8Array) => Promise<Uint8Array | null>;
  
  /** Check if attachment is cached in IndexedDB */
  isCached: (contentHash: string) => Promise<boolean>;
  
  /** Decrypting state - set of attachment IDs currently being decrypted */
  decryptingAttachments: Set<string>;
  
  /** Decryption errors - map of attachment ID to error message */
  decryptErrors: Map<string, string>;
  
  /** Storage info */
  storageInfo: StorageInfo;
  
  /** Cleanup old attachments */
  cleanup: (maxSizeBytes?: number) => Promise<{ deleted: number; freedBytes: number }>;
  
  /** Clear error for an attachment */
  clearError: (attachmentId: string) => void;
  
  /** Pre-warm cache for multiple attachments */
  prewarmCache: (attachments: { attachment: Attachment; encryptedData: Uint8Array; senderInfo?: { senderId: string; senderDeviceId: number; messageType?: number } }[]) => Promise<void>;
}

// Helper to convert base64 to Uint8Array
function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

// ==================== Hook ====================

export function useAttachments(): UseAttachmentsResult {
  const signal = useSignal();
  
  // State for tracking decryption operations
  const [decryptingSet, setDecryptingSet] = useState<Set<string>>(new Set());
  const [errorMap, setErrorMap] = useState<Map<string, string>>(new Map());
  const [storageInfo, setStorageInfo] = useState<StorageInfo>({ usedBytes: 0, itemCount: 0 });
  
  // Use refs to avoid closure staleness in async operations
  const decryptingRef = useRef<Set<string>>(new Set());
  const errorRef = useRef<Map<string, string>>(new Map());
  
  // Sync refs with state
  useEffect(() => {
    decryptingRef.current = decryptingSet;
  }, [decryptingSet]);
  
  useEffect(() => {
    errorRef.current = errorMap;
  }, [errorMap]);

  // Update storage info periodically
  useEffect(() => {
    const updateStorageInfo = async () => {
      try {
        const info = await getStorageInfo();
        setStorageInfo(info);
      } catch {
        // Storage info update is best-effort
      }
    };
    
    updateStorageInfo();
    const interval = setInterval(updateStorageInfo, 30000); // Update every 30 seconds
    
    return () => clearInterval(interval);
  }, []);

  /**
   * Check if attachment is cached
   */
  const isCached = useCallback(async (contentHash: string): Promise<boolean> => {
    if (!contentHash) return false;
    try {
      return await hasAttachment(contentHash);
    } catch {
      return false;
    }
  }, []);

  /**
   * Decrypt attachment data
   * Note: In the actual implementation, attachments are decrypted as part of the message.
   * The encrypted attachment data comes from the message payload.
   */
  const decryptAttachment = useCallback(async (
    attachmentId: string,
    encryptedData: Uint8Array,
    senderId: string,
    senderDeviceId: number,
    messageType = 2
  ): Promise<Uint8Array | null> => {
    if (!signal.isInitialized) {
      throw new Error('Signal Protocol not initialized');
    }

    try {
      // The attachment data is encrypted with the same session as the message
      // We decrypt it using signal.decrypt
      const decryptedBase64 = await signal.decrypt(
        senderId,
        senderDeviceId,
        encryptedData,
        messageType
      );
      
      // Convert base64 back to binary
      return base64ToUint8Array(decryptedBase64);
    } catch (error) {
      console.error(`[useAttachments] Decryption failed for ${attachmentId}:`, error);
      throw error;
    }
  }, [signal]);

   /**
    * Get decrypted attachment - from cache or by decrypting
    */
   const getAttachmentData = useCallback(async (
     attachment: Attachment,
     encryptedData?: Uint8Array,
     senderInfo?: { senderId: string; senderDeviceId: number; messageType?: number }
   ): Promise<Uint8Array | null> => {
     const { id, contentHash } = attachment;
     
     if (!contentHash) {
       fileLogger.logError('attachment_no_hash', new Error('Attachment has no content hash'), { attachmentId: id });
       return null;
     }

     // Check if already decrypting
     if (decryptingRef.current.has(id)) {
       fileLogger.logDebug(`[useAttachments] Attachment ${id} already decrypting, waiting...`);
       // Wait for existing decryption (poll for result)
       return new Promise((resolve) => {
         const checkInterval = setInterval(async () => {
           if (!decryptingRef.current.has(id)) {
             clearInterval(checkInterval);
             // Check cache or errors
             const cached = await getAttachment(contentHash);
             if (cached) {
               fileLogger.logCacheHit(contentHash, cached.length);
               resolve(cached);
             } else if (errorRef.current.has(id)) {
               resolve(null);
             } else {
               resolve(null);
             }
           }
         }, 100);
         
         // Timeout after 30 seconds
         setTimeout(() => {
           clearInterval(checkInterval);
           resolve(null);
         }, 30000);
       });
     }

     // Check IndexedDB cache first
     try {
       const cached = await getAttachment(contentHash);
       if (cached) {
         fileLogger.logCacheHit(contentHash, cached.length);
         return cached;
       }
       fileLogger.logCacheMiss(contentHash);
     } catch (error) {
       fileLogger.logError('cache_check', error as Error, { contentHash });
       // Cache miss or error, continue with decryption
     }

     // If no encrypted data provided, we can't decrypt
     if (!encryptedData) {
       fileLogger.logError('no_encrypted_data', new Error('No encrypted data provided'), { attachmentId: id });
       return null;
     }

     // If no sender info, we can't decrypt
     if (!senderInfo) {
       fileLogger.logError('no_sender_info', new Error('No sender info provided'), { attachmentId: id });
       return null;
     }

     // Mark as decrypting
     setDecryptingSet(prev => new Set(prev).add(id));
     setErrorMap(prev => {
       const newMap = new Map(prev);
       newMap.delete(id);
       return newMap;
     });

     const decryptStartTime = Date.now();
     fileLogger.logDecryptionStart(id, attachment.fileName || 'unknown', encryptedData.length, senderInfo.senderId);

     try {
       // Decrypt the attachment
       const decrypted = await decryptAttachment(
         id,
         encryptedData,
         senderInfo.senderId,
         senderInfo.senderDeviceId,
         senderInfo.messageType
       );

       if (!decrypted) {
         throw new Error('Decryption returned empty data');
       }

       const decryptDuration = Date.now() - decryptStartTime;
       fileLogger.logDecryptionComplete(id, attachment.fileName || 'unknown', decrypted.length, decryptDuration);

       // Store in IndexedDB cache
       try {
         await storeAttachment(contentHash, decrypted);
         fileLogger.logStorageSave(contentHash, decrypted.length, false);
       } catch (error) {
         fileLogger.logError('cache_save', error as Error, { contentHash, size: decrypted.length });
         // Continue even if caching fails
       }

       return decrypted;
     } catch (error: any) {
       const errorMessage = error?.message || 'Decryption failed';
       fileLogger.logError('decryption', error as Error, {
         attachmentId: id,
         fileName: attachment.fileName,
         senderId: senderInfo.senderId,
         encryptedSize: encryptedData.length,
       });
       
       setErrorMap(prev => new Map(prev).set(id, errorMessage));
       return null;
     } finally {
       setDecryptingSet(prev => {
         const newSet = new Set(prev);
         newSet.delete(id);
         return newSet;
       });
     }
   }, [decryptAttachment]);

  /**
   * Clear error for an attachment
   */
  const clearError = useCallback((attachmentId: string) => {
    setErrorMap(prev => {
      const newMap = new Map(prev);
      newMap.delete(attachmentId);
      return newMap;
    });
  }, []);

  /**
   * Cleanup old attachments
   */
  const cleanup = useCallback(async (maxSizeBytes?: number): Promise<{ deleted: number; freedBytes: number }> => {
    try {
      const result = await cleanupAttachments(maxSizeBytes);
      // Update storage info after cleanup
      const info = await getStorageInfo();
      setStorageInfo(info);
      return result;
    } catch (error) {
      console.error('[useAttachments] Cleanup failed:', error);
      return { deleted: 0, freedBytes: 0 };
    }
  }, []);

  /**
   * Pre-warm cache for multiple attachments
   * Useful for pre-loading attachments when opening a chat
   */
  const prewarmCache = useCallback(async (
    items: { attachment: Attachment; encryptedData: Uint8Array; senderInfo?: { senderId: string; senderDeviceId: number; messageType?: number } }[]
  ): Promise<void> => {
    const promises = items.map(async ({ attachment, encryptedData, senderInfo }) => {
      // Skip if already cached
      if (await isCached(attachment.contentHash)) {
        return;
      }
      
      // Skip if no sender info (can't decrypt)
      if (!senderInfo) {
        return;
      }
      
      // Decrypt and cache
      try {
        await getAttachmentData(attachment, encryptedData, senderInfo);
      } catch {
        // Prewarm failure is non-critical
      }
    });
    
    await Promise.allSettled(promises);
  }, [isCached, getAttachmentData]);

  return {
    getAttachment: getAttachmentData,
    isCached,
    decryptingAttachments: decryptingSet,
    decryptErrors: errorMap,
    storageInfo,
    cleanup,
    clearError,
    prewarmCache,
  };
}
