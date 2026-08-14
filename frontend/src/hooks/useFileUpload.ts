/**
 * useFileUpload - Hook for managing file uploads in ZeroChat
 * Handles file selection, processing, encryption, and sending
 */

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef,useState } from 'react';

import { useAuth } from '@/contexts/AuthContext';
import { useSignal } from '@/contexts/SignalContext';
import { arrayBufferToBase64, base64ToArrayBuffer, establishedSessions } from '@/contexts/SignalContext';
import { useWebSocketContext } from '@/contexts/WebSocketContext';
import {
  FileProcessingError,
  formatBytes,
  type ProcessedFile,
  processFileForSending,
  type ProcessingOptions,
  type SendMode,
} from '@/lib/media';
import { storeMessage, storeMessageRecord } from '@/lib/messages';
import type { EncryptedMessage } from '@/lib/signal/types';
import type { PreKeyBundle } from '@/lib/signal/types';
import { encryptMessage, getCurrentDeviceId } from '@/lib/signal';
import { fileLogger } from '@/lib/utils/file-logger';
import { queryKeys } from '@/queries';
import { chatService } from '@/services/chat';
import { toast } from '@/stores/toast-store';

export interface UseFileUploadOptions {
  chatId: string;
  chatType?: 'private' | 'group' | 'favorites';
  recipientId?: string;
  onSuccess?: () => void;
  onError?: (error: Error) => void;
  onMessageSent?: (message: {
    id: string;
    chatId: string;
    content: string;
    attachments?: {
      id: string;
      type: string;
      fileName: string;
      size: number;
      mimeType: string;
      contentHash: string;
      url?: string;
      data?: string;
    }[]
  }) => void;
  /** Caption (подпись) для файлов - будет отправлен как текст сообщения */
  caption?: string;
}

export interface FileUploadItem {
  id: string;
  file: File;
  processedFile?: ProcessedFile;
  thumbnail?: string;
  status: 'pending' | 'processing' | 'ready' | 'uploading' | 'sent' | 'error';
  progress: number;
  error?: string;
}

export interface UseFileUploadResult {
  files: FileUploadItem[];
  addFiles: (files: File[]) => Promise<void>;
  removeFile: (index: number) => void;
  clearFiles: () => void;
  processing: boolean;
  overallProgress: number;
  sendFiles: (mode: SendMode, caption?: string) => Promise<void>;
  cancel: () => void;
  isUploading: boolean;
  generateThumbnail: (file: File) => Promise<string | undefined>;
}

// Maximum file size: 10MB
const MAX_FILE_SIZE = 10 * 1024 * 1024;

// Message record expiry for retry mechanism (7 days)
const MESSAGE_RECORD_EXPIRY_DAYS = 7;

// Supported image types for thumbnails
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp'];

// Supported video types
const VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime', 'video/avi'];

// Helper to convert Uint8Array to base64
function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

// Helper to compute SHA-256 hash from base64 data
async function computeSHA256(base64Data: string): Promise<string> {
  // Convert base64 to Uint8Array
  const binaryString = atob(base64Data);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  
  // Compute SHA-256 hash
  const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex;
}

// Encrypted device message for multi-device sync
interface EncryptedDeviceMessage {
  deviceId: number;
  content: string; // base64 encoded encrypted content
  messageType: number;
}

