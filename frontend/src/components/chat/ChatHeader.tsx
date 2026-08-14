import { Archive, ArrowLeft, Bell, BellOff, Download, Info, LogOut, MoreVertical, Pencil, Phone, Pin, Search, Shield, Star, Trash2, Video } from 'lucide-react';
import { useState, type Dispatch, type SetStateAction } from 'react';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useCall } from '@/contexts/CallContext';
import { useChat } from '@/contexts';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn, pluralize } from '@/lib/utils';
import { toast } from '@/components/ui/toast';
import type { Chat, GroupInfo, User } from '@/types';

import { GroupEditDialog } from './GroupEditDialog';

interface ChatHeaderProps {
  chat: Chat;
  currentUser: User;
  onOpenContactCard?: (userId: string) => void;
  onOpenDeleteDialog?: (chatId: string) => void;
  onBack?: () => void;
  // For real-time status updates from context
}

// Typing indicator with shimmer animation
function TypingIndicator() {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="relative overflow-hidden">
        <span className="inline">печатает</span>
        <span 
          className="absolute inset-0 -translate-x-full animate-[shimmer_1.5s_infinite] bg-gradient-to-r from-transparent via-white/20 to-transparent"
          style={{ width: '100%' }}
        />
      </span>
      <span className="inline-flex gap-0.5">
        <span className="w-1 h-1 rounded-full bg-current animate-bounce" style={{ animationDelay: '0ms' }} />
        <span className="w-1 h-1 rounded-full bg-current animate-bounce" style={{ animationDelay: '150ms' }} />
        <span className="w-1 h-1 rounded-full bg-current animate-bounce" style={{ animationDelay: '300ms' }} />
      </span>
    </span>
  );
}

