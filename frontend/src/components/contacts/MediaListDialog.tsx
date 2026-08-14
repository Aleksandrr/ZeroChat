/**
 * MediaListDialog Component
 *
 * Displays a list of media attachments of a specific type from a chat
 */

import type React from 'react';
import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { getChatMessages, type StoredMessage, type MessageAttachment } from '@/lib/messages';
import { getAttachment as getAttachmentFromDB } from '@/lib/messages/attachments';
import {
  Image as ImageIcon,
  Video,
  Music,
  File,
  Download,
  Loader2,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
} from 'lucide-react';
import { useImageGallery } from '@/contexts/ImageGalleryContext';

// Helper to convert base64 string to Uint8Array
function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

// Format file size helper
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}

interface MediaListDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  chatId?: string | null;
  mediaType: 'image' | 'video' | 'audio' | 'file' | null;
}

export const MediaListDialog: React.FC<MediaListDialogProps> = ({
  open,
  onOpenChange,
  chatId,
  mediaType,
}) => {
  const { openGallery, isOpen: isGalleryOpen } = useImageGallery();
  const [internalOpen, setInternalOpen] = useState(open);

  // Sync internal state with prop
  useEffect(() => {
    setInternalOpen(open);
  }, [open]);

  // Block closing when gallery is open
  const handleOpenChange = useCallback((newOpen: boolean) => {
    if (!newOpen && isGalleryOpen) {
      // Trying to close while gallery is open - block it
      return;
    }
    setInternalOpen(newOpen);
    onOpenChange(newOpen);
  }, [onOpenChange, isGalleryOpen]);
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [thumbnailUrls, setThumbnailUrls] = useState<Map<string, string>>(new Map());
  const [attachmentDataMap, setAttachmentDataMap] = useState<Map<string, string>>(new Map()); // contentHash -> base64 data
  const [currentPage, setCurrentPage] = useState(0);
  const pageSize = 20;

  /**
   * Load attachments of the specified type from chat messages
   */
  const loadAttachments = useCallback(async () => {
    if (!mediaType || !chatId) {
      setAttachments([]);
      setLoading(false);
      setCurrentPage(0);
      return;
    }

    // Reset pagination
    setCurrentPage(0);

    try {
      const messages = await getChatMessages(chatId);
      const filtered: MessageAttachment[] = [];

      for (const message of messages) {
        if (message.attachments) {
          for (const attachment of message.attachments) {
            if (attachment.type.toLowerCase() === mediaType) {
              filtered.push(attachment);
            }
          }
        }
      }

      setAttachments(filtered);
    } catch (error) {
      console.error('[MediaListDialog] Failed to load attachments:', error);
      setAttachments([]);
    } finally {
      setLoading(false);
    }
  }, [chatId, mediaType]);

  /**
   * Load attachments when dialog opens
   */
  useEffect(() => {
    if (internalOpen && mediaType) {
      setLoading(true);
      void loadAttachments();
    }
  }, [internalOpen, mediaType, loadAttachments]);

  /**
   * Generate thumbnail URLs and collect full image data for gallery
   */
  useEffect(() => {
    if (!internalOpen || attachments.length === 0) return;

    const generateThumbnails = async () => {
      const newUrls = new Map<string, string>();
      const newDataMap = new Map<string, string>(); // contentHash -> base64 data

      for (const attachment of attachments) {
        if (attachment.type === 'image' && attachment.contentHash) {
          try {
            let base64Data: string | null = null;
            
            // First try to get from attachment.data (already decrypted)
            if (attachment.data) {
              base64Data = attachment.data;
              const uint8Array = base64ToUint8Array(attachment.data);
              const arrayBuffer = uint8Array.buffer.slice(uint8Array.byteOffset, uint8Array.byteOffset + uint8Array.byteLength) as ArrayBuffer;
              const blob = new Blob([arrayBuffer], { type: attachment.mimeType });
              const url = URL.createObjectURL(blob);
              newUrls.set(attachment.contentHash, url);
            } else {
              // Fallback to IDB cache
              const data = await getAttachmentFromDB(attachment.contentHash);
              if (data) {
                // Convert Uint8Array to base64
                const binaryString = String.fromCharCode(...data);
                base64Data = btoa(binaryString);
                
                const arrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
                const blob = new Blob([arrayBuffer], { type: attachment.mimeType });
                const url = URL.createObjectURL(blob);
                newUrls.set(attachment.contentHash, url);
              }
            }
            
            // Store base64 data for gallery if we have it
            if (base64Data) {
              newDataMap.set(attachment.contentHash, base64Data);
            }
          } catch (error) {
            console.error('[MediaListDialog] Failed to generate thumbnail:', error);
          }
        }
      }

      // Revoke old URLs
      setThumbnailUrls(prev => {
        for (const [key, url] of prev) {
          if (!newUrls.has(key)) {
            URL.revokeObjectURL(url);
          }
        }
        return newUrls;
      });
      
      // Update attachment data map for gallery
      setAttachmentDataMap(newDataMap);
    };

    void generateThumbnails();

    // Cleanup on unmount
    return () => {
      for (const url of thumbnailUrls.values()) {
        URL.revokeObjectURL(url);
      }
      setThumbnailUrls(new Map());
      setAttachmentDataMap(new Map());
    };
  }, [open, attachments]);

  /**
   * Get icon for attachment type
   */
  const getTypeIcon = (type: string) => {
    switch (type) {
      case 'image':
        return ImageIcon;
      case 'video':
        return Video;
      case 'audio':
        return Music;
      default:
        return File;
    }
  };

  /**
   * Handle attachment download
   */
  const handleDownload = async (attachment: MessageAttachment) => {
    if (!attachment.contentHash) return;

    setDownloadingId(attachment.id);
    try {
      let data: Uint8Array | null = null;

      // First try to use attachment.data (already decrypted)
      if (attachment.data) {
        data = base64ToUint8Array(attachment.data);
      } else {
        // Fallback to IDB cache
        data = await getAttachmentFromDB(attachment.contentHash);
      }

      if (data) {
        const arrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
        const blob = new Blob([arrayBuffer], { type: attachment.mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = attachment.fileName;
        a.click();
        URL.revokeObjectURL(url);
      } else {
        alert('Файл не найден в кэше');
      }
    } catch (error) {
      console.error('[MediaListDialog] Download failed:', error);
      alert('Не удалось скачать файл');
    } finally {
      setDownloadingId(null);
    }
  };

  /**
   * Get media type label
   */
  const getMediaTypeLabel = (type: string) => {
    switch (type) {
      case 'image':
        return 'Изображение';
      case 'video':
        return 'Видео';
      case 'audio':
        return 'Аудио';
      default:
        return 'Файл';
    }
  };

  /**
   * Handle image click - open gallery
   */
  const handleImageClick = (attachment: MessageAttachment, index: number) => {

    // Build gallery images array with data from attachmentDataMap
    const galleryImages: (MessageAttachment & { data: string })[] = [];
    
    for (const att of attachments) {
      if (att.type === 'image' && att.contentHash) {
        const data = attachmentDataMap.get(att.contentHash) || att.data;
        if (data) {
          galleryImages.push({ ...att, data });
        }
      }
    }
    
    const galleryIndex = galleryImages.findIndex(att => att.id === attachment.id);
    
    if (galleryIndex >= 0 && galleryImages.length > 0) {
      openGallery(galleryImages, galleryIndex);
    } else {
      console.warn('[MediaListDialog] Cannot open gallery: image data not loaded');
    }
  };

  /**
   * Load more images (pagination)
   */
  const handleLoadMore = () => {
    setCurrentPage(prev => prev + 1);
  };

  // Pagination for images
  const displayedAttachments = mediaType === 'image'
    ? attachments.slice(0, (currentPage + 1) * pageSize)
    : attachments;
  const hasMore = mediaType === 'image' && attachments.length > (currentPage + 1) * pageSize;

  if (!mediaType) return null;

  const mediaTypeLabel = getMediaTypeLabel(mediaType);
  const IconComponent = getTypeIcon(mediaType);

  return (
    <Dialog open={internalOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <IconComponent className="h-5 w-5" />
            {mediaTypeLabel}
          </DialogTitle>
          <DialogDescription>
            Все {mediaTypeLabel.toLowerCase()} в этом чате
          </DialogDescription>
        </DialogHeader>

        {/* Attachments List */}
        <div className="flex-1 overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center h-64">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : attachments.length === 0 ? (
            <div className="flex items-center justify-center h-64 text-muted-foreground">
              Нет {mediaTypeLabel.toLowerCase()} в этом чате
            </div>
          ) : (
            <ScrollArea className="h-96 pr-4">
              {mediaType === 'image' ? (
                // Grid layout for images
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 p-1">
                  {displayedAttachments.map((attachment) => {
                    const isDownloading = downloadingId === attachment.id;
                    const thumbnailUrl = thumbnailUrls.get(attachment.contentHash);
                    const globalIndex = attachments.findIndex(a => a.id === attachment.id);

                    return (
                      <div
                        key={attachment.id}
                        className="relative group aspect-square rounded-lg overflow-hidden border bg-card cursor-pointer hover:border-primary transition-colors"
                        onClick={() => handleImageClick(attachment, globalIndex)}
                      >
                        {thumbnailUrl ? (
                          <img
                            src={thumbnailUrl}
                            alt={attachment.fileName}
                            className="w-full h-full object-cover"
                            onError={(e) => {
                              (e.target as HTMLImageElement).style.display = 'none';
                            }}
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center bg-muted">
                            <ImageIcon className="h-8 w-8 text-muted-foreground" />
                          </div>
                        )}
                        
                        {/* Overlay with file name and download button */}
                        <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col justify-between p-2">
                          <p className="text-white text-xs truncate text-center">
                            {attachment.fileName}
                          </p>
                          <Button
                            size="sm"
                            variant="secondary"
                            className="self-center h-8 px-3"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDownload(attachment);
                            }}
                            disabled={isDownloading}
                          >
                            {isDownloading ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <Download className="h-3 w-3" />
                            )}
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                // List layout for other media types
                <div className="space-y-2">
                  {attachments.map((attachment) => {
                    const isDownloading = downloadingId === attachment.id;
                    const thumbnailUrl = thumbnailUrls.get(attachment.contentHash);

                    return (
                      <div
                        key={attachment.id}
                        className="flex items-center gap-3 p-3 rounded-lg border bg-card hover:bg-accent/50 transition-colors"
                      >
                        {/* Thumbnail/Icon */}
                        <div className="h-12 w-12 rounded-md bg-muted flex items-center justify-center flex-shrink-0">
                          <IconComponent className="h-6 w-6 text-muted-foreground" />
                        </div>

                        {/* File Info */}
                        <div className="flex-1 min-w-0">
                          <p className="font-medium truncate">{attachment.fileName}</p>
                          <p className="text-sm text-muted-foreground">
                            {formatFileSize(attachment.size)}
                          </p>
                        </div>

                        {/* Download Button */}
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleDownload(attachment)}
                          disabled={isDownloading}
                        >
                          {isDownloading ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Download className="h-4 w-4" />
                          )}
                        </Button>
                      </div>
                    );
                  })}
                </div>
              )}
              
              {/* Load more button for images */}
              {hasMore && (
                <div className="flex justify-center pt-4 pb-2">
                  <Button
                    variant="outline"
                    onClick={handleLoadMore}
                    className="flex items-center gap-2"
                  >
                    <ChevronDown className="h-4 w-4" />
                    Загрузить еще ({attachments.length - displayedAttachments.length} осталось)
                  </Button>
                </div>
              )}
            </ScrollArea>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};

MediaListDialog.displayName = 'MediaListDialog';

export default MediaListDialog;
