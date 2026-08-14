/**
 * File Transfer Logger
 * Centralized logging for file transfer operations
 * Tracks file lifecycle from selection to delivery
 */

export type FileLogEventType =
  | 'dialog_open'
  | 'mode_selected'
  | 'file_selected'
  | 'file_dropped'
  | 'file_added'
  | 'file_removed'
  | 'thumbnail_generated'
  | 'processing_start'
  | 'processing_complete'
  | 'compression_applied'
  | 'conversion_applied'
  | 'encryption_start'
  | 'encryption_complete'
  | 'message_prepared'
  | 'send_start'
  | 'send_success'
  | 'send_error'
  | 'ws_message_sent'
  | 'ws_message_received'
  | 'decryption_start'
  | 'decryption_complete'
  | 'cache_hit'
  | 'cache_miss'
  | 'storage_save'
  | 'storage_load'
  | 'display_rendered'
  | 'download_start'
  | 'download_complete'
  | 'quota_check'
  | 'quota_exceeded'
  | 'deduplication_hit'
  | 'multi_device_sync'
  | 'group_broadcast'
  | 'error';

export interface FileLogEvent {
  timestamp: number;
  type: FileLogEventType;
  fileId?: string;
  fileName?: string;
  chatId?: string;
  senderId?: string;
  recipientId?: string;
  messageId?: string;
  details?: Record<string, any>;
  duration?: number;
  error?: string;
  success: boolean;
}

class FileTransferLogger {
  private logs: FileLogEvent[] = [];
  private maxLogs = 1000;
  private listeners: ((event: FileLogEvent) => void)[] = [];
  private enabled = true;
  private minLevel: 'debug' | 'info' | 'warn' | 'error' = 'debug';

  setLogLevel(level: 'debug' | 'info' | 'warn' | 'error') {
    this.minLevel = level;
  }

  enable() { this.enabled = true; }
  disable() { this.enabled = false; }

  private shouldLog(event: FileLogEvent): boolean {
    if (!this.enabled) return false;
    if (event.error) return true;
    switch (this.minLevel) {
      case 'error': return event.success === false;
      case 'warn': return !event.success || event.type === 'quota_exceeded';
      case 'info': return event.type.includes('start') || event.type.includes('complete') || event.type.includes('success');
      case 'debug': default: return true;
    }
  }

  private log(event: Omit<FileLogEvent, 'timestamp' | 'success'>) {
    const fullEvent: FileLogEvent = {
      ...event,
      timestamp: Date.now(),
      success: !event.error,
    };

    if (this.shouldLog(fullEvent)) {
      this.logs.push(fullEvent);
      if (this.logs.length > this.maxLogs) {
        this.logs = this.logs.slice(-this.maxLogs);
      }
      this.listeners.forEach(listener => {
        try { listener(fullEvent); } catch {}
      });
      this.logToConsole(fullEvent);
    }
  }

  private logToConsole(event: FileLogEvent) {
    const time = new Date(event.timestamp).toISOString();
    const colorMap: Record<string, string> = {
      dialog_open: '\x1b[36m',
      mode_selected: '\x1b[36m',
      file_selected: '\x1b[36m',
      file_dropped: '\x1b[36m',
      file_added: '\x1b[36m',
      file_removed: '\x1b[33m',
      thumbnail_generated: '\x1b[32m',
      processing_start: '\x1b[33m',
      processing_complete: '\x1b[32m',
      compression_applied: '\x1b[32m',
      conversion_applied: '\x1b[32m',
      encryption_start: '\x1b[35m',
      encryption_complete: '\x1b[35m',
      message_prepared: '\x1b[34m',
      send_start: '\x1b[33m',
      send_success: '\x1b[32m',
      send_error: '\x1b[31m',
      ws_message_sent: '\x1b[34m',
      ws_message_received: '\x1b[34m',
      decryption_start: '\x1b[35m',
      decryption_complete: '\x1b[35m',
      cache_hit: '\x1b[32m',
      cache_miss: '\x1b[33m',
      storage_save: '\x1b[32m',
      storage_load: '\x1b[32m',
      display_rendered: '\x1b[32m',
      download_start: '\x1b[33m',
      download_complete: '\x1b[32m',
      quota_check: '\x1b[36m',
      quota_exceeded: '\x1b[31m',
      deduplication_hit: '\x1b[32m',
      multi_device_sync: '\x1b[34m',
      group_broadcast: '\x1b[34m',
      error: '\x1b[31m',
    };

    const color = colorMap[event.type] || '\x1b[0m';
    const reset = '\x1b[0m';

    const parts = [
      `${color}[${time}]${reset}`,
      `[FILE] ${event.type.padEnd(25)}`,
    ];

    if (event.fileId) parts.push(`id:${event.fileId.slice(0, 8)}`);
    if (event.fileName) parts.push(`"${event.fileName}"`);
    if (event.chatId) parts.push(`chat:${event.chatId.slice(0, 8)}`);
    if (event.senderId) parts.push(`from:${event.senderId.slice(0, 8)}`);
    if (event.recipientId) parts.push(`to:${event.recipientId.slice(0, 8)}`);
    if (event.duration) parts.push(`+${event.duration}ms`);
    if (event.error) parts.push(`ERROR: ${event.error}`);

    console.log(...parts);

    if (event.details) {
      console.debug('  Details:', event.details);
    }
  }