export function useFileUpload(options: UseFileUploadOptions): UseFileUploadResult {
  const { chatId, chatType = 'private', recipientId, onSuccess, onError, onMessageSent } = options;
  const { user } = useAuth();
  const signal = useSignal();
  const ws = useWebSocketContext();
  const queryClient = useQueryClient();

  const [files, setFiles] = useState<FileUploadItem[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Generate thumbnail for image/video files
  const generateThumbnail = useCallback(async (file: File): Promise<string | undefined> => {
    if (IMAGE_TYPES.includes(file.type)) {
      // U3: canvas-based resize to a 160px JPEG (70% quality) instead of
      // reading the full file as base64 — avoids storing multi-MB data URLs
      // for UI previews.
      try {
        const maxSize = 160;
        const bitmap = await createImageBitmap(file);
        const scale = Math.min(maxSize / bitmap.width, maxSize / bitmap.height, 1);
        const w = Math.max(1, Math.round(bitmap.width * scale));
        const h = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          bitmap.close();
          return undefined;
        }
        ctx.drawImage(bitmap, 0, 0, w, h);
        bitmap.close();
        return canvas.toDataURL('image/jpeg', 0.7);
      } catch (err) {
        console.error('[generateThumbnail] image resize failed:', err);
        return undefined;
      }
    }

    if (VIDEO_TYPES.includes(file.type)) {
      return new Promise((resolve) => {
        const video = document.createElement('video');
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');

        video.onloadeddata = () => {
          canvas.width = 160;
          canvas.height = 120;
          ctx?.drawImage(video, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', 0.7));
        };

        video.onerror = () => resolve(undefined);
        video.src = URL.createObjectURL(file);
        video.load();
      });
    }

    return undefined;
  }, []);

  // Helper to ensure session exists with a device (copied from useChatMessages)
  const ensureSession = useCallback(async (targetUserId: string, deviceId: number): Promise<void> => {
    const sessionExists = await signal.hasSession(targetUserId, deviceId);
    if (sessionExists) return;

    const bundle = await chatService.getPreKeyBundle(targetUserId, deviceId.toString());
    const preKeyBundle: PreKeyBundle = {
      deviceId,
      registrationId: bundle.registrationId,
      identityKey: new Uint8Array(base64ToArrayBuffer(bundle.identityKeyPub)),
      signedPreKeyId: bundle.signedPreKey.id,
      signedPreKey: new Uint8Array(base64ToArrayBuffer(bundle.signedPreKey.pub)),
      signedPreKeySignature: new Uint8Array(base64ToArrayBuffer(bundle.signedPreKey.sig)),
      preKeyId: bundle.oneTimeEcPreKey?.id || 0,
      preKey: bundle.oneTimeEcPreKey ? new Uint8Array(base64ToArrayBuffer(bundle.oneTimeEcPreKey.pub)) : undefined,
      kyberPreKeyId: bundle.oneTimePqPreKey?.id || bundle.pqLastResortPreKey?.id || 0,
      kyberPreKey: bundle.oneTimePqPreKey
        ? new Uint8Array(base64ToArrayBuffer(bundle.oneTimePqPreKey.pub))
        : bundle.pqLastResortPreKey
          ? new Uint8Array(base64ToArrayBuffer(bundle.pqLastResortPreKey.pub))
          : undefined,
      kyberPreKeySignature: bundle.oneTimePqPreKey
        ? new Uint8Array(base64ToArrayBuffer(bundle.oneTimePqPreKey.sig))
        : bundle.pqLastResortPreKey
          ? new Uint8Array(base64ToArrayBuffer(bundle.pqLastResortPreKey.sig))
          : undefined,
    };

    await signal.processPreKeyBundle(targetUserId, deviceId, preKeyBundle);
    establishedSessions.add(`${targetUserId}.${deviceId}`);
  }, [signal]);

   // Add files to the queue
   const addFiles = useCallback(async (newFiles: File[]) => {
      
      // Validate files
     const validFiles = newFiles.filter((file) => {
       if (file.size > MAX_FILE_SIZE) {
         toast.error(
           'Файл слишком большой',
           `${file.name} (${formatBytes(file.size)}) превышает лимит ${formatBytes(MAX_FILE_SIZE)}`
         );
         fileLogger.logError('file_validation', new Error(`File too large: ${file.name}`), {
           size: file.size,
           maxSize: MAX_FILE_SIZE,
         });
         return false;
       }
       return true;
     });

      // Create upload items
     const uploadItems: FileUploadItem[] = await Promise.all(
       validFiles.map(async (file) => {
         const startTime = Date.now();
         const thumbnail = await generateThumbnail(file);
         const thumbDuration = Date.now() - startTime;
         
         if (thumbnail) {
           fileLogger.logThumbnailGenerated(file.name, file.name, 'image', thumbDuration);
         }
         
         const item: FileUploadItem = {
           id: crypto.randomUUID(),
           file,
           thumbnail,
           status: 'pending',
           progress: 0,
         };
         
         fileLogger.logFileAdded(item.id, file.name, file.size);
         return item;
       })
     );

     setFiles((prev) => [...prev, ...uploadItems]);
   }, [generateThumbnail]);

   // Remove file from queue
   const removeFile = useCallback((index: number) => {
     setFiles((prev) => {
       const newFiles = [...prev];
       const removed = newFiles.splice(index, 1)[0];
       if (removed) {
         fileLogger.logFileRemoved(removed.id, removed.file.name);
         if (removed.thumbnail?.startsWith('blob:')) {
           URL.revokeObjectURL(removed.thumbnail);
         }
       }
       return newFiles;
     });
   }, []);

   // Clear all files
   const clearFiles = useCallback(() => {
     files.forEach((file) => {
       fileLogger.logFileRemoved(file.id, file.file.name);
       if (file.thumbnail?.startsWith('blob:')) {
         URL.revokeObjectURL(file.thumbnail);
       }
     });
     setFiles([]);
     setIsUploading(false);
   }, [files]);

  // Cancel upload
  const cancel = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setIsUploading(false);
    setFiles((prev) =>
      prev.map((f) => (f.status === 'uploading' ? { ...f, status: 'ready', progress: 0 } : f))
    );
  }, []);

   // Send processed files
   const sendFiles = useCallback(
     async (mode: SendMode, caption?: string) => {
       if (!user) {
         toast.error('Ошибка', 'Пользователь не авторизован');
         return;
       }

       if (chatType !== 'group' && chatType !== 'favorites' && !recipientId) {
         toast.error('Ошибка', 'Не удалось определить получателя');
         return;
       }

       if (files.length === 0) return;

      // Create abort controller for cancellation
      abortControllerRef.current = new AbortController();

       try {
         setIsUploading(true);

        // Process files first
        const processingOptions: ProcessingOptions = {
          skipCompressionIfSmall: true,
          smallFileThreshold: 100 * 1024,
        };

        // Capture pending files before state update to avoid race condition
        const pendingFiles = files.filter((f) => f.status === 'pending');
        
        if (pendingFiles.length === 0) {
          console.warn('[useFileUpload] No pending files to process');
          return;
        }
        
        // Create local copy with processing status
        const processingFiles: FileUploadItem[] = pendingFiles.map((f) => ({
          ...f,
          status: 'processing' as const,
        }));
        
        // Update state: mark pending files as processing
        setFiles((prev) =>
          prev.map((f) => (f.status === 'pending' ? { ...f, status: 'processing' } : f))
        );
        
        const processedItems: FileUploadItem[] = [];

        for (const item of processingFiles) {
          // item.status is guaranteed to be 'processing'

          const processingStartTime = Date.now();
          fileLogger.logProcessingStart(item.id, item.file.name, mode);

          try {
            const processed = await processFileForSending(item.file, mode, processingOptions);
            const processingDuration = Date.now() - processingStartTime;

            // Log compression or conversion
            if (processed.wasCompressed) {
              fileLogger.logCompressionApplied(
                item.id,
                item.file.name,
                item.file.size,
                processed.compressedSize,
                processingDuration
              );
            } else if (mode === 'audio' && processed.mimeType === 'audio/mpeg') {
              fileLogger.logConversionApplied(
                item.id,
                item.file.name,
                item.file.type || 'unknown',
                'audio/mpeg',
                processingDuration
              );
            }

            fileLogger.logProcessingComplete(
              item.id,
              item.file.name,
              item.file.size,
              processed.compressedSize,
              processingDuration
            );

            const updatedItem: FileUploadItem = {
              ...item,
              processedFile: processed,
              status: 'ready',
              progress: 100,
            };
            processedItems.push(updatedItem);

            setFiles((prev) =>
              prev.map((f) => (f.id === item.id ? updatedItem : f))
            );
          } catch (error) {
            fileLogger.logError('file_processing', error as Error, {
              fileId: item.id,
              fileName: item.file.name,
              mode,
            });
            const errorMessage =
              error instanceof FileProcessingError ? error.message : 'Ошибка обработки файла';

            const errorItem: FileUploadItem = {
              ...item,
              status: 'error',
              error: errorMessage,
            };

            setFiles((prev) => prev.map((f) => (f.id === item.id ? errorItem : f)));
            toast.error('Ошибка обработки', `${item.file.name}: ${errorMessage}`);
          }
        }

        // Check if any files are ready and have valid blob

        const readyFiles = processedItems.filter(
          (f) => f.status === 'ready' && f.processedFile && f.processedFile.blob.size > 0
        );
        
        if (readyFiles.length === 0) {
          const errorDetails = processedItems.map(f => ({
            id: f.id,
            name: f.file.name,
            status: f.status,
            hasProcessedFile: !!f.processedFile,
            blobSize: f.processedFile?.blob.size || 0,
            error: f.error,
          }));
          console.error('[FileUpload] No files ready for sending:', errorDetails);
          throw new Error('Нет файлов для отправки или все файлы пустые');
        }

        // Update status to uploading
        setFiles((prev) =>
          prev.map((f) =>
            f.status === 'ready' ? { ...f, status: 'uploading', progress: 0 } : f
          )
        );

        // Convert files to base64 for encryption
        const attachments: {
          id: string;
          type: string;
          data: string;
          fileName: string;
          size: number;
          mimeType: string;
          contentHash: string;
        }[] = [];

        for (const item of readyFiles) {
          const processedFile = item.processedFile;
          if (!processedFile) continue;

          // Validate blob size

          if (processedFile.blob.size === 0) {
            console.error(`[FileUpload] Blob size is zero for ${item.file.name}`);
            throw new Error(`Файл ${item.file.name} имеет нулевой размер после обработки`);
          }

          // Additional validation: ensure blob size matches compressedSize
          if (processedFile.blob.size !== processedFile.compressedSize) {
            console.warn(`[FileUpload] Size mismatch for ${item.file.name}:`, {
              blobSize: processedFile.blob.size,
              compressedSize: processedFile.compressedSize,
            });
          }

          // Update progress
          setFiles((prev) =>
            prev.map((f) => (f.id === item.id ? { ...f, progress: 30 } : f))
          );

          // Read file as base64

          const base64Data = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
              const result = reader.result as string;

              if (!result || !result.startsWith('data:')) {
                console.error(`[FileUpload] Invalid data URL for ${item.file.name}:`, result);
                reject(new Error(`Invalid data URL for file ${item.file.name}`));
                return;
              }
              
              // Remove data URL prefix
              const base64 = result.split(',')[1];

              if (base64 && base64.length > 0) {
                resolve(base64);
              } else {
                console.error(`[FileUpload] Failed to extract base64 data from ${item.file.name}`);
                reject(new Error(`Failed to extract base64 data from file ${item.file.name}`));
              }
            };
            reader.onerror = (e) => {
              console.error(`[FileUpload] FileReader error for ${item.file.name}:`, e);
              reject(new Error(`FileReader error for ${item.file.name}: ${e}`));
            };
            reader.readAsDataURL(processedFile.blob);
          });

          // Compute SHA-256 content hash for deduplication
          const contentHash = await computeSHA256(base64Data);

          // Determine attachment type with special handling for voice recordings
          // Voice recordings have filename starting with "voice-" (e.g., "voice-123.webm")
          const isVoiceRecording = item.file.name.startsWith('voice-');
          
          attachments.push({
            id: item.id,
            type: isVoiceRecording
              ? 'voice'
              : mode === 'photo'
                ? 'image'
                : mode === 'video'
                  ? 'video'
                  : mode === 'audio'
                    ? 'audio'
                    : 'file',
            data: base64Data,
            fileName: processedFile.fileName,
            size: processedFile.compressedSize,
            mimeType: processedFile.mimeType,
            contentHash, // Add SHA-256 hash
          });

          // Update progress
          setFiles((prev) =>
            prev.map((f) => (f.id === item.id ? { ...f, progress: 60 } : f))
          );
        }

        // Encrypt and send based on chat type
        if (chatType === 'group') {
          // Group message with attachments
          const encryptionStartTime = Date.now();
          fileLogger.logEncryptionStart(chatId, `group-${attachments.length} files`, attachments.length, 1);
          
          // Include attachments in encrypted content
          const messageContent = JSON.stringify({
            text: caption || '',
            attachments: attachments.map((a) => ({
              id: a.id,
              type: a.type,
              fileName: a.fileName,
              size: a.size,
              mimeType: a.mimeType,
              data: a.data, // Base64 data - will be encrypted
              contentHash: a.contentHash, // SHA-256 hash for deduplication
            })),
          });

          // Initialize Sender Key and get distribution message (SKDM)
          const skdm = await signal.initializeSenderKey(chatId);
          const skdmBase64 = arrayBufferToBase64(skdm);

          const encrypted: EncryptedMessage = await signal.encryptGroupMessage(
            chatId,
            messageContent
          );
          
          const encryptionDuration = Date.now() - encryptionStartTime;
          fileLogger.logEncryptionComplete(chatId, `group-${attachments.length} files`, encrypted.body.length, encryptionDuration);

          // Convert encrypted body to base64
          const encryptedContent = uint8ArrayToBase64(encrypted.body);

          // Log WebSocket message
          fileLogger.logWebSocketMessageSent(
            'group_message',
            chatId,
            attachments.length,
            encryptedContent.length
          );

          // Send group message WITHOUT separate attachments (they're encrypted in content)
          const sentMessageId = await ws.sendGroupMessage(
            chatId,
            user.id,
            signal.getDeviceId()?.toString() || '1',
            encryptedContent,
            undefined,
            undefined,
            undefined,
            undefined, // attachments (none)
            skdmBase64 // senderKeyDistribution
          );
          
          // Log success
          const fileIds = attachments.map(a => a.id);
          fileLogger.logSendSuccess(chatId, fileIds, `msg-${Date.now()}`, Date.now() - encryptionStartTime);
          
          // Save sent message to IndexedDB for sender with attachments
          if (user) {
            const currentDeviceId = signal.getDeviceId() || 0;
            
            const attachmentsForStore = attachments.map(a => ({
              id: a.id,
              type: a.type as 'image' | 'video' | 'audio' | 'file',
              fileName: a.fileName,
              size: a.size,
              mimeType: a.mimeType,
              data: a.data, // Store base64 data for immediate display (no decryption needed for own messages)
              contentHash: a.contentHash, // SHA-256 hash for deduplication
            }));
            
             try {
               const messageType = mode === 'photo' ? 'IMAGE' : mode === 'video' ? 'VIDEO' : mode === 'audio' ? 'AUDIO' : 'FILE';
               await storeMessage({
                 id: sentMessageId,
                 chatId,
                 senderId: user.id,
                 senderUsername: user.username,
                 senderDeviceId: currentDeviceId,
                 content: caption || '',
                 timestamp: Date.now(),
                 createdAt: Date.now(),
                 messageType: encrypted.type,
                 isOutgoing: true,
                 status: 'sent',
                 attachments: attachmentsForStore,
                 type: messageType,
               });
               
                queryClient.invalidateQueries({
                  queryKey: queryKeys.messages.chat(chatId),
                });

                void onMessageSent?.({
                  id: sentMessageId,
                  chatId,
                  content: caption || '',
                  attachments: attachmentsForStore,
                });
            } catch (err) {
              console.error('[useFileUpload] Failed to store sent group message:', err);
            }
          }
         } else if (chatType === 'favorites') {
           // Favorites message with attachments (multi-device sync for same user)
           if (!user || !recipientId) {
             throw new Error('User not authenticated or recipientId missing');
           }

           const currentDeviceId = getCurrentDeviceId() || 0;
           const timestamp = Date.now();
           const tempId = `temp-${Date.now()}`;

           const attachmentsForStore = attachments.map(a => ({
             id: a.id,
             type: a.type as 'image' | 'video' | 'audio' | 'file',
             fileName: a.fileName,
             size: a.size,
             mimeType: a.mimeType,
             data: a.data,
             contentHash: a.contentHash,
           }));

           const messageType = mode === 'photo' ? 'IMAGE' : mode === 'video' ? 'VIDEO' : mode === 'audio' ? 'AUDIO' : 'FILE';

           // 1. LOCAL ECHO: Save message locally first (unencrypted for local storage)
           const localMessage = {
             id: tempId,
             chatId,
             senderId: user.id,
             senderUsername: user.username,
             senderDeviceId: currentDeviceId,
             content: caption || '',
             type: messageType,
             messageType: 0, // Plaintext message type
             isOutgoing: true,
             status: 'sending' as const,
             createdAt: timestamp,
             timestamp,
             attachments: attachmentsForStore,
           };

           try {
             await storeMessage(localMessage);

             // Invalidate queries to refresh UI
             queryClient.invalidateQueries({
               queryKey: queryKeys.messages.chat(chatId),
             });
             queryClient.invalidateQueries({
               queryKey: queryKeys.chats.lists(),
             });

             // Notify parent component about new message (for UI update)
             void onMessageSent?.({
               id: tempId,
               chatId,
               content: caption || '',
               attachments: attachmentsForStore,
             });

             // Dispatch event to scroll to bottom
             window.dispatchEvent(new CustomEvent('zerochat:message-sent'));
           } catch (error) {
             console.error('[useFileUpload] Failed to save local echo for favorites:', error);
             throw error;
           }

           // 2. MULTI-DEVICE ENCRYPTION: Encrypt for other devices
           const encryptedDevices: EncryptedDeviceMessage[] = [];

           try {
             // Get own devices (excluding current)
             const allDevices = await chatService.getRecipientDevices(recipientId);
             const otherDevices = allDevices.filter(d => d.deviceId !== currentDeviceId);

             // Establish sessions sequentially
             for (const device of otherDevices) {
               await ensureSession(recipientId, device.deviceId);
             }

             // Prepare message content with attachments
             const messageContent = JSON.stringify({
               text: caption || '',
               attachments: attachments.map(a => ({
                 id: a.id,
                 type: a.type,
                 fileName: a.fileName,
                 size: a.size,
                 mimeType: a.mimeType,
                 data: a.data,
                 contentHash: a.contentHash,
               })),
             });

             // Encrypt for each device sequentially
             for (const device of otherDevices) {
               const encrypted = await signal.encrypt(recipientId, device.deviceId, messageContent);
               encryptedDevices.push({
                 deviceId: device.deviceId,
                 content: uint8ArrayToBase64(encrypted.body),
                 messageType: encrypted.type,
               });
             }
           } catch (error) {
             console.error('[useFileUpload] Failed to encrypt for devices:', error);
             // Continue to send even if encryption failed for some devices
           }

           // 3. SEND VIA WEBSOCKET
           try {
             await ws.send('favorites_message', {
               chatId,
               messages: encryptedDevices,
               replyTo: undefined,
               attachments: undefined,
             });
             // No need to update status - it remains 'sending' until ack received
           } catch (error) {
             console.error('[useFileUpload] Failed to send favorites via WebSocket:', error);
             // Update local message status to failed
             await storeMessage({
               ...localMessage,
               status: 'failed',
             });
             throw error;
           }
         } else {
           // Private message with attachments
           if (!recipientId) {
             throw new Error('Recipient ID is required for private chat');
           }

           try {
             const currentDeviceId = signal.getDeviceId() || 0;

             // Get recipient devices using chatService (correct endpoint)
             const recipientDevices = await chatService.getRecipientDevices(recipientId);
             if (recipientDevices.length === 0) {
               throw new Error('У получателя нет активных устройств');
             }

             // Get sender's devices for self-delivery
             const senderDevices = await chatService.getRecipientDevices(user.id);
             const otherSenderDevices = senderDevices.filter(d => d.deviceId !== currentDeviceId);

             const encryptionStartTime = Date.now();
             const recipientDeviceCount = recipientDevices.length;

             fileLogger.logEncryptionStart(
               chatId,
               `private-${attachments.length} files`,
               attachments.length * recipientDeviceCount,
               recipientDeviceCount
             );

             // Establish sessions with all recipient devices SEQUENTIALLY
             for (const device of recipientDevices) {
               await ensureSession(recipientId, device.deviceId);
             }

             // Establish sessions with sender's other devices SEQUENTIALLY
             for (const device of otherSenderDevices) {
               await ensureSession(user.id, device.deviceId);
             }

              // Prepare message content with attachments (will be encrypted)
               const messageContent = JSON.stringify({
                 text: caption || '',
                 attachments: attachments.map((a) => ({
                   id: a.id,
                   type: a.type,
                   fileName: a.fileName,
                   size: a.size,
                   mimeType: a.mimeType,
                   data: a.data, // Base64 data - will be encrypted
                   contentHash: a.contentHash, // SHA-256 hash for deduplication
                 })),
               });

             // Encrypt for each recipient device SEQUENTIALLY
             const recipientMessages: { deviceId: number; content: string; messageType: number }[] = [];
             for (const device of recipientDevices) {
               const encrypted = await signal.encrypt(
                 recipientId,
                 device.deviceId,
                 messageContent
               );
               const encryptedBase64 = arrayBufferToBase64(encrypted.body);
               recipientMessages.push({
                 deviceId: device.deviceId,
                 content: encryptedBase64,
                 messageType: encrypted.type,
               });

               fileLogger.logEncryptionComplete(
                 chatId,
                 `private-device-${device.deviceId}`,
                 encrypted.body.length,
                 0 // Not tracking per-device time in sequential mode
               );
             }

             // Encrypt for sender's other devices SEQUENTIALLY
             let senderMessages: { deviceId: number; content: string; messageType: number }[] | undefined;
             if (otherSenderDevices.length > 0) {
               senderMessages = [];
               for (const device of otherSenderDevices) {
                 const encrypted = await signal.encrypt(
                   user.id,
                   device.deviceId,
                   messageContent
                 );
                 const encryptedBase64 = arrayBufferToBase64(encrypted.body);
                 senderMessages.push({
                   deviceId: device.deviceId,
                   content: encryptedBase64,
                   messageType: encrypted.type,
                 });
               }
             }

              const messageId = await ws.sendMultiDeviceMessage(
                chatId,
                recipientId,
                recipientMessages,
                senderMessages
                // attachments REMOVED - they're inside encrypted content now
              );

              // Save MessageRecords for retry mechanism (for recipient devices)
              const now = Date.now();
              for (const { deviceId } of recipientMessages) {
                const recordId = `${messageId}-${deviceId}`;
                await storeMessageRecord({
                  id: recordId,
                  originalMessageId: messageId,
                  recipientId: recipientId,
                   recipientDeviceId: deviceId,
                   plaintext: JSON.stringify({
                     text: caption || '',
                     attachments: attachments.map((a) => ({
                       id: a.id,
                       type: a.type,
                       fileName: a.fileName,
                       size: a.size,
                       mimeType: a.mimeType,
                       contentHash: a.contentHash, // SHA-256 hash for deduplication
                     })),
                   }),
                  chatId: chatId,
                  createdAt: now,
                  expiresAt: now + MESSAGE_RECORD_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
                }).catch(err => console.warn('[useFileUpload] Failed to store MessageRecord:', err));
              }

             // Log success
             const fileIds = attachments.map(a => a.id);
             fileLogger.logSendSuccess(chatId, fileIds, `msg-${messageId}`, Date.now() - encryptionStartTime);

             // Save sent message to IndexedDB for sender (self-delivery doesn't include current device)
             if (user) {
               const currentDeviceId = signal.getDeviceId() || 0;

                const attachmentsForStore = attachments.map(a => ({
                  id: a.id,
                  type: a.type as 'image' | 'video' | 'audio' | 'file',
                  fileName: a.fileName,
                  size: a.size,
                  mimeType: a.mimeType,
                  data: a.data, // Store base64 data for immediate display
                  contentHash: a.contentHash, // SHA-256 hash for deduplication
                }));

                try {
                  const messageType = mode === 'photo' ? 'IMAGE' : mode === 'video' ? 'VIDEO' : mode === 'audio' ? 'AUDIO' : 'FILE';
                  await storeMessage({
                    id: messageId,
                    chatId,
                    senderId: user.id,
                    senderUsername: user.username,
                    senderDeviceId: currentDeviceId,
                    content: caption || '',
                    timestamp: Date.now(),
                    createdAt: Date.now(),
                    messageType: recipientMessages[0]?.messageType || 2,
                    isOutgoing: true,
                    status: 'sent',
                    attachments: attachmentsForStore,
                    type: messageType,
                  });

                  queryClient.invalidateQueries({
                    queryKey: queryKeys.messages.chat(chatId),
                  });

                  void onMessageSent?.({
                    id: messageId,
                    chatId,
                    content: caption || '',
                    attachments: attachmentsForStore,
                  });
               } catch (err) {
                 console.error('[useFileUpload] Failed to store sent message:', err);
                 // Continue - message was sent, just local storage failed
               }
             }
           } catch (error) {
             console.error('[useFileUpload] Failed to send private file:', error);
             throw error;
           }
         }

        // Mark all as sent
        setFiles((prev) =>
          prev.map((f) => (f.status === 'uploading' ? { ...f, status: 'sent', progress: 100 } : f))
        );

        toast.success('Отправлено', `Отправлено файлов: ${attachments.length}`);

        onSuccess?.();
        clearFiles();
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Ошибка отправки файлов';
        
        fileLogger.logSendError(chatId, undefined, errorMessage, {
          chatType,
          recipientId,
          filesCount: files.length,
        });

        setFiles((prev) =>
          prev.map((f) =>
            f.status === 'uploading' ? { ...f, status: 'error', error: errorMessage } : f
          )
        );

        toast.error('Ошибка отправки', errorMessage);
        onError?.(error instanceof Error ? error : new Error(errorMessage));
      } finally {
        setIsUploading(false);
        abortControllerRef.current = null;
      }
    },
    [
      chatId,
      chatType,
      recipientId,
      user,
      signal,
      ws,
      files,
      clearFiles,
      onSuccess,
      onError,
      onMessageSent,
      ensureSession,
      queryClient,
      storeMessageRecord,
      chatService,
    ]
  );

  // Calculate overall progress
  const overallProgress =
    files.length > 0 ? Math.round(files.reduce((acc, f) => acc + f.progress, 0) / files.length) : 0;

  const processing = files.some((f) => f.status === 'processing');

  return {
    files,
    addFiles,
    removeFile,
    clearFiles,
    processing,
    overallProgress,
    sendFiles,
    cancel,
    isUploading,
    generateThumbnail,
  };
}
