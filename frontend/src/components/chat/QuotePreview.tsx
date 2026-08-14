import { AlertCircle, File, FileText, Image, Loader2, Mic, Music, Video } from 'lucide-react';
import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
import type { Attachment, Message } from '@/types';

interface QuotePreviewProps {
  message: Message;
  isOwn: boolean;
  decryptedData?: Map<string, Uint8Array>;
  decryptingAttachments?: Set<string>;
  decryptErrors?: Map<string, string>;
  onClick?: () => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
}

export function getMediaTypeLabel(attachments: Attachment[]): string {
  if (!attachments || attachments.length === 0) return '';
  const firstType = attachments[0]?.type;
  switch (firstType) {
    case 'image': return 'Изображение';
    case 'video': return 'Видео';
    case 'audio': return 'Аудио';
    case 'voice': return 'Голосовое сообщение';
    case 'file': return 'Файл';
    default: return 'Вложение';
  }
}

function getMediaIcon(type: string) {
  switch (type) {
    case 'image': return Image;
    case 'video': return Video;
    case 'audio': return Music;
    case 'voice': return Mic;
    case 'file': return FileText;
    default: return File;
  }
}

function createDataUrl(data: string, mimeType: string): string {
  return `data:${mimeType};base64,${data}`;
}

function ImagePreview({ attachment, decryptedData }: { attachment: Attachment; decryptedData?: Uint8Array }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let url: string | null = null;
    if (decryptedData) {
      const blob = new Blob([decryptedData.buffer as ArrayBuffer], { type: attachment.mimeType });
      url = URL.createObjectURL(blob);
    } else if (attachment.data) {
      url = createDataUrl(attachment.data, attachment.mimeType);
    }
    if (url) setSrc(url); else setError(true);
    return () => { if (url && url.startsWith('blob:')) URL.revokeObjectURL(url); };
  }, [decryptedData, attachment.data, attachment.mimeType]);

  if (error || !src) {
    return <div className="w-10 h-10 rounded bg-muted flex items-center justify-center shrink-0"><Image className="w-4 h-4 text-muted-foreground" /></div>;
  }

  return <img src={src} alt={attachment.fileName} className="w-10 h-10 object-cover rounded shrink-0" onError={() => setError(true)} />;
}

function MediaIconPreview({ attachment }: { attachment: Attachment }) {
  const Icon = getMediaIcon(attachment.type);
  return <div className="w-10 h-10 rounded bg-primary/10 flex items-center justify-center shrink-0"><Icon className="w-4 h-4 text-primary" /></div>;
}

export function QuotePreview({
  message,
  isOwn,
  decryptedData,
  decryptingAttachments,
  decryptErrors,
  onClick,
  onKeyDown
}: QuotePreviewProps) {
  const attachments = message.attachments;
  const hasAttachments = attachments && attachments.length > 0;
  const firstAttachment = hasAttachments ? attachments[0] : null;
  const mediaTypeLabel = hasAttachments ? getMediaTypeLabel(attachments) : '';
  
  const senderName = (() => {
    if (message.metadata?.forwardedFrom?.senderId) {
      return message.metadata.forwardedFrom.senderName || message.metadata.forwardedFrom.senderId;
    }
    return message.sender?.displayName || message.sender?.username || message.senderUsername || 'Unknown';
  })();

  const isDecrypting = firstAttachment && decryptingAttachments?.has(firstAttachment.id);
  const decryptError = firstAttachment && decryptErrors?.get(firstAttachment.id);

  return (
    <div
      role="button"
      tabIndex={0}
      onKeyDown={onKeyDown}
      onClick={onClick}
      className={cn(
        'border-l-2 pl-2 py-1 mb-1.5 rounded-sm w-full cursor-pointer overflow-hidden flex gap-2',
        isOwn ? 'bg-primary/10 border-primary-foreground/70' : 'bg-muted border-foreground/50'
      )}
      title="Нажмите, чтобы перейти к сообщению"
    >
      {hasAttachments && firstAttachment && (
        <div className="shrink-0">
          {isDecrypting ? (
            <div className="w-10 h-10 rounded bg-muted flex items-center justify-center"><Loader2 className="w-4 h-4 animate-spin text-muted-foreground" /></div>
          ) : decryptError ? (
            <div className="w-10 h-10 rounded bg-destructive/10 flex items-center justify-center"><AlertCircle className="w-4 h-4 text-destructive" /></div>
          ) : firstAttachment.type === 'image' ? (
            <ImagePreview attachment={firstAttachment} decryptedData={decryptedData?.get(firstAttachment.id)} />
          ) : (
            <MediaIconPreview attachment={firstAttachment} />
          )}
        </div>
      )}
       <div className="flex-1 min-w-0">
         <div className="mb-0.5">
           <span className="text-xs font-semibold truncate block">{senderName}</span>
           {mediaTypeLabel && <span className="text-[10px] truncate block">{mediaTypeLabel}</span>}
         </div>
        {message.content && <p className="text-xs line-clamp-2 leading-relaxed">{message.content}</p>}
      </div>
    </div>
  );
}