  logDialogOpen(chatId: string, chatType: string) {
    this.log({ type: 'dialog_open', chatId, details: { chatType } });
  }

  logModeSelected(mode: string, fileCount: number) {
    this.log({ type: 'mode_selected', details: { mode, fileCount } });
  }

  logFileSelected(file: File, source: 'dialog' | 'drop' | 'input') {
    this.log({
      type: 'file_selected',
      fileName: file.name,
      details: { size: file.size, type: file.type, source, lastModified: file.lastModified },
    });
  }

  logFileDropped(file: File) {
    this.log({
      type: 'file_dropped',
      fileName: file.name,
      details: { size: file.size, type: file.type },
    });
  }

  logFileAdded(fileId: string, fileName: string, fileSize: number) {
    this.log({ type: 'file_added', fileId, fileName, details: { size: fileSize } });
  }

  logFileRemoved(fileId: string, fileName: string) {
    this.log({ type: 'file_removed', fileId, fileName });
  }

  logThumbnailGenerated(fileId: string, fileName: string, type: 'image' | 'video', duration: number) {
    this.log({ type: 'thumbnail_generated', fileId, fileName, duration, details: { type } });
  }

  logProcessingStart(fileId: string, fileName: string, mode: string) {
    this.log({ type: 'processing_start', fileId, fileName, details: { mode } });
  }

  logProcessingComplete(fileId: string, fileName: string, originalSize: number, processedSize: number, duration: number) {
    this.log({
      type: 'processing_complete',
      fileId,
      fileName,
      duration,
      details: {
        originalSize,
        processedSize,
        savedBytes: originalSize - processedSize,
        compressionRatio: processedSize / originalSize,
      },
    });
  }

  logCompressionApplied(fileId: string, fileName: string, originalSize: number, compressedSize: number, duration: number) {
    this.log({
      type: 'compression_applied',
      fileId,
      fileName,
      duration,
      details: {
        originalSize,
        compressedSize,
        savedBytes: originalSize - compressedSize,
        ratio: compressedSize / originalSize,
      },
    });
  }

  logConversionApplied(fileId: string, fileName: string, originalFormat: string, targetFormat: string, duration: number) {
    this.log({
      type: 'conversion_applied',
      fileId,
      fileName,
      duration,
      details: { originalFormat, targetFormat },
    });
  }

  logEncryptionStart(fileId: string, fileName: string, dataSize: number, recipientCount: number) {
    this.log({
      type: 'encryption_start',
      fileId,
      fileName,
      details: { dataSize, recipientCount },
    });
  }

  logEncryptionComplete(fileId: string, fileName: string, encryptedSize: number, duration: number) {
    this.log({ type: 'encryption_complete', fileId, fileName, duration, details: { encryptedSize } });
  }

  logMessagePrepared(fileId: string, fileName: string, messageId: string, chatId: string, attachmentCount: number) {
    this.log({
      type: 'message_prepared',
      fileId,
      fileName,
      messageId,
      chatId,
      details: { attachmentCount },
    });
  }

  logSendStart(chatId: string, fileCount: number, totalSize: number) {
    this.log({ type: 'send_start', chatId, details: { fileCount, totalSize } });
  }

  logSendSuccess(chatId: string, fileIds: string[], messageId: string, duration: number) {
    this.log({ type: 'send_success', chatId, messageId, duration, details: { fileIds } });
  }

  logSendError(chatId: string, fileId?: string, error?: string, details?: Record<string, any>) {
    this.log({ type: 'send_error', fileId, chatId, error, details });
  }

  logWebSocketMessageSent(messageType: string, chatId: string, fileCount: number, payloadSize: number) {
    this.log({
      type: 'ws_message_sent',
      chatId,
      details: { messageType, fileCount, payloadSize },
    });
  }

  logWebSocketMessageReceived(messageType: string, chatId: string, senderId: string, fileCount: number) {
    this.log({
      type: 'ws_message_received',
      chatId,
      senderId,
      details: { messageType, fileCount },
    });
  }

  logDecryptionStart(fileId: string, fileName: string, encryptedSize: number, senderId: string) {
    this.log({
      type: 'decryption_start',
      fileId,
      fileName,
      senderId,
      details: { encryptedSize },
    });
  }

  logDecryptionComplete(fileId: string, fileName: string, decryptedSize: number, duration: number) {
    this.log({ type: 'decryption_complete', fileId, fileName, duration, details: { decryptedSize } });
  }

