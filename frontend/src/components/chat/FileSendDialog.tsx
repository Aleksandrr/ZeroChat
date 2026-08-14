/**
 * FileSendDialog - Dialog for selecting and sending files
 * Supports drag & drop, file preview, mode selection, and progress tracking
 * Uses Sheet on mobile for better fullscreen experience
 */

import {
  AlertCircle,
  File,
  Image,
  Loader2,
  Music,
  Send,
  Upload,
  Video,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Progress } from '@/components/ui/progress';
import { useAuth } from '@/contexts/AuthContext';
import { useChat } from '@/contexts/ChatContext';
import { useFileUpload } from '@/hooks/useFileUpload';
import { useIsMobile } from '@/hooks/use-mobile';
import { formatBytes, type SendMode } from '@/lib/media';
import { cn } from '@/lib/utils';
import { fileLogger } from '@/lib/utils/file-logger';
import { toast } from '@/stores/toast-store';
import type { Attachment } from '@/types';

import { AttachmentPreviewList } from './AttachmentPreview';

interface FileSendDialogProps {
  chatId: string;
  chatType?: 'private' | 'group' | 'favorites';
  recipientId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
  /** Ограничить доступные режимы отправки. Если не указано - все режимы */
  allowedModes?: SendMode[];
  /** Начальные файлы для загрузки (например, из drag & drop) */
  initialFiles?: File[];
  /** Начальный режим отправки (если задан, используется вместо первого из allowedModes) */
  initialMode?: SendMode;
  /** Caption (подпись) для файла - будет отправлен как текст сообщения */
  caption?: string;
  /** Callback для обновления caption в родительском компоненте */
  onCaptionChange?: (caption: string) => void;
}

type DialogStep = 'select' | 'preview' | 'sending';

// Mode configuration
const SEND_MODES: {
  value: SendMode;
  label: string;
  description: string;
  icon: React.ElementType;
  accept: string;
}[] = [
  {
    value: 'photo',
    label: 'Фото',
    description: 'Сжать изображение',
    icon: Image,
    accept: 'image/*',
  },
  {
    value: 'video',
    label: 'Видео',
    description: 'Сжать видео',
    icon: Video,
    accept: 'video/*',
  },
  {
    value: 'audio',
    label: 'Аудио',
    description: 'Конвертировать в MP3',
    icon: Music,
    accept: 'audio/*',
  },
  {
    value: 'file',
    label: 'Файл',
    description: 'Отправить как есть',
    icon: File,
    accept: '*/*',
  },
];

