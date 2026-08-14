import { zodResolver } from '@hookform/resolvers/zod';
import {
  File,
  Image,
  Loader2,
  Mic,
  MicOff,
  Music,
  Paperclip,
  Reply,
  Send,
  SmilePlus,
  Video,
  VideoOff,
  X,
} from 'lucide-react';
import { forwardRef,useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Textarea } from '@/components/ui/textarea';
import { useChat, useWebSocketContext } from '@/contexts';
import { useAuth } from '@/contexts/AuthContext';
import { useFileUpload } from '@/hooks/useFileUpload';
import { useIsMobile } from '@/hooks/use-mobile';
import { useBroadcastAction } from '@/lib/broadcast';
import { formatBytes, type SendMode } from '@/lib/media';
import { type MessageInput as MessageInputType, messageSchema } from '@/lib/validation';
import { useDraftStore } from '@/stores';
import { toast } from '@/stores/toast-store';
import type { Attachment } from '@/types';

import { AttachmentPreviewList } from './AttachmentPreview';
import { FileSendDialog } from './FileSendDialog';
import { MediaRecordButton } from './MediaRecordButton';

interface MessageInputProps {
  chatId: string;
  chatType?: string;
  recipientId?: string;
  disabled?: boolean;
}

export const MessageInput = forwardRef(function MessageInput(
  { chatId, chatType, recipientId, disabled }: MessageInputProps,
  ref: React.ForwardedRef<{
    openFileDialog: (files: File[], mode: SendMode) => void;
  }>
) {
  useImperativeHandle(ref, () => ({
    openFileDialog(files: File[], mode: SendMode) {
      setSelectedFiles(files);
      setSelectedMode(mode);
      setFileDialogOpen(true);
    },
  }));

   const { sendMessage, sendFavoritesMessage, setChats } = useChat();
   const { isConnected: wsConnected, sendTyping } = useWebSocketContext();
   const { user } = useAuth();
   const isMobile = useIsMobile();

    // File upload dialog state
    const [fileDialogOpen, setFileDialogOpen] = useState(false);
    const [selectedMode, setSelectedMode] = useState<SendMode>('file');
    const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
    const fileInputRef = useRef<HTMLInputElement>(null);
    
     // Reply state
     const [replyTo, setReplyTo] = useState<{ messageId: string; chatId: string; senderName: string; content: string; originalSenderId?: string } | null>(null);

    // Voice recording state
    const [isRecording, setIsRecording] = useState(false);
    const [recordingTime, setRecordingTime] = useState(0);
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const recordingIntervalRef = useRef<number | null>(null);

    // Video recording state
    const [isVideoRecording, setIsVideoRecording] = useState(false);
    const [videoRecordingTime, setVideoRecordingTime] = useState(0);
    const videoRecorderRef = useRef<MediaRecorder | null>(null);
    const videoIntervalRef = useRef<number | null>(null);
    const videoStreamRef = useRef<MediaStream | null>(null);
    const videoPreviewRef = useRef<HTMLVideoElement | null>(null);

    // Unified media mode: 'voice' or 'video'
    const [mediaMode, setMediaMode] = useState<'voice' | 'video'>('voice');
    const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user');

  const {
    files: quickFiles,
    removeFile: removeQuickFile,
    clearFiles: clearQuickFiles,
    processing: quickProcessing,
    sendFiles: sendQuickFiles,
    cancel: cancelQuickUpload,
    isUploading: isQuickUploading,
  } = useFileUpload({
    chatId,
    chatType: chatType as 'private' | 'group' | 'favorites' | undefined,
    recipientId,
    onSuccess: () => {
      clearQuickFiles();
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

  // Cross-tab broadcast for typing sync
  const { broadcastTypingStart, broadcastTypingStop } = useBroadcastAction();

    // Use draft store for message persistence
    const { getDraft, setDraft, clearDraft } = useDraftStore();

    const typingTimeoutRef = useRef<number | null>(null);
    const textareaElementRef = useRef<HTMLTextAreaElement | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);

  // Form setup with React Hook Form
  // (MUST be declared before the useEffects below that reference `reset`
  //  in their dependency arrays — otherwise we hit a TDZ ReferenceError at
  //  render time. The previous ordering crashed the whole chat view with
  //  "Cannot access 'reset' before initialization".)
  const {
    register,
    handleSubmit,
    watch,
    setValue,
    reset,
    formState: { isSubmitting },
  } = useForm<MessageInputType>({
    resolver: zodResolver(messageSchema),
    defaultValues: {
      content: getDraft(chatId),
    },
  });

  const message = watch('content');
    
     // Handle reply-to-message event from MessageBubble
     useEffect(() => {
       const handler = (evt: CustomEvent<{ messageId: string; chatId: string; senderName: string; content: string; originalSenderId?: string }>) => {
         // Only set reply if it's for the current chat
         if (evt.detail.chatId === chatId) {
           setReplyTo({
             messageId: evt.detail.messageId,
             chatId: evt.detail.chatId,
             senderName: evt.detail.senderName,
             content: evt.detail.content,
             originalSenderId: evt.detail.originalSenderId,
           });
         }
       };
       
       window.addEventListener('zerochat:reply-to-message', handler as EventListener);
       return () => window.removeEventListener('zerochat:reply-to-message', handler as EventListener);
     }, [chatId]);
    
    // Clear reply and load draft when chat changes
    useEffect(() => {
      setReplyTo(null);
      // Reset form with the new chat's saved draft
      reset({ content: getDraft(chatId) });
    }, [chatId, reset, getDraft]);

  // Register the textarea
  const { ref: textareaRef, ...textareaProps } = register('content');

  // Handle typing indicator with cross-tab sync
  const handleTypingIndicator = useCallback(() => {
    // Clear previous timeout
    if (typingTimeoutRef.current !== null) {
      clearTimeout(typingTimeoutRef.current);
    }

    // Send typing indicator via WebSocket
    sendTyping(chatId, true);

    // Broadcast to other tabs
    if (user?.id) {
      broadcastTypingStart(chatId, user.id);
    }

    // Stop typing after 2 seconds of inactivity
    typingTimeoutRef.current = window.setTimeout(() => {
      sendTyping(chatId, false);
      if (user?.id) {
        broadcastTypingStop(chatId, user.id);
      }
    }, 2000);
  }, [chatId, sendTyping, broadcastTypingStart, broadcastTypingStop, user?.id]);

  // Handle form submission
   const onSubmit = async (data: MessageInputType) => {
    if (!data.content.trim()) return;

    const content = data.content.trim();
    reset({ content: '' });
    clearDraft(chatId);

    // Restore focus after reset
    setTimeout(() => {
      textareaElementRef.current?.focus();
    }, 0);

     try {
       // Build metadata for reply (used for both favorites and regular chats)
       let metadata: Record<string, any> | undefined;
       let replyToId: string | undefined;
       if (replyTo) {
         replyToId = replyTo.messageId;
         metadata = {
           replyTo: {
             messageId: replyTo.messageId,
             originalSenderId: replyTo.originalSenderId,
           },
         };
       }

       // Use sendFavoritesMessage for favorites chat, regular sendMessage for others
       if (chatType === 'favorites') {
         await sendFavoritesMessage(content, undefined, replyToId, metadata);
       } else {
         await sendMessage(content, undefined, replyToId, metadata);
       }
       // Clear reply after sending
       setReplyTo(null);
      // Dispatch event to scroll to bottom
      window.dispatchEvent(new CustomEvent('zerochat:message-sent'));
    } catch (error) {
      console.error('Failed to send message:', error);
      // Restore message on failure
      setValue('content', content);
      setDraft(chatId, content);
    }
  };

  // Handle text change
  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setDraft(chatId, value);
    handleTypingIndicator();
  };

  // Handle keyboard
  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Skip Enter handling during IME composition (CJK input methods)
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (message?.trim() && !isSubmitting) {
        void handleSubmit(onSubmit)();
      }
    }
  };

  // Handle blur for typing indicator - stop typing when leaving input
  const handleBlur = () => {
    sendTyping(chatId, false);
  };

  // Cleanup typing timeout
  useEffect(() => {
    return () => {
      if (typingTimeoutRef.current !== null) {
        clearTimeout(typingTimeoutRef.current);
      }
    };
  }, []);

  // Cleanup recording on unmount
  useEffect(() => {
    return () => {
      if (recordingIntervalRef.current) {
        clearInterval(recordingIntervalRef.current);
      }
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
    };
  }, []);

  // Auto-resize textarea for mobile keyboard
  const handleTextareaResize = useCallback(() => {
    if (textareaElementRef.current) {
      textareaElementRef.current.style.height = 'auto';
      const newHeight = Math.min(textareaElementRef.current.scrollHeight, isMobile ? 120 : 150);
      textareaElementRef.current.style.height = `${newHeight}px`;
    }
  }, [isMobile]);

  // Voice recording functions
  const startRecording = useCallback(async (): Promise<boolean> => {
    // Check if we're on HTTPS (required for getUserMedia on mobile)
    if (typeof window !== 'undefined' && !window.location.origin.includes('https') &&
        window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
      toast.error(
        'Требуется HTTPS',
        'Запись голоса работает только по HTTPS. Используйте защищенное соединение.'
      );
      return false;
    }

    // Check if getUserMedia is supported
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast.error(
        'Не поддерживается',
        'Ваш браузер не поддерживает запись аудио. Попробуйте другой браузер.'
      );
      return false;
    }

    try {
      // Request microphone permission
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 44100
        }
      });

      // Determine supported MIME type
      const possibleTypes = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/ogg;codecs=opus',
        'audio/mp4',
        'audio/mpeg'
      ];
      
      let selectedMimeType = 'audio/webm';
      for (const type of possibleTypes) {
        if (MediaRecorder.isTypeSupported(type)) {
          selectedMimeType = type;
          break;
        }
      }

      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: selectedMimeType
      });
      mediaRecorderRef.current = mediaRecorder;
      
      const chunks: Blob[] = [];
      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          chunks.push(e.data);
        }
      };
      
      mediaRecorder.onstop = () => {
        const blob = new Blob(chunks, { type: selectedMimeType });
        // Create file from blob with proper extension
        const extension = selectedMimeType.includes('mp4') ? 'm4a' :
                         selectedMimeType.includes('mpeg') ? 'mp3' :
                         selectedMimeType.includes('ogg') ? 'ogg' : 'webm';
        const fileName = `voice-${Date.now()}.${extension}`;
        // Create a proper File object (not a Blob cast to File).
        // File has lastModified, webkitRelativePath, and instanceof File
        // checks that downstream code relies on.
        const file = new File([blob], fileName, {
          type: selectedMimeType,
          lastModified: Date.now(),
        });
        // Set mode to 'audio' for proper processing and to bypass mode selection
        setSelectedMode('audio');
        setSelectedFiles([file]);
        setFileDialogOpen(true);
        // Stop all tracks to release microphone
        stream.getTracks().forEach(track => track.stop());
      };
      
      mediaRecorder.onerror = (event) => {
        console.error('MediaRecorder error:', event);
        toast.error(
          'Ошибка записи',
          'Произошла ошибка при записи аудио. Попробуйте еще раз.'
        );
        setIsRecording(false);
        if (recordingIntervalRef.current) {
          clearInterval(recordingIntervalRef.current);
          recordingIntervalRef.current = null;
        }
        stream.getTracks().forEach(track => track.stop());
      };
      
      mediaRecorder.start();
      setIsRecording(true);
      setRecordingTime(0);
      
      recordingIntervalRef.current = window.setInterval(() => {
        setRecordingTime(prev => {
          // Auto-stop at 5 minutes to prevent excessively long recordings
          if (prev >= 300) {
            stopRecording();
            return 0;
          }
          return prev + 1;
        });
      }, 1000);
      
      return true;
    } catch (error: any) {
      console.error('Failed to start recording:', error);
      
      let errorMessage = 'Не удалось начать запись. ';
      if (error.name === 'NotAllowedError') {
        errorMessage += 'Разрешите доступ к микрофону в настройках браузера.';
      } else if (error.name === 'NotFoundError') {
        errorMessage += 'Микрофон не найден. Убедитесь, что он подключен.';
      } else if (error.name === 'NotReadableError') {
        errorMessage += 'Микрофон занят другим приложением.';
      } else {
        errorMessage += error?.message || 'Неизвестная ошибка';
      }
      
      toast.error('Ошибка доступа к микрофону', errorMessage);
      return false;
    }
  }, []);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    if (recordingIntervalRef.current) {
      clearInterval(recordingIntervalRef.current);
      recordingIntervalRef.current = null;
    }
    setIsRecording(false);
    setRecordingTime(0);
  }, []);

  // Cancel recording — stops the recorder but discards the audio
  // (prevents FileSendDialog from opening).
  const cancelRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      // Replace onstop handler to discard the blob
      mediaRecorderRef.current.onstop = () => {
        // Discard — do nothing with the recorded data
        if (mediaRecorderRef.current?.stream) {
          mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
        }
      };
      mediaRecorderRef.current.stop();
    }
    if (recordingIntervalRef.current) {
      clearInterval(recordingIntervalRef.current);
      recordingIntervalRef.current = null;
    }
    setIsRecording(false);
    setRecordingTime(0);
  }, []);

  const formatRecordingTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  // ===== Video Recording =====

  const startVideoRecording = useCallback(async () => {
    if (isVideoRecording) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode, width: { ideal: 640 }, height: { ideal: 480 } },
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      videoStreamRef.current = stream;

      // Show live preview
      if (videoPreviewRef.current) {
        videoPreviewRef.current.srcObject = stream;
        void videoPreviewRef.current.play();
      }

      // Determine supported MIME type
      const possibleTypes = [
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm',
        'video/mp4',
      ];
      let selectedMimeType = 'video/webm';
      for (const type of possibleTypes) {
        if (MediaRecorder.isTypeSupported(type)) { selectedMimeType = type; break; }
      }

      const recorder = new MediaRecorder(stream, { mimeType: selectedMimeType });
      videoRecorderRef.current = recorder;
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => { if (e.data?.size > 0) chunks.push(e.data); };
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: selectedMimeType });
        const extension = selectedMimeType.includes('mp4') ? 'mp4' : 'webm';
        const fileName = `video-${Date.now()}.${extension}`;
        const file = new File([blob], fileName, { type: selectedMimeType, lastModified: Date.now() });
        setSelectedMode('video');
        setSelectedFiles([file]);
        setFileDialogOpen(true);
        stream.getTracks().forEach(t => t.stop());
        videoStreamRef.current = null;
      };
      recorder.onerror = () => {
        toast.error('Ошибка записи видео', 'Произошла ошибка при записи.');
      };

      recorder.start();
      setIsVideoRecording(true);
      setVideoRecordingTime(0);
      videoIntervalRef.current = window.setInterval(() => {
        setVideoRecordingTime(prev => {
          // U2: Auto-stop video at 60 seconds (was 30 — too short for typical
          // video messages; voice is 5 min, video 60s matches Telegram).
          if (prev >= 60) { // Auto-stop at 60 seconds
            stopVideoRecording();
            return 0;
          }
          return prev + 1;
        });
      }, 1000);
    } catch (error: any) {
      let msg = 'Не удалось начать запись видео. ';
      if (error.name === 'NotAllowedError') msg += 'Разрешите доступ к камере.';
      else if (error.name === 'NotFoundError') msg += 'Камера не найдена.';
      else msg += error?.message || 'Неизвестная ошибка';
      toast.error('Ошибка доступа к камере', msg);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVideoRecording, facingMode]);

  const flipCamera = useCallback(() => {
    // F6 fix: flipping the camera mid-recording would stop the
    // current video track and start a new stream, but the
    // MediaRecorder keeps writing the OLD track's data (it cannot
    // re-bind its source). The result is a corrupted recording
    // (frozen frame or garbage) plus a confusing UX where the
    // preview flips but the saved video doesn't.
    //
    // Block the action while recording and tell the user to stop
    // and re-record. This matches the spec'd minimal fix.
    if (isVideoRecording) {
      toast.warning(
        'Нельзя переключить камеру во время записи',
        'Остановите запись и начните заново',
      );
      return;
    }

    setFacingMode(prev => prev === 'user' ? 'environment' : 'user');
    // If we have a preview stream (not recording), restart it with
    // the new facingMode so the preview updates immediately.
    if (videoStreamRef.current) {
      // Stop current stream
      videoStreamRef.current.getTracks().forEach(t => t.stop());
      // Start new stream with updated facing mode (will be picked up by next render)
      void (async () => {
        try {
          const newStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: facingMode === 'user' ? 'environment' : 'user', width: { ideal: 640 }, height: { ideal: 480 } },
            audio: { echoCancellation: true, noiseSuppression: true },
          });
          videoStreamRef.current = newStream;
          if (videoPreviewRef.current) {
            videoPreviewRef.current.srcObject = newStream;
            void videoPreviewRef.current.play();
          }
        } catch (e) {
          console.error('Failed to flip camera:', e);
        }
      })();
    }
  }, [isVideoRecording, facingMode]);

  const stopVideoRecording = useCallback(() => {
    if (videoRecorderRef.current && videoRecorderRef.current.state !== 'inactive') {
      videoRecorderRef.current.stop();
    }
    if (videoIntervalRef.current) { clearInterval(videoIntervalRef.current); videoIntervalRef.current = null; }
    setIsVideoRecording(false);
    setVideoRecordingTime(0);
  }, []);

  const cancelVideoRecording = useCallback(() => {
    if (videoRecorderRef.current && videoRecorderRef.current.state !== 'inactive') {
      videoRecorderRef.current.onstop = () => {
        if (videoStreamRef.current) videoStreamRef.current.getTracks().forEach(t => t.stop());
        videoStreamRef.current = null;
      };
      videoRecorderRef.current.stop();
    }
    if (videoIntervalRef.current) { clearInterval(videoIntervalRef.current); videoIntervalRef.current = null; }
    setIsVideoRecording(false);
    setVideoRecordingTime(0);
  }, []);

   // Send quick files (auto-detected mode)
   const handleSendQuickFiles = useCallback(async () => {
     if (quickFiles.length === 0) return;
     
     // Auto-detect mode based on first file
     const firstFile = quickFiles[0]?.file;
     if (!firstFile) return;
     
     let mode: 'photo' | 'video' | 'audio' | 'file' = 'file';
     if (firstFile.type.startsWith('image/')) mode = 'photo';
     else if (firstFile.type.startsWith('video/')) mode = 'video';
     else if (firstFile.type.startsWith('audio/')) mode = 'audio';
     
     await sendQuickFiles(mode);
   }, [quickFiles, sendQuickFiles]);

   // Clear selected files when dialog closes
   const handleFileDialogOpenChange = useCallback((open: boolean) => {
     if (!open) {
       setSelectedFiles([]);
       setSelectedMode('file');
     }
     setFileDialogOpen(open);
   }, []);

   // Handle file selection from popover menu
   const handleFileSelect = useCallback((mode: SendMode, accept: string) => {
     setSelectedMode(mode);
     // Trigger hidden file input
     if (fileInputRef.current) {
       fileInputRef.current.accept = accept;
       fileInputRef.current.click();
     }
   }, []);

   // Handle file input change
   const handleFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
     const files = e.target.files;
     if (!files || files.length === 0) return;
     
     // Convert FileList to Array and store
     const fileArray = Array.from(files);
     setSelectedFiles(fileArray);
     setFileDialogOpen(true);
     
     // Reset input value to allow selecting the same file again
     if (fileInputRef.current) {
       fileInputRef.current.value = '';
     }
   }, []);

  // Emojis
  const emojis = ['😀', '😂', '😊', '😍', '🥰', '🤔', '👍', '👎', '❤️', '🔥', '🎉', '💩', '👀', '🙈', '🙏', '✨', '⭐', '💯', '🤝', '💪'];

  // Connection status indicator
  const isConnected = wsConnected;

  // Calculate total size of quick files
  const quickFilesSize = quickFiles.reduce((acc, f) => acc + f.file.size, 0);

  return (
    <div 
      ref={containerRef}
      className="border-t p-3 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 relative"
    >
      {/* Quick file attachments preview */}
      {quickFiles.length > 0 && (
        <div className="mb-3 p-3 rounded-lg bg-muted/50 border">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium">
              Вложения ({quickFiles.length})
            </span>
            <span className="text-xs text-muted-foreground">
              {formatBytes(quickFilesSize)}
            </span>
          </div>
          <AttachmentPreviewList
            items={quickFiles}
            onRemove={removeQuickFile}
          />
          <div className="flex gap-2 mt-3">
            <Button
              size="sm"
              className="flex-1"
              onClick={handleSendQuickFiles}
              disabled={isQuickUploading || quickProcessing}
            >
              {isQuickUploading ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Send className="h-4 w-4 mr-2" />
              )}
              Отправить файлы
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={cancelQuickUpload}
              disabled={isQuickUploading}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Reply quote */}
      {replyTo && (
        <div className="mb-2 p-2 rounded-lg bg-muted/50 border-l-2 border-primary">
          <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2">
            <Reply className="w-3 h-3 text-primary" />
            <span className="text-xs font-medium text-primary">{replyTo.senderName}</span>
          </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-5 w-5"
              onClick={() => setReplyTo(null)}
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
          <p className="text-xs text-muted-foreground line-clamp-2">{replyTo.content}</p>
        </div>
      )}

      <form onSubmit={handleSubmit(onSubmit)} className="flex items-end gap-2">
        {/* Attachment button */}
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={`text-muted-foreground shrink-0 ${isMobile ? 'h-11 w-11' : 'h-10 w-10'}`}
                disabled={disabled || isSubmitting || isQuickUploading || isRecording || isVideoRecording}
              >
                <Paperclip className={isMobile ? 'h-6 w-6' : 'h-5 w-5'} />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-auto p-2">
              <div className="grid gap-2">
                <button
                  type="button"
                  className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent rounded-md h-11 w-full"
                  onClick={() => handleFileSelect('photo', 'image/*')}
                >
                  <Image className="w-5 h-5" />
                  Фото
                </button>
                <button
                  type="button"
                  className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent rounded-md h-11 w-full"
                  onClick={() => handleFileSelect('video', 'video/*')}
                >
                  <Video className="w-5 h-5" />
                  Видео
                </button>
                <button
                  type="button"
                  className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent rounded-md h-11 w-full"
                  onClick={() => handleFileSelect('audio', 'audio/*')}
                >
                  <Music className="w-5 h-5" />
                  Аудио
                </button>
                <button
                  type="button"
                  className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent rounded-md h-11 w-full"
                  onClick={() => handleFileSelect('file', '*/*')}
                >
                  <File className="w-5 h-5" />
                  Файл
                </button>
              </div>
            </PopoverContent>
          </Popover>

        {/* Textarea, Voice recording timer, or Video recording preview */}
        {isVideoRecording ? (
          <div className="flex-1 relative rounded-2xl overflow-hidden bg-black border border-red-500/20" style={{ minHeight: isMobile ? '120px' : '100px' }}>
            <video
              ref={videoPreviewRef}
              autoPlay
              muted
              playsInline
              className="w-full h-full object-cover"
              style={{ minHeight: isMobile ? '120px' : '100px', maxHeight: isMobile ? '200px' : '180px' }}
            />
            <div className="absolute top-2 left-2 flex items-center gap-2 bg-black/50 backdrop-blur-sm rounded-full px-3 py-1">
              <div className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" />
              <span className="text-xs font-medium text-white">
                {formatRecordingTime(videoRecordingTime)} / 1:00
              </span>
            </div>
          </div>
        ) : isRecording ? (
          <div className="flex-1 flex items-center gap-2 px-4 py-3 rounded-2xl bg-red-500/10 border border-red-500/20">
            <div className="w-3 h-3 rounded-full bg-red-500 animate-pulse" />
            <span className="text-sm font-medium text-red-500">
              {formatRecordingTime(recordingTime)}
            </span>
            <span className="text-xs text-muted-foreground ml-auto">
              ← Отмена · ↑ Блок
            </span>
          </div>
        ) : (
          <Textarea
            {...textareaProps}
            ref={(el) => {
              textareaRef(el);
              textareaElementRef.current = el;
            }}
            onChange={(e) => {
              void textareaProps.onChange(e);
              handleChange(e);
              handleTextareaResize();
            }}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
            onFocus={handleTextareaResize}
            placeholder={isConnected ? "Написать сообщение..." : "Нет подключения..."}
            className="field-sizing-content min-h-[48px] resize-none rounded-2xl px-4 py-3 border-muted bg-muted/30 focus:bg-background transition-colors"
            style={{ maxHeight: isMobile ? '120px' : '150px' }}
            disabled={disabled || isSubmitting || isQuickUploading || isRecording || isVideoRecording}
          />
        )}

        {/* Emoji button */}
        <Popover>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={`text-muted-foreground shrink-0 ${isMobile ? 'h-11 w-11' : 'h-10 w-10'}`}
              disabled={disabled || isSubmitting || isQuickUploading || isRecording || isVideoRecording}
            >
              <SmilePlus className={isMobile ? 'h-6 w-6' : 'h-5 w-5'} />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-64 p-3">
            <div className="grid grid-cols-8 sm:grid-cols-10 gap-2">
              {emojis.map((emoji, index) => (
                <button
                  key={index}
                  type="button"
                  className="text-xl p-1 hover:bg-accent rounded-md transition-colors"
                  onClick={() => setValue('content', (message || '') + emoji)}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>

        {/* Send button or MediaRecordButton (Telegram-style gestures) */}
        {message?.trim() ? (
          <Button
            type="submit"
            size="icon"
            className={`rounded-full shrink-0 bg-primary text-primary-foreground hover:bg-primary/90 ${isMobile ? 'h-11 w-11' : 'h-10 w-10'}`}
            disabled={disabled || isSubmitting || isQuickUploading || isRecording || isVideoRecording}
          >
            {isSubmitting ? (
              <Loader2 className={isMobile ? 'h-6 w-6 animate-spin' : 'h-5 w-5 animate-spin'} />
            ) : (
              <Send className={isMobile ? 'h-6 w-6' : 'h-5 w-5'} />
            )}
          </Button>
        ) : (
          <MediaRecordButton
            mode={mediaMode}
            onToggleMode={() => setMediaMode(prev => prev === 'voice' ? 'video' : 'voice')}
            onStartRecording={() => {
              if (mediaMode === 'voice') void startRecording();
              else void startVideoRecording();
            }}
            onStopAndSend={() => {
              if (isVideoRecording) stopVideoRecording();
              else stopRecording();
            }}
            onCancel={() => {
              if (isVideoRecording) cancelVideoRecording();
              else cancelRecording();
            }}
            recordingTime={isVideoRecording ? videoRecordingTime : recordingTime}
            isRecording={isRecording}
            isVideoRecording={isVideoRecording}
            onFlipCamera={mediaMode === 'video' ? flipCamera : undefined}
            disabled={disabled || isSubmitting || isQuickUploading}
          />
        )}
      </form>

       {/* Connection status */}
       {!isConnected && (
         <div className="text-xs text-red-500 mt-1 text-center">
           Нет подключения к серверу
         </div>
       )}

       {/* Hidden file input */}
       <input
         ref={fileInputRef}
         type="file"
         multiple
         className="hidden"
         onChange={handleFileInputChange}
       />

       {/* File Send Dialog */}
       <FileSendDialog
         chatId={chatId}
         chatType={chatType as 'private' | 'group' | 'favorites' | undefined}
         recipientId={recipientId}
         open={fileDialogOpen}
         onOpenChange={handleFileDialogOpenChange}
         initialMode={selectedMode}
         initialFiles={selectedFiles}
         onSuccess={() => {
           window.dispatchEvent(new CustomEvent('zerochat:message-sent'));
         }}
       />
    </div>
  );
});