  logCacheHit(contentHash: string, size: number) {
    this.log({
      type: 'cache_hit',
      details: { contentHash: contentHash.slice(0, 16) + '...', size },
    });
  }

  logCacheMiss(contentHash: string) {
    this.log({ type: 'cache_miss', details: { contentHash: contentHash.slice(0, 16) + '...' } });
  }

  logStorageSave(contentHash: string, size: number, isDeduplication: boolean) {
    this.log({
      type: 'storage_save',
      details: { contentHash: contentHash.slice(0, 16) + '...', size, isDeduplication },
    });
  }

  logStorageLoad(contentHash: string, size: number) {
    this.log({ type: 'storage_load', details: { contentHash: contentHash.slice(0, 16) + '...', size } });
  }

   logDisplayRendered(attachmentId: string, attachmentType: string, fileName: string, size?: number) {
     this.log({ 
       type: 'display_rendered', 
       fileId: attachmentId, 
       fileName, 
       details: { attachmentType, size } 
     });
   }

    logDisplayError(attachmentId: string, attachmentType: string, fileName: string, error: string) {
      this.log({ 
        type: 'error', 
        fileId: attachmentId, 
        fileName, 
        error,
        details: { attachmentType, context: 'display' }
      });
    }

    logMessageDisplayed(messageId: string, attachmentCount: number) {
      this.log({ type: 'display_rendered', messageId, details: { attachmentCount, context: 'message' } });
    }

  logDownloadStart(fileId: string, fileName: string, size: number) {
    this.log({ type: 'download_start', fileId, fileName, details: { size } });
  }

  logDownloadComplete(fileId: string, fileName: string, duration: number) {
    this.log({ type: 'download_complete', fileId, fileName, duration });
  }

  logQuotaCheck(currentUsage: number, maxQuota: number, fileSize: number) {
    this.log({
      type: 'quota_check',
      details: {
        currentUsage,
        maxQuota,
        fileSize,
        remaining: maxQuota - currentUsage,
        wouldExceed: currentUsage + fileSize > maxQuota,
      },
    });
  }

  logQuotaExceeded(currentUsage: number, maxQuota: number, attemptedFileSize: number) {
    this.log({
      type: 'quota_exceeded',
      error: 'Storage quota exceeded',
      details: {
        currentUsage,
        maxQuota,
        attemptedFileSize,
        exceededBy: currentUsage + attemptedFileSize - maxQuota,
      },
    });
  }

  logDeduplicationHit(contentHash: string, existingSize: number) {
    this.log({
      type: 'deduplication_hit',
      details: { contentHash: contentHash.slice(0, 16) + '...', existingSize, savedBytes: existingSize },
    });
  }

  logMultiDeviceSync(fileId: string, deviceCount: number) {
    this.log({ type: 'multi_device_sync', fileId, details: { deviceCount } });
  }

  logGroupBroadcast(fileId: string, groupId: string, memberCount: number) {
    this.log({ type: 'group_broadcast', fileId, chatId: groupId, details: { memberCount } });
  }

  logError(context: string, error: Error, details?: Record<string, any>) {
    this.log({
      type: 'error',
      error: error.message,
      details: { context, stack: error.stack, ...details },
    });
  }

  getLogs(filter?: FileLogEventType): FileLogEvent[] {
    if (filter) return this.logs.filter(log => log.type === filter);
    return [...this.logs];
  }

  getLogsForFile(fileId: string): FileLogEvent[] {
    return this.logs.filter(log => log.fileId === fileId);
  }

  getLogsForChat(chatId: string): FileLogEvent[] {
    return this.logs.filter(log => log.chatId === chatId);
  }

  clearLogs() { this.logs = []; }

  subscribe(callback: (event: FileLogEvent) => void): () => void {
    this.listeners.push(callback);
    return () => {
      const index = this.listeners.indexOf(callback);
      if (index > -1) this.listeners.splice(index, 1);
    };
  }

   exportLogs(format: 'json' | 'text' = 'json'): string {
     if (format === 'json') {
       return JSON.stringify(this.logs, null, 2);
     }
     return this.logs
       .map(log => {
         const time = new Date(log.timestamp).toISOString();
         const parts = [`[${time}]`, log.type];
         if (log.fileName) parts.push(`"${log.fileName}"`);
         if (log.chatId) parts.push(`chat:${log.chatId.slice(0, 8)}`);
         if (log.duration) parts.push(`+${log.duration}ms`);
         if (log.error) parts.push(`ERROR: ${log.error}`);
         return parts.join(' ');
       })
       .join('\n');
   }

   // Debug logging (only shown if level is debug)
   logDebug(message: string, data?: any) {
     if (this.minLevel === 'debug') {
       console.debug(`[FILE-LOGGER] ${message}`, data || '');
     }
   }
 }

export const fileLogger = new FileTransferLogger();
export default fileLogger;