export function FileSendDialog({
  chatId,
  chatType,
  recipientId,
  open,
  onOpenChange,
  onSuccess,
  allowedModes,
  initialFiles,
  initialMode,
  caption: initialCaption,
  onCaptionChange,
}: FileSendDialogProps) {
  const [step, setStep] = useState<DialogStep>('select');
  const [selectedMode, setSelectedMode] = useState<SendMode>(initialMode || 'file');
  const [isDragging, setIsDragging] = useState(false);
  const [caption, setCaption] = useState(initialCaption || '');
  const [modeConfirmed, setModeConfirmed] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { user } = useAuth();
  const { setChats } = useChat();
  const isMobile = useIsMobile();

  const {
    files,
    addFiles,
    removeFile,
    clearFiles,
    processing,
    overallProgress,
    sendFiles,
    cancel,
    isUploading,
  } = useFileUpload({
    chatId,
    chatType,
    recipientId,
    onSuccess: () => {
      onSuccess?.();
      handleClose();
    },
    onError: (error) => {
      console.error('File upload error:', error);
      setStep('preview');
    },
    onMessageSent: (message) => {
      // Update chats list with new last message
      // Determine message type from attachments
      let messageType: 'TEXT' | 'IMAGE' | 'FILE' | 'AUDIO' | 'VIDEO' | 'SYSTEM' = 'TEXT';
      let convertedAttachments: Attachment[] | undefined;

      if (message.attachments && message.attachments.length > 0) {
        const attachmentType = message.attachments[0]!.type as 'image' | 'video' | 'audio' | 'voice' | 'file';
        if (attachmentType === 'image') messageType = 'IMAGE';
        else if (attachmentType === 'video') messageType = 'VIDEO';
        else if (attachmentType === 'audio' || attachmentType === 'voice') messageType = 'AUDIO';
        else if (attachmentType === 'file') messageType = 'FILE';

        // Convert to Attachment type
        convertedAttachments = message.attachments.map(att => ({
          id: att.id,
          type: attachmentType,
          fileName: att.fileName,
          size: att.size,
          mimeType: att.mimeType,
          contentHash: att.contentHash,
          data: att.data,
        }));
      }

      setChats(prev => prev.map(c => {
        if (c.id === chatId) {
          return {
            ...c,
            lastMessage: {
              id: message.id,
              content: message.content,
              senderId: user?.id || '',
              chatId,
              type: messageType,
              attachments: convertedAttachments,
              createdAt: new Date().toISOString(),
              timestamp: new Date().toISOString(),
            },
            updatedAt: new Date().toISOString(),
          };
        }
        return c;
      }));
    },
  });

  // Обработка initialFiles и сброса режима при открытии
  useEffect(() => {
    if (open) {
      // Установить режим: initialMode приоритетнее, иначе первый из allowedModes, иначе 'file'
      if (initialMode) {
        setSelectedMode(initialMode);
      } else if (allowedModes && allowedModes.length > 0 && allowedModes[0]) {
        setSelectedMode(allowedModes[0]);
      } else {
        setSelectedMode('file');
      }

      setModeConfirmed(false);
      setCaption(initialCaption || '');

      // Если переданы начальные файлы, добавить их
      if (initialFiles && initialFiles.length > 0) {
        void addFiles(initialFiles).then(() => {
          // Если initialMode задан, сразу переходим к preview
          // Иначе остаемся в 'select' для выбора режима
          if (initialMode) {
            setModeConfirmed(true);
            setStep('preview');
          }
        });
      }
    }
  }, [open, allowedModes, initialFiles, initialMode, initialCaption, addFiles]);

  // Синхронизация caption с родительским компонентом
  useEffect(() => {
    if (onCaptionChange) {
      onCaptionChange(caption);
    }
  }, [caption, onCaptionChange]);

  const handleClose = useCallback(() => {
    if (isUploading) {
      cancel();
    }
    clearFiles();
    setStep('select');
    setSelectedMode('file');
    onOpenChange(false);
  }, [isUploading, cancel, clearFiles, onOpenChange]);

  // Log dialog open
  useEffect(() => {
    if (open) {
      fileLogger.logDialogOpen(chatId, chatType || 'private');
    }
  }, [open, chatId, chatType]);

  const handleFileSelect = useCallback(
    async (selectedFiles: FileList | null) => {
      if (!selectedFiles || selectedFiles.length === 0) return;

      const filesArray = Array.from(selectedFiles);

      // Log file selection
      filesArray.forEach(file => {
        fileLogger.logFileSelected(file, 'dialog');
      });

      // Validate file types based on selected mode
      const invalidFiles = filesArray.filter((file) => {
        switch (selectedMode) {
          case 'photo':
            return !file.type.startsWith('image/');
          case 'video':
            return !file.type.startsWith('video/');
          case 'audio':
            return !file.type.startsWith('audio/');
          default:
            return false;
        }
      });

      if (invalidFiles.length > 0) {
        toast.error(
          'Неверный тип файла',
          `${invalidFiles.map((f) => f.name).join(', ')} не соответствуют режиму ${SEND_MODES.find(m => m.value === selectedMode)?.label}`
        );
        return;
      }

      await addFiles(filesArray);
      if (filesArray.length > 0) {
        setStep('preview');
      }
    },
    [addFiles, selectedMode]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      const droppedFiles = e.dataTransfer.files;
      if (droppedFiles && droppedFiles.length > 0) {
        Array.from(droppedFiles).forEach(file => {
          fileLogger.logFileDropped(file);
        });
      }
      void handleFileSelect(droppedFiles);
    },
    [handleFileSelect]
  );

  const handleSend = useCallback(async () => {
    if (files.length === 0) return;

    // Log send start
    const totalSize = files.reduce((acc, f) => acc + f.file.size, 0);
    fileLogger.logSendStart(chatId, files.length, totalSize);

    setStep('sending');
    try {
      await sendFiles(selectedMode, caption);
    } catch (error) {
      fileLogger.logSendError(chatId, undefined, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }, [files, sendFiles, selectedMode, caption, chatId]);

  const getTotalSize = () => {
    return files.reduce((acc, f) => acc + f.file.size, 0);
  };

  const getCompressedSize = () => {
    return files.reduce(
      (acc, f) => acc + (f.processedFile?.compressedSize || f.file.size),
      0
    );
  };

  const totalSize = getTotalSize();
  const compressedSize = getCompressedSize();
  const savedBytes = totalSize - compressedSize;

  // Get title and description based on mode
  const getModeTitle = (mode: SendMode): string => {
    const titles: Record<SendMode, string> = {
      photo: 'Отправить фото',
      video: 'Отправить видео',
      audio: 'Отправить аудио',
      file: 'Отправить файл',
    };
    return titles[mode];
  };

  const getModeDescription = (mode: SendMode): string => {
    const descriptions: Record<SendMode, string> = {
      photo: 'Выберите изображения для отправки. Фотографии будут сжаты для экономии трафика.',
      video: 'Выберите видеофайлы для отправки. Видео будут сжаты с сохранением качества.',
      audio: 'Выберите аудиофайлы для отправки. Аудио будут конвертированы в MP3.',
      file: 'Выберите файлы для отправки. Любые типы файлов поддерживаются.',
    };
    return descriptions[mode];
  };

  // Use Sheet on mobile, Dialog on desktop
  const DialogComponent = isMobile ? Sheet : Dialog;
  const ContentComponent = isMobile ? SheetContent : DialogContent;
  const HeaderComponent = isMobile ? SheetHeader : DialogHeader;
  const TitleComponent = isMobile ? SheetTitle : DialogTitle;
  const DescriptionComponent = isMobile ? SheetDescription : DialogDescription;
  const FooterComponent = isMobile ? SheetFooter : DialogFooter;

  return (
    <DialogComponent open={open} onOpenChange={handleClose}>
      <ContentComponent
        className={cn(
          isMobile ? 'rounded-t-2xl !h-[90vh]' : 'sm:max-w-md',
          'max-h-[90vh] flex flex-col overflow-hidden'
        )}
        side={isMobile ? 'bottom' : undefined}
      >
        <HeaderComponent className="px-4 pt-4 pb-2 flex-shrink-0">
          <TitleComponent>
            {step === 'select' && (allowedModes && allowedModes.length === 1 ? getModeTitle(selectedMode) : 'Отправить файл')}
            {step === 'preview' && 'Подготовка файлов'}
            {step === 'sending' && 'Отправка...'}
          </TitleComponent>
          <DescriptionComponent>
            {step === 'select' && (allowedModes && allowedModes.length === 1 ? getModeDescription(selectedMode) : 'Выберите файлы для отправки. Поддерживаются изображения, видео, аудио и другие файлы.')}
            {step === 'preview' && 'Проверьте файлы перед отправкой. Вы можете добавить ещё файлы или удалить ненужные.'}
            {step === 'sending' && 'Идёт отправка файлов. Пожалуйста, подождите.'}
          </DescriptionComponent>
        </HeaderComponent>

        {/* Scrollable content area */}
        <div className="flex-1 overflow-y-auto px-4 py-2">
          {/* Step 1: Select mode and files */}
          {step === 'select' && (
            <div className="space-y-4">
              {/* Mode selection */}
              {(!allowedModes || allowedModes.length > 1) && (
                <div className={`grid gap-3 ${isMobile ? 'grid-cols-1' : 'grid-cols-2'}`}>
                  {/* Show only photo and file modes for images (like Telegram) */}
                  {(() => {
                    const modesToShow = (initialFiles && initialFiles.length > 0)
                      ? SEND_MODES.filter(m => m.value === 'photo' || m.value === 'file')
                      : SEND_MODES.filter(mode => !allowedModes || allowedModes.includes(mode.value));

                    return modesToShow.map((modeConfig) => {
                      const Icon = modeConfig.icon;
                      const isSelected = selectedMode === modeConfig.value;

                      return (
                        <button
                          key={modeConfig.value}
                          onClick={() => {
                            setSelectedMode(modeConfig.value);
                            fileLogger.logModeSelected(modeConfig.value, files.length);

                            // If we have initial files (from drag & drop), immediately go to preview
                            if (initialFiles && initialFiles.length > 0) {
                              setModeConfirmed(true);
                              setStep('preview');
                            }
                          }}
                          className={cn(
                            'flex flex-col items-center gap-2 rounded-lg border-2 transition-all',
                            isMobile ? 'p-4' : 'p-4',
                            isSelected
                              ? 'border-primary bg-primary/5 text-primary'
                              : 'border-border hover:border-primary/30 hover:bg-accent'
                          )}
                        >
                          <Icon className={cn(isMobile ? "h-6 w-6" : "h-8 w-8")} />
                          <div className="text-center">
                            <div className={cn(isMobile ? "text-sm" : "text-base", "font-semibold")}>{modeConfig.label}</div>
                            <div className={cn(isMobile ? "text-[10px]" : "text-xs", "text-muted-foreground mt-1")}>{modeConfig.description}</div>
                          </div>
                        </button>
                      );
                    });
                  })()}
                </div>
              )}

              {/* Drag & Drop zone - hide if initialFiles are present (we're in "select mode" flow) */}
              {(!initialFiles || initialFiles.length === 0) && (
                <>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => fileInputRef.current?.click()}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        fileInputRef.current?.click();
                      }
                    }}
                    className={cn(
                      'relative flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed transition-all cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2',
                      isMobile ? 'p-6' : 'p-8',
                      isDragging
                        ? 'border-primary bg-primary/5'
                        : 'border-muted-foreground/25 hover:border-muted-foreground/50 hover:bg-accent/50'
                    )}
                  >
                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      accept={SEND_MODES.find((m) => m.value === selectedMode)?.accept}
                      onChange={(e) => handleFileSelect(e.target.files)}
                      className="hidden"
                    />
                    <div
                      className={cn(
                        'w-12 h-12 rounded-full flex items-center justify-center transition-colors',
                        isDragging ? 'bg-primary text-primary-foreground' : 'bg-muted'
                      )}
                    >
                      <Upload className="h-6 w-6" />
                    </div>
                    <div className="text-center">
                      <p className="text-sm font-medium">
                        {isDragging ? 'Отпустите файлы здесь' : 'Перетащите файлы сюда'}
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">или нажмите для выбора</p>
                    </div>
                  </div>

                  <p className="text-xs text-muted-foreground text-center">
                    Максимальный размер файла: {formatBytes(10 * 1024 * 1024)}
                  </p>
                </>
              )}

              {/* Show file preview on 'select' step if files are already added (e.g., from initialFiles) */}
              {files.length > 0 && (
                <div className="space-y-4">
                  <div className="text-sm font-medium">Выбранные файлы:</div>
                  <div className="max-h-[40vh] overflow-y-auto">
                    <AttachmentPreviewList
                      items={files}
                      onRemove={removeFile}
                    />
                  </div>
                  {initialFiles && initialFiles.length > 0 && (
                    <Button
                      className="w-full"
                      size={isMobile ? "lg" : "default"}
                      onClick={() => {
                        setModeConfirmed(true);
                        setStep('preview');
                      }}
                    >
                      Далее
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Step 2: Preview files */}
          {step === 'preview' && (
            <div className="space-y-4">
              <div className="max-h-[40vh] overflow-y-auto">
                <AttachmentPreviewList
                  items={files}
                  onRemove={removeFile}
                />
              </div>

              {/* Mode info - show selected mode */}
              <div className="flex items-center gap-2 p-3 rounded-lg bg-primary/5 border border-primary/10">
                <div className="text-sm">
                  <span className="font-medium">Режим отправки: </span>
                  <span className="text-primary">
                    {SEND_MODES.find(m => m.value === selectedMode)?.label}
                  </span>
                  <span className="text-muted-foreground ml-2">
                    ({SEND_MODES.find(m => m.value === selectedMode)?.description})
                  </span>
                </div>
              </div>

              {/* Size info */}
              {files.some((f) => f.status === 'ready' || f.status === 'sent') && (
                <div className="flex items-center justify-between text-sm p-3 rounded-lg bg-muted/50">
                  <div className="text-muted-foreground">
                    <div>Исходный размер: {formatBytes(totalSize)}</div>
                    <div>После сжатия: {formatBytes(compressedSize)}</div>
                  </div>
                  {savedBytes > 0 && (
                    <div className="text-green-500 font-medium">
                      Экономия: {formatBytes(savedBytes)}
                    </div>
                  )}
                </div>
              )}

              {/* Add more files button */}
              <Button
                variant="outline"
                className="w-full"
                size={isMobile ? "lg" : "default"}
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload className={cn(isMobile ? "h-5 w-5 mr-2" : "h-4 w-4 mr-2")} />
                Добавить файлы
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={SEND_MODES.find((m) => m.value === selectedMode)?.accept}
                onChange={(e) => handleFileSelect(e.target.files)}
                className="hidden"
              />

              {/* Caption input */}
              <div className="space-y-2">
                <label htmlFor="caption" className="text-sm font-medium">
                  Подпись (необязательно)
                </label>
                <textarea
                  id="caption"
                  value={caption}
                  onChange={(e) => setCaption(e.target.value)}
                  placeholder="Добавьте подпись к файлу..."
                  className={cn(
                    "w-full p-2 rounded-md border border-input bg-background resize-none focus:outline-none focus:ring-2 focus:ring-ring",
                    isMobile ? "min-h-[100px] max-h-[200px] text-base" : "min-h-[80px] max-h-[150px] text-sm"
                  )}
                  maxLength={1000}
                />
                <div className="text-xs text-muted-foreground text-right">
                  {caption.length}/1000
                </div>
              </div>
            </div>
          )}

          {/* Step 3: Sending progress */}
          {step === 'sending' && (
            <div className="space-y-6 py-4">
              <div className="flex items-center justify-center">
                <div className="relative">
                  <div className="w-16 h-16 rounded-full border-4 border-primary/20" />
                  <div
                    className="absolute inset-0 rounded-full border-4 border-primary border-t-transparent animate-spin"
                  />
                  <div className="absolute inset-0 flex items-center justify-center">
                    <span className="text-lg font-bold">{overallProgress}%</span>
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Отправка файлов...</span>
                  <span className="font-medium">{files.filter(f => f.status === 'sent').length} / {files.length}</span>
                </div>
                <Progress value={overallProgress} className="h-2" />
              </div>

              <div className="space-y-2">
                {files.map((file) => (
                  <div key={file.id} className="flex items-center gap-2 text-sm">
                    {file.status === 'uploading' && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
                    {file.status === 'sent' && <div className="h-4 w-4 rounded-full bg-green-500" />}
                    {file.status === 'error' && <AlertCircle className="h-4 w-4 text-destructive" />}
                    <span className="truncate flex-1">{file.file.name}</span>
                    <span className="text-muted-foreground">{file.progress}%</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer actions - always visible at bottom */}
        <FooterComponent className="gap-2 px-4 py-3 bg-background border-t flex-shrink-0">
          {step === 'preview' && (
            <>
              <Button
                variant="outline"
                onClick={handleClose}
                disabled={isUploading}
                size={isMobile ? "lg" : "default"}
              >
                Отмена
              </Button>
              <Button
                onClick={handleSend}
                disabled={files.length === 0 || processing || files.every((f) => f.status === 'error')}
                size={isMobile ? "lg" : "default"}
              >
                {processing ? (
                  <>
                    <Loader2 className={cn(isMobile ? "h-5 w-5 mr-2" : "h-4 w-4 mr-2")} animate-spin />
                    Обработка...
                  </>
                ) : (
                  <>
                    <Send className={cn(isMobile ? "h-5 w-5 mr-2" : "h-4 w-4 mr-2")} />
                    Отправить {files.length > 0 && `(${files.length})`}
                  </>
                )}
              </Button>
            </>
          )}

          {step === 'sending' && (
            <Button
              variant="destructive"
              onClick={cancel}
              size={isMobile ? "lg" : "default"}
            >
              <X className={cn(isMobile ? "h-5 w-5 mr-2" : "h-4 w-4 mr-2")} />
              Отменить
            </Button>
          )}

          {step === 'select' && (
            <Button variant="outline" onClick={handleClose}>
              Отмена
            </Button>
          )}
        </FooterComponent>
      </ContentComponent>
    </DialogComponent>
  );
}

export default FileSendDialog;