export function ChatHeader({ chat, currentUser, onOpenContactCard, onOpenDeleteDialog, onBack }: ChatHeaderProps) {
  // Get all context values at the top - hooks must be called before any conditional returns
  const { getTypingUsers, chats: contextChats, clearChat, exportChat, muteChat, unmuteChat, archiveChat, unarchiveChat, deleteChat, leaveChat } = useChat();
  const isMobile = useIsMobile();
  // Delete dialog state removed - now managed by ChatLayout

  // P0-9: AlertDialog state — replaces native confirm() for clear-chat / leave-group.
  // Declared before any early return so the hook order is stable across all
  // render branches (favorites / system / main chat header).
  const [confirmDialog, setConfirmDialog] = useState<{
    open: boolean;
    title: string;
    description: string;
    onConfirm: () => void | Promise<void>;
  }>({ open: false, title: '', description: '', onConfirm: () => {} });

  const handleClearChat = async () => {
    if (!chat) return;
    try {
      await clearChat(chat.id);
    } catch (error) {
      console.error('Clear chat failed:', error);
      toast.error('Не удалось очистить чат', error instanceof Error ? error.message : undefined);
    }
  };

  const handleExportChat = async () => {
    if (!chat) return;
    try {
      const blob = await exportChat(chat.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `chat-${chat.id}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Export chat failed:', error);
    }
  };

  // Delete handler removed - now handled by DeleteChatDialog in ChatLayout

  // Handle favorites chat specially
  if (chat.type === 'favorites') {
    return (
      <>
      <header className="h-14 border-b flex items-center justify-between px-4 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        {/* Левая часть: кнопка назад (мобильные) + аватар и информация */}
        <div className="flex items-center gap-3">
          {isMobile && onBack && (
            <Button
              variant="ghost"
              size="default"
              onClick={onBack}
              className="text-muted-foreground p-2"
            >
              <ArrowLeft className="h-6 w-6" />
            </Button>
          )}
          <div className="h-10 w-10 rounded-full bg-yellow-500/10 flex items-center justify-center">
            <Star className="h-5 w-5 text-yellow-600" />
          </div>

          <div className="flex flex-col">
            <span className="font-medium text-sm">Избранное</span>
            <span className="text-xs text-muted-foreground">
              Сохраненные сообщения
            </span>
          </div>
        </div>

        {/* Правая часть: действия */}
        <div className="flex items-center gap-1">
          {/* Кнопка поиска */}
          <Button variant="ghost" size="icon" className="text-muted-foreground">
            <Search className="h-5 w-5" />
          </Button>

          {/* Меню действий - упрощенное для избранного */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="text-muted-foreground">
                <MoreVertical className="h-5 w-5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem>
                <Info className="w-4 h-4 mr-2" />
                Информация
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setConfirmDialog({
                open: true,
                title: 'Очистить историю?',
                description: 'Очистить всю историю чата? Это действие необратимо.',
                onConfirm: () => { void handleClearChat(); },
              })}>
                <Trash2 className="w-4 h-4 mr-2" />
                Очистить историю
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => onOpenDeleteDialog?.(chat.id)}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="w-4 h-4 mr-2" />
                Удалить чат
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          
        </div>
      </header>
      <ConfirmAlertDialog
        confirmDialog={confirmDialog}
        setConfirmDialog={setConfirmDialog}
      />
    </>
  );
}
  
  // Handle system chat specially
  if (chat.isSystem) {
    return (
      <>
      <header className="h-14 border-b flex items-center justify-between px-4 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        {/* Левая часть: кнопка назад (мобильные) + аватар и информация */}
        <div className="flex items-center gap-3">
          {isMobile && onBack && (
            <Button
              variant="ghost"
              size="default"
              onClick={onBack}
              className="text-muted-foreground p-2"
            >
              <ArrowLeft className="h-6 w-6" />
            </Button>
          )}
          <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center">
            <Bell className="h-5 w-5 text-primary" />
          </div>

          <div className="flex flex-col">
            <span className="font-medium text-sm">ZeroChat</span>
            <span className="text-xs text-muted-foreground">
              Системные уведомления
            </span>
          </div>
        </div>

        {/* Правая часть: действия */}
        <div className="flex items-center gap-1">
          {/* Меню действий */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="text-muted-foreground">
                <MoreVertical className="h-5 w-5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem>
                <Info className="w-4 h-4 mr-2" />
                Информация о чате
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setConfirmDialog({
                open: true,
                title: 'Очистить историю?',
                description: 'Очистить всю историю чата? Это действие необратимо.',
                onConfirm: () => { void handleClearChat(); },
              })}>
                <Trash2 className="w-4 h-4 mr-2" />
                Очистить историю
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      <ConfirmAlertDialog
        confirmDialog={confirmDialog}
        setConfirmDialog={setConfirmDialog}
      />
    </>
    );
  }

  // Получаем собеседника (для личных чатов)
  // After F5, participants may only contain otherParticipant (without current user)
  // So we try to find other participant, or fall back to first participant, or use chat.name
  const otherParticipantBase = chat.type === 'private' 
    ? (chat.participants.find(p => p.id !== currentUser.id) || chat.participants[0])
    : null;
  
  // Get real-time status from context
  const contextChat = contextChats.find(c => c.id === chat.id);
  const otherParticipantFromContext = contextChat?.participants.find(p => p.id !== currentUser.id);
  
  // Merge: use base participant but override with context status
  const otherParticipant = otherParticipantBase && otherParticipantFromContext
    ? { ...otherParticipantBase, status: otherParticipantFromContext.status, lastSeen: otherParticipantFromContext.lastSeen }
    : otherParticipantBase;

   // Get typing users for this chat
   const typingUsers = getTypingUsers(chat.id);
   const isOtherParticipantTyping = otherParticipant && typingUsers.some(u => u.userId === otherParticipant.id);

   // Формат статуса
   const formatStatus = (user: User) => {
    if (user.status === 'online') {
      return 'онлайн';
    } else if (user.lastSeen) {
      const date = new Date(user.lastSeen);
      const now = new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMs / 3600000);
      const diffDays = Math.floor(diffMs / 86400000);

      if (diffMins < 1) return 'был(а) в сети только что';
      if (diffMins < 60) return `был(а) в сети ${diffMins} мин. назад`;
      if (diffHours < 24) return `был(а) в сети в ${date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
      if (diffDays < 7) return `был(а) в сети ${diffDays} дн. назад`;
      return `был(а) в сети ${date.toLocaleDateString('ru-RU')}`;
    }
    return 'офлайн';
  };

  // Get status text - show typing indicator instead of status if someone is typing
  const getStatusText = () => {
    if (chat.type === 'group') {
      // For group chats, show participant count with proper pluralization (U6)
      return `${chat.participants.length} ${pluralize(chat.participants.length, ['участник', 'участника', 'участников'])}`;
    }
    if (chat.type === 'private' && otherParticipant) {
      if (isOtherParticipantTyping) {
        return <TypingIndicator />;
      }
      // If user is typing, they are effectively online
      // This handles the case when presence hasn't updated yet
      return formatStatus(otherParticipant);
    }
    return null;
  };
  
  // Note: isUserOnline and showInfoButton were previously computed but not used in current UI
  void otherParticipant;

  // Call functionality
  const { startCall } = useCall();
  const canCall = chat.type === 'private' && otherParticipant;

  const handleVoiceCall = () => {
    if (!canCall || !otherParticipant) return;
    startCall(otherParticipant.id, otherParticipant.displayName || otherParticipant.username, 'audio', chat.id);
  };

  const handleVideoCall = () => {
    if (!canCall || !otherParticipant) return;
    startCall(otherParticipant.id, otherParticipant.displayName || otherParticipant.username, 'video', chat.id);
  };

  // Command Bus integration - commandBus already declared at top

  const handleMute = async () => {
    if (!chat) return;
    if (chat.isMuted) {
      await unmuteChat(chat.id);
    } else {
      // Mute for 24 hours (timestamp in milliseconds)
      await muteChat(chat.id, Date.now() + 3600000 * 24);
    }
  };

  const handleArchive = async () => {
    if (!chat) return;
    if (chat.isArchived) {
      await unarchiveChat(chat.id);
    } else {
      await archiveChat(chat.id);
    }
  };

  const handleLeave = async () => {
    if (!chat) return;
    try {
      await leaveChat(chat.id);
    } catch (err) {
      console.error('[ChatHeader] leaveChat failed:', err);
      toast.error('Не удалось покинуть чат', err instanceof Error ? err.message : undefined);
    }
  };

  const [editDialogOpen, setEditDialogOpen] = useState(false);

  // Build a minimal GroupInfo from the Chat object for the dialog's
  // initial state. The dialog dispatches `chat.update` and applies an
  // optimistic update; the canonical GroupInfo will be re-fetched by
  // GroupChatInfo when its panel is opened.
  const groupInfoForEdit: GroupInfo | null = chat.isGroup
    ? {
        id: chat.id,
        name: chat.name || '',
        avatar: chat.avatar,
        description: chat.description ?? null,
        isGroup: true,
        requireApproval: chat.requireApproval ?? false,
        historyAccess: chat.historyAccess ?? 'ALL',
        createdBy: {
          id: chat.createdById || '',
          username: chat.participants.find(p => p.id === chat.createdById)?.username || '',
        },
        inviteCode: chat.inviteCode,
        inviteCodeExpiresAt: chat.inviteCodeExpiresAt,
        participants: chat.participants.map(p => ({
          userId: p.id,
          username: p.username,
          displayName: p.displayName,
          avatar: p.avatar,
          role: (p as { role?: 'OWNER' | 'ADMIN' | 'MODERATOR' | 'MEMBER' }).role ?? 'MEMBER',
          joinedAt: (p as { joinedAt?: string }).joinedAt ?? new Date().toISOString(),
        })),
      }
    : null;

    const handleUpdate = () => {
      if (!chat.isGroup) return;
      setEditDialogOpen(true);
    };
  
    // Handle header click - open contact card for private chats
    const handleHeaderClick = () => {
      if (chat.type === 'private' && otherParticipant && onOpenContactCard) {
        onOpenContactCard(otherParticipant.id);
      }
    };
  
    return (
      <>
        <header
          className={cn(
            "h-14 border-b flex items-center justify-between px-4 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60",
            !isMobile && "cursor-pointer"
          )}
          onClick={isMobile ? undefined : handleHeaderClick}
        >
      {/* Левая часть: кнопка назад (мобильные) + аватар и информация */}
      <div className="flex items-center gap-3">
        {isMobile && onBack && (
          <Button
            variant="ghost"
            size="default"
            onClick={() => {
              onBack();
            }}
            className="text-muted-foreground p-2"
          >
            <ArrowLeft className="h-6 w-6" />
          </Button>
        )}
        <Avatar className="h-10 w-10">
          {chat.avatar ? (
            <AvatarImage src={chat.avatar} alt={chat.name} />
          ) : (
            <AvatarFallback>
              {chat.type === 'group' ? (
                <span className="text-sm font-medium">
                  {chat.name?.charAt(0).toUpperCase() || 'G'}
                </span>
              ) : (
                <span className="text-sm font-medium">
                  {otherParticipant?.username?.charAt(0).toUpperCase() || '?'}
                </span>
              )}
            </AvatarFallback>
          )}
        </Avatar>

         <div className="flex flex-col">
           <span className="font-medium text-sm flex items-center gap-1">
             {chat.type === 'group' 
               ? chat.name 
               : otherParticipant?.displayName || otherParticipant?.username || 'Неизвестный'}
             {chat.isPinned && (
               <Pin className="w-3 h-3 text-primary" />
             )}
           </span>
           {chat.type === 'private' && (
             <span className={`text-xs ${isOtherParticipantTyping ? 'text-primary font-medium' : 'text-muted-foreground'}`}>
               {getStatusText()}
             </span>
           )}
           {chat.isMuted && (
             <span className="text-xs text-muted-foreground flex items-center gap-1">
               <BellOff className="w-3 h-3" />
               {chat.mutedUntil ? `Замущен до ${new Date(chat.mutedUntil).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}` : 'Замущен'}
             </span>
           )}
           {chat.isArchived && (
             <span className="text-xs text-muted-foreground italic">
               (архивирован)
             </span>
           )}
         </div>
      </div>

       {/* Правая часть: действия */}
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          {/* Call buttons — desktop: separate buttons, mobile: in dropdown */}
          {canCall && !isMobile && (
            <>
              <Button variant="ghost" size="icon" className="text-muted-foreground" onClick={handleVoiceCall} title="Голосовой звонок">
                <Phone className="h-5 w-5" />
              </Button>
              <Button variant="ghost" size="icon" className="text-muted-foreground" onClick={handleVideoCall} title="Видеозвонок">
                <Video className="h-5 w-5" />
              </Button>
            </>
          )}

          {/* Кнопка поиска (заглушка) */}
          <Button variant="ghost" size="icon" className="text-muted-foreground">
            <Search className="h-5 w-5" />
          </Button>

          {/* Меню действий */}
          <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="text-muted-foreground">
              <MoreVertical className="h-5 w-5" />
            </Button>
          </DropdownMenuTrigger>
           <DropdownMenuContent align="end">
            {/* Call options — mobile dropdown */}
            {canCall && isMobile && (
              <>
                <DropdownMenuItem onClick={handleVoiceCall}>
                  <Phone className="w-4 h-4 mr-2" />
                  Голосовой звонок
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleVideoCall}>
                  <Video className="w-4 h-4 mr-2" />
                  Видеозвонок
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuItem onClick={handleMute}>
              <BellOff className="w-4 h-4 mr-2" />
              {chat.isMuted ? 'Размутить' : 'Замутить'}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleArchive}>
              <Archive className="w-4 h-4 mr-2" />
              {chat.isArchived ? 'Разархивировать' : 'Архивировать'}
            </DropdownMenuItem>
            {chat.type === 'group' && (
              <>
                <DropdownMenuItem onClick={handleUpdate}>
                  <Pencil className="w-4 h-4 mr-2" />
                  Редактировать группу
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setConfirmDialog({
                  open: true,
                  title: 'Покинуть группу?',
                  description: 'Вы уверены, что хотите покинуть эту группу?',
                  onConfirm: () => { void handleLeave(); },
                })} className="text-orange-500">
                  <LogOut className="w-4 h-4 mr-2" />
                  Покинуть группу
                </DropdownMenuItem>
              </>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setConfirmDialog({
              open: true,
              title: 'Очистить историю?',
              description: 'Очистить всю историю чата? Это действие необратимо.',
              onConfirm: () => { void handleClearChat(); },
            })}>
              <Trash2 className="w-4 h-4 mr-2" />
              Очистить историю
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleExportChat}>
              <Download className="w-4 h-4 mr-2" />
              Экспортировать чат
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onOpenDeleteDialog?.(chat.id)} className="text-destructive">
              <Trash2 className="w-4 h-4 mr-2" />
              Удалить чат
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

      </div>
    </header>

      {/* Group edit dialog — opened from the "Редактировать группу" dropdown item */}
      {groupInfoForEdit && (
        <GroupEditDialog
          open={editDialogOpen}
          onOpenChange={setEditDialogOpen}
          chatId={chat.id}
          groupInfo={groupInfoForEdit}
        />
      )}
      <ConfirmAlertDialog
        confirmDialog={confirmDialog}
        setConfirmDialog={setConfirmDialog}
      />
      </>
    );
  }

// Helper component that renders the shared AlertDialog instance. Rendered
// at the bottom of every ChatHeader return path (favorites / system / main)
// so the dialog can be triggered from any branch.
function ConfirmAlertDialog({
  confirmDialog,
  setConfirmDialog,
}: {
  confirmDialog: { open: boolean; title: string; description: string; onConfirm: () => void | Promise<void> };
  setConfirmDialog: Dispatch<SetStateAction<{ open: boolean; title: string; description: string; onConfirm: () => void | Promise<void> }>>;
}) {
  return (
    <AlertDialog
      open={confirmDialog.open}
      onOpenChange={(open) => setConfirmDialog(prev => ({ ...prev, open }))}
    >
      <AlertDialogContent>
        <AlertDialogTitle>{confirmDialog.title}</AlertDialogTitle>
        <AlertDialogDescription>{confirmDialog.description}</AlertDialogDescription>
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2 mt-4">
          <AlertDialogCancel>Отмена</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              const fn = confirmDialog.onConfirm;
              setConfirmDialog(prev => ({ ...prev, open: false }));
              void fn();
            }}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            Подтвердить
          </AlertDialogAction>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
