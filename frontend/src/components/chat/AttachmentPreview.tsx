/**
 * AttachmentPreview - Component for displaying file preview before sending
 * Shows thumbnail, file info, and status
 */

import { AlertCircle, CheckCircle2,File, FileText, Image, Loader2, Music, Video, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import type { FileUploadItem } from '@/hooks/useFileUpload';
import { formatBytes } from '@/lib/media';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/hooks/use-mobile';

interface AttachmentPreviewProps {
  item: FileUploadItem;
  onRemove: () => void;
  className?: string;
}

// Get icon based on file type
function getFileIcon(mimeType: string) {
  if (mimeType.startsWith('image/')) return Image;
  if (mimeType.startsWith('video/')) return Video;
  if (mimeType.startsWith('audio/')) return Music;
  if (mimeType.includes('pdf')) return FileText;
  return File;
}

// Get status icon
function StatusIcon({ status }: { status: FileUploadItem['status'] }) {
  switch (status) {
    case 'processing':
      return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;
    case 'uploading':
      return <Loader2 className="h-4 w-4 animate-spin text-primary" />;
    case 'sent':
      return <CheckCircle2 className="h-4 w-4 text-green-500" />;
    case 'error':
      return <AlertCircle className="h-4 w-4 text-destructive" />;
    default:
      return null;
  }
}

// Get status text
function StatusText({ item }: { item: FileUploadItem }) {
  const { status, processedFile } = item;
  
  switch (status) {
    case 'pending':
      return (
        <span className="text-xs text-muted-foreground">
          Добавлен ({formatBytes(item.file.size)})
        </span>
      );
    case 'processing':
      return <span className="text-xs text-muted-foreground">Обработка...</span>;
    case 'uploading':
      return <span className="text-xs text-primary">Отправка...</span>;
    case 'sent':
      return (
        <span className="text-xs text-green-500">
          Отправлено
          {processedFile?.wasCompressed && (
            <span className="ml-1 text-muted-foreground">
              (сжато: {Math.round((1 - (processedFile.compressedSize / processedFile.originalSize)) * 100)}%)
            </span>
          )}
        </span>
      );
    case 'error':
      return <span className="text-xs text-destructive">{item.error || 'Ошибка'}</span>;
    case 'ready':
      if (processedFile?.wasCompressed) {
        const savedPercent = Math.round(
          (1 - processedFile.compressedSize / processedFile.originalSize) * 100
        );
        return (
          <span className="text-xs text-muted-foreground">
            {formatBytes(processedFile.compressedSize)}
            <span className="ml-1 text-green-500">(-{savedPercent}%)</span>
          </span>
        );
      }
      return <span className="text-xs text-muted-foreground">{formatBytes(item.file.size)}</span>;
    default:
      return null;
  }
}

export function AttachmentPreview({ item, onRemove, className }: AttachmentPreviewProps) {
  const { file, thumbnail, status, progress, processedFile } = item;
  const FileIcon = getFileIcon(processedFile?.mimeType || file.type);
  const isImage = (processedFile?.mimeType || file.type).startsWith('image/');
  const showThumbnail = thumbnail && isImage;
  const isMobile = useIsMobile();

  return (
    <div
      className={cn(
        'relative flex items-center rounded-lg border bg-card',
        isMobile ? 'gap-2 p-2' : 'gap-3 p-3',
        status === 'error' && 'border-destructive/50 bg-destructive/5',
        status === 'sent' && 'border-green-500/30 bg-green-50/30 dark:bg-green-900/10',
        className
      )}
    >
      {/* Thumbnail or Icon */}
      <div className="relative flex-shrink-0">
        {showThumbnail ? (
          <div className={cn(
            "relative rounded-md overflow-hidden bg-muted",
            isMobile ? "w-12 h-12" : "w-16 h-16"
          )}>
            <img
              src={thumbnail}
              alt={file.name}
              className="w-full h-full object-cover"
            />
            {status === 'processing' && (
              <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                <Loader2 className={cn(isMobile ? "h-4 w-4" : "h-5 w-5", "text-white", "animate-spin")} />
              </div>
            )}
          </div>
        ) : (
          <div
            className={cn(
              'rounded-lg flex items-center justify-center',
              isMobile ? 'w-10 h-10' : 'w-12 h-12',
              isImage && 'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400',
              file.type.startsWith('video/') && 'bg-purple-100 text-purple-600 dark:bg-purple-900/30 dark:text-purple-400',
              file.type.startsWith('audio/') && 'bg-amber-100 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400',
              !isImage && !file.type.startsWith('video/') && !file.type.startsWith('audio/') && 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'
            )}
          >
            <FileIcon className={cn(isMobile ? "h-5 w-5" : "h-6 w-6")} />
          </div>
        )}
      </div>

      {/* File Info */}
      <div className="flex-1 min-w-0">
        <p className={cn(isMobile ? "text-xs" : "text-sm", "font-medium", "break-words")} title={processedFile?.fileName || file.name}>
          {processedFile?.fileName || file.name}
        </p>
        <div className="flex items-center gap-2 mt-0.5">
          <StatusIcon status={status} />
          <StatusText item={item} />
        </div>

        {/* Progress bar for uploading/processing */}
        {(status === 'uploading' || status === 'processing') && (
          <div className={cn(isMobile ? "mt-1" : "mt-2")}>
            <Progress value={progress} className={cn(isMobile ? "h-1" : "h-1")} />
          </div>
        )}
      </div>

      {/* Remove button */}
      {status !== 'sent' && status !== 'uploading' && (
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            "flex-shrink-0 text-muted-foreground hover:text-destructive",
            isMobile ? "h-8 w-8" : "h-7 w-7"
          )}
          onClick={onRemove}
          disabled={status === 'processing'}
        >
          <X className={cn(isMobile ? "h-4 w-4" : "h-4 w-4")} />
        </Button>
      )}
    </div>
  );
}

// Grid layout for multiple attachments
interface AttachmentPreviewListProps {
  items: FileUploadItem[];
  onRemove: (index: number) => void;
  className?: string;
}

export function AttachmentPreviewList({ items, onRemove, className }: AttachmentPreviewListProps) {
  if (items.length === 0) return null;

  return (
    <div className={cn('space-y-2', className)}>
      {items.map((item, index) => (
        <AttachmentPreview
          key={item.id}
          item={item}
          onRemove={() => onRemove(index)}
        />
      ))}
    </div>
  );
}

export default AttachmentPreview;
