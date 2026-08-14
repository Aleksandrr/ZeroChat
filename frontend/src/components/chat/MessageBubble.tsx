import { ChevronDown, Copy, Edit, Forward, Pin, Reply, Trash2 } from 'lucide-react';
import { memo, useEffect, useMemo, useState } from 'react';

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu';
import * as Popover from '@radix-ui/react-popover';
import { useAuth } from '@/contexts/AuthContext';
import { useChat } from '@/contexts';
import { useIsMobile } from '@/hooks/use-mobile';
import { useLongPress } from '@/hooks/useLongPress';
import { useSwipeGesture } from '@/hooks/useSwipeGesture';
import { cn } from '@/lib/utils';
import { fileLogger } from '@/lib/utils/file-logger';
import { resolveDisplayName } from '@/lib/contacts/contacts-utils';
import { toast } from '@/stores/toast-store';
import { Button } from '@/components/ui/button';
import type { Attachment, Message, User } from '@/types';

import { MessageAttachments } from './MessageAttachment';
import { QuotePreview } from './QuotePreview';
import { ReactionPicker, QUICK_REACTIONS } from './ReactionPicker';

// Берем первые 4 реакции для быстрого доступа в контекстном меню
const QUICK_REACTIONS_FOR_MENU = QUICK_REACTIONS.slice(0, 4);

interface MessageBubbleProps {
  message: Message;
  isOwn: boolean;
  showAvatar?: boolean;
  showName?: boolean;
  name?: string;
  avatar?: string;
  alignWithAvatar?: boolean;
  decryptedData?: Map<string, Uint8Array>;
  decryptingAttachments?: Set<string>;
  decryptErrors?: Map<string, string>;
  replyToMessage?: Message | null;
  replyToOriginalSenderId?: string | null;
  highlighted?: boolean;
  onImageClick?: (attachment: Attachment) => void;
  participants?: User[]; // List of chat participants for reaction name resolution
  onOpenContactCard?: (userId: string) => void;
}

const ANIMATION_WINDOW_MS = 5000;

// U7: MessageStatus union mixes uppercase ('SENT' | 'DELIVERED' | 'READ' |
// 'SENDING' | 'FAILED') and lowercase ('sending' | 'sent' | 'failed') variants
// because different layers (storage vs. server payload) used different
// conventions. Normalize to lowercase before branching on a specific value —
// storage layer writes lowercase, server emits uppercase, both should render
// the same check mark.
function normalizeMessageStatus(
  status: string | undefined,
): 'sending' | 'sent' | 'delivered' | 'read' | 'failed' | null {
  if (!status) return null;
  const lower = String(status).toLowerCase();
  if (lower === 'sending' || lower === 'sent' || lower === 'delivered' || lower === 'read' || lower === 'failed') {
    return lower;
  }
  return null;
}

export const MessageBubble = memo(function MessageBubble({
  message,
  isOwn,
  showAvatar = true,
  showName = false,
  name,
  avatar,
  alignWithAvatar = false,
  decryptedData,
  decryptingAttachments,
  decryptErrors,
  replyToMessage,
  replyToOriginalSenderId,
  highlighted = false,
  onImageClick,
  participants,
  onOpenContactCard,
}: MessageBubbleProps) {
  const { user } = useAuth();
  const { editMessage, pinMessage, unpinMessage, deleteMessage, reactToMessage } = useChat();
  const isMobile = useIsMobile();

  // Inline edit mode state
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteForEveryone, setDeleteForEveryone] = useState(false);

  // Long press for mobile context menu
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const { longPressState, handlers: longPressHandlers } = useLongPress({
    onLongPress: () => {
      if (isMobile) {
        setContextMenuOpen(true);
      }
    },
    delay: 500,
  });

  // Map userId to display name for reactions
  const participantNames = useMemo(() => {
    if (!participants || participants.length === 0) {
      return new Map<string, string>();
    }
    const map = new Map<string, string>();
    for (const p of participants) {
      const name = p.displayName || p.username || p.id;
      map.set(p.id, name);
    }
    return map;
  }, [participants]);

  useEffect(() => {
    if (message.replyTo && !replyToMessage && process.env.NODE_ENV === 'development') {
      // Reply not found - debug info available in dev mode
    }
  }, [message.id, message.replyTo, replyToMessage]);

  const formatTime = (timestamp: string) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
    });
  };

   const [displayName, setDisplayName] = useState<string>(name || 'Unknown');
   const [originalAuthorName, setOriginalAuthorName] = useState<string>(
     message.metadata?.forwardedFrom?.senderName || message.metadata?.forwardedFrom?.senderId || ''
   );

   // Resolve display name for the sender (forwarder)
   useEffect(() => {
     let mounted = true;
     async function resolve() {
       // Always resolve sender's name with isForwarded=false because we're resolving
       // the person who sent this message to the chat (the forwarder), not the original
       // author of forwarded content. The original author's name should be in forwardedFrom.senderName.
       const resolved = await resolveDisplayName(message.senderId, message.chatId, false);
       if (mounted) setDisplayName(resolved);
     }
     void resolve();
     return () => { mounted = false; };
   }, [message.senderId, message.chatId, name]);

  // Resolve original author name if missing in forwardedFrom
  useEffect(() => {
    const forwarded = message.metadata?.forwardedFrom;
    if (!forwarded) return;

    // If senderName already present, use it
    if (forwarded.senderName) {
      setOriginalAuthorName(forwarded.senderName);
      return;
    }

    // Try to find in participants first (original author might be in the current chat)
    const authorInParticipants = participants?.find(p => p.id === forwarded.senderId);
    if (authorInParticipants) {
      setOriginalAuthorName(authorInParticipants.displayName || authorInParticipants.username || forwarded.senderId);
      return;
    }

    // Resolve name from server (isForwarded=true to skip contacts/cache for original author)
    let mounted = true;
    async function resolve() {
      const resolved = await resolveDisplayName(forwarded.senderId, message.chatId, true);
      if (mounted) setOriginalAuthorName(resolved || forwarded.senderId);
    }
    void resolve();
    return () => { mounted = false; };
  }, [message.metadata?.forwardedFrom, message.chatId, participants]);

  const shouldAnimate = useMemo(() => {
    const messageTime = new Date(message.createdAt).getTime();
    const currentTime = Date.now();
    const timeDiff = currentTime - messageTime;
    return timeDiff < ANIMATION_WINDOW_MS;
  }, [message.createdAt]);

  const handleCopy = () => {
    try {
      if (!message.content) {
        toast.warning('Нечего копировать');
        return;
      }
      void navigator.clipboard.writeText(message.content);
      toast.success('Скопировано');
    } catch {
      toast.error('Не удалось скопировать');
    }
  };

  const handleEdit = () => {
    if (!message) return;
    setEditContent(message.content || '');
    setIsEditing(true);
  };

  const handleSaveEdit = async () => {
    if (!editContent.trim() || editContent.trim() === message.content) {
      setIsEditing(false);
      return;
    }
    try {
      await editMessage(message.id, message.chatId, editContent.trim());
      setIsEditing(false);
    } catch (error) {
      console.error('[MessageBubble] Failed to edit message:', error);
      toast.error('Не удалось редактировать сообщение');
    }
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    setEditContent('');
  };

  const handlePin = async () => {
    if (!message) return;
    try {
      if (message.isPinned) {
        await unpinMessage(message.id, message.chatId);
      } else {
        await pinMessage(message.id, message.chatId);
      }
    } catch (error) {
      console.error('[MessageBubble] Failed to pin/unpin message:', error);
      toast.error('Не удалось закрепить сообщение');
    }
  };

  const handleDelete = () => {
    if (!message) return;
    setDeleteForEveryone(false);
    setIsDeleting(true);
  };

  const handleConfirmDelete = async () => {
    if (!message) return;
    try {
      await deleteMessage(message.id, message.chatId, deleteForEveryone);
      setIsDeleting(false);
    } catch (error) {
      console.error('[MessageBubble] Failed to delete message:', error);
      toast.error('Не удалось удалить сообщение');
      setIsDeleting(false);
    }
  };

  const handleReply = () => {
    let replySenderName = displayName;
    let replySenderId = message.senderId;

    if (message.metadata?.forwardedFrom) {
      // Use resolved original author name if available, otherwise fallback to senderId
      replySenderName = originalAuthorName || message.metadata.forwardedFrom.senderId;
      replySenderId = message.metadata.forwardedFrom.senderId || message.senderId;
    }

    window.dispatchEvent(new CustomEvent('zerochat:reply-to-message', {
      detail: {
        messageId: message.id,
        chatId: message.chatId,
        senderName: replySenderName,
        content: message.content,
        originalSenderId: replySenderId
      }
    }));
  };

  const handleQuoteClick = () => {
    if (replyToMessage && replyToMessage.id) {
      window.dispatchEvent(new CustomEvent('zerochat:scroll-to-message', {
        detail: {
          messageId: replyToMessage.id,
          chatId: message.chatId
        }
      }));
    }
  };

  const handleQuoteKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleQuoteClick();
    }
  };

  const handleForward = () => {
    window.dispatchEvent(new CustomEvent('zerochat:forward-message', {
      detail: {
        messageId: message.id,
        chatId: message.chatId,
        content: message.content,
        attachments: message.attachments,
        senderName: displayName,
        senderId: message.senderId,
        metadata: message.metadata,
      }
    }));
  };

  // Swipe gesture for mobile
  const { swipeState, handlers: swipeHandlers } = useSwipeGesture({
    onSwipeLeft: isMobile ? handleReply : undefined,
    onSwipeRight: isMobile ? handleForward : undefined,
    threshold: 100,
  });

  const handleReact = async (emoji: string) => {
    if (!message) return;
    try {
      const existingReaction = message.reactions?.some(r => r.userId === user?.id && r.emoji === emoji);
      const add = !existingReaction;
      await reactToMessage(message.id, message.chatId, emoji, add);
    } catch (error) {
      console.error('[MessageBubble] Failed to react to message:', error);
    }
  };

  const canEdit = useMemo(() => {
    if (!user || message.senderId !== user.id) return false;
    const messageTime = new Date(message.createdAt).getTime();
    const now = Date.now();
    const hoursDiff = (now - messageTime) / (1000 * 60 * 60);
    return hoursDiff < 24;
  }, [user, message.senderId, message.createdAt]);

  // Группируем реакции для отображения
  const groupedReactions = useMemo(() => {
    if (!message.reactions || message.reactions.length === 0) {
      return new Map<string, { count: number; users: string[] }>();
    }
    const map = new Map<string, { count: number; users: string[] }>();
    for (const r of message.reactions) {
      const existing = map.get(r.emoji);
      if (existing) {
        map.set(r.emoji, { count: existing.count + 1, users: [...existing.users, r.userId] });
      } else {
        map.set(r.emoji, { count: 1, users: [r.userId] });
      }
    }
    return map;
  }, [message.reactions]);

  useEffect(() => {
    if (message.attachments && message.attachments.length > 0) {
      fileLogger.logMessageDisplayed(message.id, message.attachments.length);
    }
  }, [message.id, message.attachments]);

  // ===== SYSTEM MESSAGE =====
  if (message.type === 'SYSTEM') {
    const systemName = 'ZeroChat';
    return (
      <div
        className={cn(
          'w-full',
          highlighted && 'bg-primary/10 transition-colors duration-500'
        )}
      >
        <div
          className={cn(
            'flex w-full mb-2 items-end justify-start',
            shouldAnimate && 'animate-message'
          )}
        >
          {showAvatar && (
            <div className="flex-shrink-0 mr-2 w-8">
              <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center">
                <span className="text-xs font-medium">{systemName.charAt(0).toUpperCase()}</span>
              </div>
            </div>
          )}

          <div className="flex flex-col items-start">
            {showName && (
              <span className="text-xs text-muted-foreground mb-0.5 ml-1">{systemName}</span>
            )}

            <div className="relative">
              <ContextMenu>
                <ContextMenuTrigger>
                  <div
                    className={cn(
                      'chat-bubble cursor-context-menu',
                      'w-fit break-words',
                      isMobile ? 'max-w-[85vw]' : 'max-w-md',
                      'px-2 py-1',
                      'pr-14 pb-1',
                      'chat-bubble-other'
                    )}
                  >
                    <p className="whitespace-pre-wrap">
                      {message.content || '(системное уведомление)'}
                    </p>

                    <div className="absolute bottom-1 right-2 flex items-center gap-1 text-[10px] text-muted-foreground select-none">
                      <span>{formatTime(message.createdAt)}</span>
                    </div>
                  </div>
                </ContextMenuTrigger>

                {/* Reactions Panel Above Context Menu - only existing reactions, no picker */}
                {groupedReactions.size > 0 && (
                  <div className="p-2 rounded-lg bg-muted/50 border mb-2 z-50">
                    <div className="flex items-center gap-1 flex-wrap">
                      {Array.from(groupedReactions).map(([emoji, data]) => (
                        <button
                          key={emoji}
                          type="button"
                          onClick={() => handleReact(emoji)}
                          className={cn(
                            'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs border transition-colors',
                            'hover:bg-muted/80',
                            data.users.includes(user?.id || '')
                              ? 'bg-primary/10 border-primary'
                              : 'bg-background border-muted-foreground/20'
                          )}
                          title={data.users.map(uid => participantNames.get(uid) || uid).join(', ')}
                        >
                          <span>{emoji}</span>
                          <span className="text-[10px] text-muted-foreground">{data.count}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <ContextMenuContent className="p-0 bg-transparent border-none shadow-none">
                  {/* Модуль реакций — отдельная карточка */}
                  <div className="bg-popover rounded-lg p-2 mb-2 shadow-sm">
                    <div className="flex items-center gap-1 flex-wrap">
                      {QUICK_REACTIONS_FOR_MENU.map((emoji) => {
                        const isActive = message.reactions?.some(r => r.userId === user?.id && r.emoji === emoji);
                        return (
                          <button
                            key={emoji}
                            type="button"
                            onClick={() => handleReact(emoji)}
                            className={cn(
                              'inline-flex items-center justify-center',
                              isMobile ? 'w-10 h-10' : 'w-8 h-8',
                              'rounded-md text-lg',
                              'hover:bg-muted transition-colors',
                              isActive ? 'bg-primary/20 ring-1 ring-primary' : ''
                            )}
                            title={emoji}
                          >
                            {emoji}
                          </button>
                        );
                      })}
                      <div onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
                        <Popover.Root>
                          <Popover.Trigger asChild>
                            <button
                              type="button"
                              className="inline-flex items-center justify-center ml-1 w-8 h-8 rounded-md text-sm hover:bg-muted transition-colors"
                              title="Ещё реакции"
                            >
                              <ChevronDown className="w-4 h-4" />
                            </button>
                          </Popover.Trigger>
                          <Popover.Portal>
                            <Popover.Content
                              className="z-50 p-2 rounded-lg shadow-lg border bg-popover animate-in fade-in-0 zoom-in-95"
                              align="center"
                              side="bottom"
                              sideOffset={5}
                              collisionPadding={8}
                            >
                              <div className="flex flex-wrap gap-1 max-w-[280px]">
                                {QUICK_REACTIONS.map((emoji) => {
                                  const isActive = message.reactions?.some(r => r.userId === user?.id && r.emoji === emoji);
                                  return (
                                    <button
                                      key={emoji}
                                      type="button"
                                      onClick={() => handleReact(emoji)}
                                      className={cn(
                                        'inline-flex items-center justify-center',
                                        'w-8 h-8 rounded-md text-lg',
                                        'transition-all hover:scale-125',
                                        isActive ? 'bg-primary/20 ring-1 ring-primary' : 'hover:bg-muted'
                                      )}
                                      title={emoji}
                                    >
                                      {emoji}
                                    </button>
                                  );
                                })}
                              </div>
                            </Popover.Content>
                          </Popover.Portal>
                        </Popover.Root>
                      </div>
                    </div>
                  </div>

                  {/* Основное меню — отдельная карточка с верхней границей */}
                  <div className="bg-popover rounded-lg shadow-sm">
                    <ContextMenuItem onClick={handleReply} className={isMobile ? 'h-11' : ''}>
                      <Reply className={isMobile ? 'w-5 h-5 mr-2' : 'w-4 h-4 mr-2'} />
                      Ответить
                    </ContextMenuItem>
                    <ContextMenuItem onClick={handleForward} className={isMobile ? 'h-11' : ''}>
                      <Forward className={isMobile ? 'w-5 h-5 mr-2' : 'w-4 h-4 mr-2'} />
                      Переслать
                    </ContextMenuItem>
                    <ContextMenuItem onClick={handleCopy} className={isMobile ? 'h-11' : ''}>
                      <Copy className={isMobile ? 'w-5 h-5 mr-2' : 'w-4 h-4 mr-2'} />
                      Копировать
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem onClick={handlePin} className={isMobile ? 'h-11' : ''}>
                      <Pin className={isMobile ? 'w-5 h-5 mr-2' : 'w-4 h-4 mr-2'} />
                      {message.isPinned ? 'Открепить' : 'Закрепить'}
                    </ContextMenuItem>
                    {canEdit && (
                      <ContextMenuItem onClick={handleEdit} className={isMobile ? 'h-11' : ''}>
                        <Edit className={isMobile ? 'w-5 h-5 mr-2' : 'w-4 h-4 mr-2'} />
                        Редактировать
                      </ContextMenuItem>
                    )}
                    {isOwn && (
                      <>
                        <ContextMenuSeparator />
                        <ContextMenuItem onClick={handleDelete} className={`text-destructive ${isMobile ? 'h-11' : ''}`}>
                          <Trash2 className={isMobile ? 'w-5 h-5 mr-2' : 'w-4 h-4 mr-2'} />
                          Удалить
                        </ContextMenuItem>
                      </>
                    )}
                  </div>
                </ContextMenuContent>
              </ContextMenu>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ===== REGULAR MESSAGE =====
  return (
    <div
      className={cn(
        'w-full',
        highlighted && 'bg-primary/10 transition-colors duration-500'
      )}
      {...(isMobile ? { ...swipeHandlers, ...longPressHandlers } : {})}
    >
      <div
        className={cn(
          'flex w-full mb-2 items-end',
          isOwn ? 'justify-end' : 'justify-start',
          shouldAnimate && 'animate-message'
        )}
      >
         {/* Avatar / placeholder area */}
         {!isOwn && (showAvatar || alignWithAvatar) && (
           <div className="flex-shrink-0 mr-2 w-8">
             {showAvatar ? (
               <button
                 type="button"
                 onClick={() => onOpenContactCard?.(message.senderId)}
                 className={cn(
                   "w-8 h-8 rounded-full overflow-hidden p-0 border-0 bg-transparent cursor-pointer",
                   onOpenContactCard && "hover:ring-2 hover:ring-primary/50 transition-all"
                 )}
                 title={`Открыть профиль ${displayName}`}
               >
                 {avatar ? (
                   <img src={avatar} alt={displayName} className="w-full h-full object-cover" />
                 ) : (
                   <div className="w-full h-full rounded-full bg-muted flex items-center justify-center">
                     <span className="text-xs font-medium">
                       {displayName?.charAt(0).toUpperCase() || '?'}
                     </span>
                   </div>
                 )}
               </button>
             ) : (
               <div className="w-8 h-8 invisible" />
             )}
           </div>
         )}

        <div className={cn('flex flex-col', isOwn ? 'items-end' : 'items-start')}>
          {/* Bubble */}
          <div className="relative">
            <ContextMenu>
              <ContextMenuTrigger>
                <div
                  className={cn(
                    'chat-bubble cursor-context-menu',
                    'w-fit break-words',
                    isMobile ? 'max-w-[85vw]' : 'max-w-md',
                    'px-2 py-1',
                    'pr-14 pb-1',
                    isOwn ? 'chat-bubble-own' : 'chat-bubble-other'
                  )}
                >
                  {/* Имя отправителя внутри бабла (только для чужих) */}
                  {!isOwn && showName && displayName && (
                    <button
                      type="button"
                      onClick={() => onOpenContactCard?.(message.senderId)}
                      className={cn(
                        "text-xs font-semibold text-primary mb-1 text-left hover:underline",
                        onOpenContactCard && "cursor-pointer"
                      )}
                      title={`Открыть профиль ${displayName}`}
                    >
                      {displayName}
                    </button>
                  )}

                  {/* Forward indicator - only show if original sender is different from current sender */}
                  {message.metadata?.forwardedFrom?.senderId && message.metadata.forwardedFrom.senderId !== message.senderId && (
                    <div className={cn("flex items-center gap-1 text-xs mb-1", isOwn ? "text-primary-foreground/80" : "text-foreground/80")}>
                      <Forward className="w-3 h-3" />
                      <span>Переслано от</span>
                      <span className="font-medium text-inherit">
                        {originalAuthorName}
                      </span>
                    </div>
                  )}

                  {/* Reply quote */}
                  {replyToMessage && (
                    <QuotePreview
                      message={replyToMessage}
                      isOwn={isOwn}
                      decryptedData={decryptedData}
                      decryptingAttachments={decryptingAttachments}
                      decryptErrors={decryptErrors}
                      onClick={handleQuoteClick}
                      onKeyDown={handleQuoteKeyDown}
                    />
                  )}

                  {/* Attachments */}
                  {message.attachments && message.attachments.length > 0 && (
                    <MessageAttachments
                      attachments={message.attachments}
                      decryptedData={decryptedData}
                      decryptingAttachments={decryptingAttachments}
                      decryptErrors={decryptErrors}
                      onImageClick={onImageClick}
                    />
                  )}

                  {/* Text content (caption) — inline edit mode or display */}
                  {isEditing ? (
                    <div className="flex flex-col gap-2">
                      <textarea
                        value={editContent}
                        onChange={(e) => setEditContent(e.target.value)}
                        className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary"
                        rows={3}
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void handleSaveEdit(); }
                          if (e.key === 'Escape') handleCancelEdit();
                        }}
                      />
                      <div className="flex gap-2 justify-end">
                        <Button variant="ghost" size="sm" onClick={handleCancelEdit}>Отмена</Button>
                        <Button variant="default" size="sm" onClick={() => void handleSaveEdit()}>Сохранить</Button>
                      </div>
                    </div>
                  ) : message.content ? (
                    <p className={cn('whitespace-pre-wrap break-words', message.attachments?.length ? 'mt-2' : '')}>
                      {message.content}
                    </p>
                  ) : message.type === 'TEXT' && !message.attachments?.length ? (
                    <p className={cn('whitespace-pre-wrap break-words text-muted-foreground italic', message.attachments?.length ? 'mt-2' : '')}>
                      (пустое сообщение)
                    </p>
                  ) : null}

                  {/* Delete confirmation dialog (inline) */}
                  {isDeleting && (
                    <div className="mt-2 p-3 rounded-md border border-red-500/30 bg-red-500/10">
                      <p className="text-sm font-medium mb-2">Удалить сообщение?</p>
                      {isOwn && (
                        <label className="flex items-center gap-2 text-sm mb-2">
                          <input
                            type="checkbox"
                            checked={deleteForEveryone}
                            onChange={(e) => setDeleteForEveryone(e.target.checked)}
                          />
                          Удалить для всех
                        </label>
                      )}
                      <div className="flex gap-2 justify-end">
                        <Button variant="ghost" size="sm" onClick={() => setIsDeleting(false)}>Отмена</Button>
                        <Button variant="destructive" size="sm" onClick={() => void handleConfirmDelete()}>Удалить</Button>
                      </div>
                    </div>
                  )}

                  {/* Legacy type indicator */}
                  {message.type !== 'TEXT' && (!message.attachments || message.attachments.length === 0) && !message.content && (
                    <p className="italic text-muted-foreground">[Вложение: {message.type}]</p>
                  )}

                  {/* Метаданные (время, пин, статус, редактирование) */}
                  <div className={cn("absolute bottom-1 right-2 flex items-center gap-1 text-[10px] select-none", isOwn ? "text-primary-foreground/70" : "text-foreground/70")}>
                    <span>{formatTime(message.createdAt)}</span>
                    {message.isPinned && <Pin className="w-3 h-3" />}
                    {isOwn && message.status && (
                      (() => {
                        // U7: normalize status (handles both 'SENT' and 'sent' etc.)
                        const normalized = normalizeMessageStatus(message.status);
                        return (
                          <span
                            className={cn(
                              normalized === 'read' ? 'text-primary' : 'text-muted-foreground'
                            )}
                          >
                            {normalized === 'sending' && '○'}
                            {normalized === 'sent' && '✓'}
                            {normalized === 'delivered' && '✓✓'}
                            {normalized === 'read' && '✓✓'}
                            {normalized === 'failed' && '✗'}
                          </span>
                        );
                      })()
                    )}
                    {message.isEdited && <span>(изменено)</span>}
                  </div>
                </div>
              </ContextMenuTrigger>

              <ContextMenuContent className="p-0 bg-transparent border-none shadow-none">
                {/* Модуль реакций — отдельная карточка */}
                <div className="bg-popover rounded-lg p-2 mb-2 shadow-sm">
                  <div className="flex items-center gap-1 flex-wrap">
                    {QUICK_REACTIONS_FOR_MENU.map((emoji) => {
                      const isActive = message.reactions?.some(r => r.userId === user?.id && r.emoji === emoji);
                      return (
                        <button
                          key={emoji}
                          type="button"
                          onClick={() => handleReact(emoji)}
                          className={cn(
                            'inline-flex items-center justify-center',
                            'w-8 h-8 rounded-md text-lg',
                            'hover:bg-muted transition-colors',
                            isActive ? 'bg-primary/20 ring-1 ring-primary' : ''
                          )}
                          title={emoji}
                        >
                          {emoji}
                        </button>
                      );
                    })}
                    <div onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
                      <Popover.Root>
                        <Popover.Trigger asChild>
                          <button
                            type="button"
                            className="inline-flex items-center justify-center ml-1 w-8 h-8 rounded-md text-sm hover:bg-muted transition-colors"
                            title="Ещё реакции"
                          >
                            <ChevronDown className="w-4 h-4" />
                          </button>
                        </Popover.Trigger>
                        <Popover.Portal>
                          <Popover.Content
                            className="z-50 p-2 rounded-lg shadow-lg border bg-popover animate-in fade-in-0 zoom-in-95"
                            align="center"
                            side="bottom"
                            sideOffset={5}
                            collisionPadding={8}
                          >
                            <div className="flex flex-wrap gap-1 max-w-[280px]">
                              {QUICK_REACTIONS.map((emoji) => {
                                const isActive = message.reactions?.some(r => r.userId === user?.id && r.emoji === emoji);
                                return (
                                  <button
                                    key={emoji}
                                    type="button"
                                    onClick={() => handleReact(emoji)}
                                    className={cn(
                                      'inline-flex items-center justify-center',
                                      'w-8 h-8 rounded-md text-lg',
                                      'transition-all hover:scale-125',
                                      isActive ? 'bg-primary/20 ring-1 ring-primary' : 'hover:bg-muted'
                                    )}
                                    title={emoji}
                                  >
                                    {emoji}
                                  </button>
                                );
                              })}
                            </div>
                          </Popover.Content>
                        </Popover.Portal>
                      </Popover.Root>
                    </div>
                  </div>
                </div>

                {/* Основное меню — отдельная карточка с верхней границей */}
                <div className="bg-popover rounded-lg shadow-sm border-t border-border">
                  <ContextMenuItem onClick={handleReply}>
                    <Reply className="w-4 h-4 mr-2" />
                    Ответить
                  </ContextMenuItem>
                  <ContextMenuItem onClick={handleForward}>
                    <Forward className="w-4 h-4 mr-2" />
                    Переслать
                  </ContextMenuItem>
                  <ContextMenuItem onClick={handleCopy}>
                    <Copy className="w-4 h-4 mr-2" />
                    Копировать
                  </ContextMenuItem>
                  <ContextMenuItem onClick={handlePin}>
                    <Pin className="w-4 h-4 mr-2" />
                    {message.isPinned ? 'Открепить' : 'Закрепить'}
                  </ContextMenuItem>
                  {canEdit && (
                    <ContextMenuItem onClick={handleEdit}>
                      <Edit className="w-4 h-4 mr-2" />
                      Редактировать
                    </ContextMenuItem>
                  )}
                  {isOwn && (
                    <>
                      <ContextMenuSeparator />
                      <ContextMenuItem onClick={handleDelete} className="text-destructive">
                        <Trash2 className="w-4 h-4 mr-2" />
                        Удалить
                      </ContextMenuItem>
                    </>
                  )}
                </div>
              </ContextMenuContent>
            </ContextMenu>
          </div>

              {/* Reactions under message - always visible when there are reactions */}
              {groupedReactions.size > 0 && (
                <div className="flex items-center gap-1 mt-1 select-none">
                  {Array.from(groupedReactions).map(([emoji, data]) => (
                    <button
                      key={emoji}
                      type="button"
                      onClick={() => handleReact(emoji)}
                      className={cn(
                        'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs border transition-colors',
                        'hover:bg-muted/80',
                        data.users.includes(user?.id || '')
                          ? 'bg-primary/10 border-primary'
                          : 'bg-muted border-muted-foreground/20'
                      )}
                       title={data.users.map(uid => participantNames.get(uid) || uid).join(', ')}
                    >
                      <span>{emoji}</span>
                      <span className="text-[10px] text-muted-foreground">{data.count}</span>
                    </button>
                  ))}
                </div>
              )}
        </div>
      </div>
    </div>
  );
});

