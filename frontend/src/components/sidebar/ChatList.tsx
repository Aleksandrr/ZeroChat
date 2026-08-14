import { useNavigate } from '@tanstack/react-router';
import { Archive, Bell, MessageCircle, Pin, Search, VolumeOff } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth,useChat } from '@/contexts';
import { useIsMobile } from '@/hooks/use-mobile';
import { usePullToRefresh } from '@/hooks/usePullToRefresh';
import { getAllFolders, type StoredFolder } from '@/lib/messages/db';
import { cn } from '@/lib/utils';
import { useChats } from '@/queries';
import { useFolderStore, useUnreadCount, useUnreadStore } from '@/stores';
import { MobileFolderTabs, computeFolderSwipe } from './MobileFolderTabs';

export function ChatList() {
  // Get chats from TanStack Query for caching/refresh
  const { data: queryChats, isLoading: queryLoading, refetch } = useChats();
  const isMobile = useIsMobile();

  // Pull-to-refresh for mobile
  const { pullState, containerRef, handlers: pullHandlers } = usePullToRefresh({
    onRefresh: async () => {
      await refetch();
    },
    threshold: 80,
  });

  // Folder filter (mobile tabs). On desktop FolderRail (another agent)
  // drives the same store; we filter the chat list here either way so the
  // shared selection is honoured in both layouts.
  const selectedFolderId = useFolderStore((s) => s.selectedFolderId);
  const selectFolder = useFolderStore((s) => s.selectFolder);
  const [folders, setFolders] = useState<StoredFolder[]>([]);

  // Load folder list for swipe-tab navigation. Only relevant on mobile,
  // but cheap to keep in sync on desktop too (single IndexedDB read).
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const list = await getAllFolders();
        if (!cancelled) setFolders(list);
      } catch (e) {
        console.error('[ChatList] folder load failed:', e);
      }
    };
    void load();
    const handler = () => void load();
    window.addEventListener('zerochat:folders-updated', handler);
    return () => {
      cancelled = true;
      window.removeEventListener('zerochat:folders-updated', handler);
    };
  }, []);

  // --- Swipe-to-switch-tab (mobile only) ---
  // Track touch start position; on touchend, if horizontal swipe dominates
  // and exceeds threshold, move to the previous/next folder tab. Coexists
  // with pull-to-refresh (which only triggers on vertical pulls from top).
  const touchStartX = useRef<number | null>(null);
  const touchStartY = useRef<number | null>(null);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    touchStartX.current = e.touches[0]?.clientX ?? null;
    touchStartY.current = e.touches[0]?.clientY ?? null;
  }, []);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (touchStartX.current === null || touchStartY.current === null) return;
    const endX = e.changedTouches[0]?.clientX ?? touchStartX.current;
    const endY = e.changedTouches[0]?.clientY ?? touchStartY.current;
    const dx = endX - touchStartX.current;
    const dy = endY - touchStartY.current;
    touchStartX.current = null;
    touchStartY.current = null;

    const next = computeFolderSwipe(dx, dy, folders, selectedFolderId);
    if (next !== undefined) selectFolder(next);
  }, [folders, selectedFolderId, selectFolder]);

  // Force refetch chats when sync completes
  useEffect(() => {
    const handleSyncComplete = () => {
      void refetch();
    };

    window.addEventListener('zerochat:sync-complete', handleSyncComplete);
    return () => window.removeEventListener('zerochat:sync-complete', handleSyncComplete);
  }, [refetch]);
  
  // Use ChatContext for active chat selection and real-time updates
  const { chats: contextChats, selectChat, activeChat, getTypingUsers } = useChat();
  const { user: currentUser } = useAuth();
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState('');
 
  // Find system chat from reactive sources (contextChats or queryChats)
  // This ensures reactivity when system chat appears
  const systemChat = useMemo(() =>
    contextChats.find(c => c.isSystem) || queryChats?.find(c => c.isSystem),
    [contextChats, queryChats]
  );
  const systemChatId = systemChat?.id || '';
  const systemUnreadCount = useUnreadCount(systemChatId);

  // Override system chat unreadCount with direct store subscription
  // This ensures immediate reactivity for system chat counter
  const baseChats = queryChats ?? contextChats;
  const chatsWithSystemOverride = useMemo(() => {
    if (!systemChatId) return baseChats;
    return baseChats.map((chat: any) =>
      chat.id === systemChatId ? { ...chat, unreadCount: systemUnreadCount } : chat
    );
  }, [baseChats, systemChatId, systemUnreadCount]);
  
  const chatsLoading = queryLoading && contextChats.length === 0;

  // Фильтрация чатов: folder filter (if any) + search filter + sort
  const filteredChats = useMemo(() => {
    // Folder filter — applied first. System chat has no folderId, so it
    // disappears when a specific folder is selected (matches Telegram's
    // default behavior for custom folders).
    let result = chatsWithSystemOverride as typeof chatsWithSystemOverride;
    if (selectedFolderId) {
      result = result.filter(chat => chat.folderId === selectedFolderId);
    }

    return result.filter(chat => {
      // Системный чат всегда показываем (если прошёл folder filter выше)
      if (chat.isSystem) return true;
      
      // Для direct чатов ищем по имени участника (не по chat.name)
      // Для групповых чатов ищем по chat.name
      const searchTarget = chat.type === 'private'
        ? chat.participants.find((p: any) => p.id !== currentUser?.id)?.username || ''
        : chat.name || '';
      
      return searchTarget.toLowerCase().includes(searchQuery.toLowerCase());
    }).sort((a, b) => {
      // Сортируем: закрепленные сначала, затем по времени
      if (a.isPinned && !b.isPinned) return -1;
      if (!a.isPinned && b.isPinned) return 1;
      
      // Если оба закреплены или оба не закреплены - сортируем по времени последнего сообщения
      // (новые сверху, чаты без сообщений в конце)
      const aTime = a.lastMessage?.createdAt ? new Date(a.lastMessage.createdAt).getTime() : 0;
      const bTime = b.lastMessage?.createdAt ? new Date(b.lastMessage.createdAt).getTime() : 0;
      
      return bTime - aTime;
    });
  }, [chatsWithSystemOverride, selectedFolderId, searchQuery, currentUser]);

  // Форматирование времени последнего сообщения
  const formatTime = useCallback((dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diff = now.getTime() - date.getTime();

    if (date.toDateString() === now.toDateString()) {
      // Сегодня - показываем время
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    const diffDays = Math.floor(diff / 86400000);
    if (diffDays < 7) {
      // Менее 7 дней - показываем день недели
      return date.toLocaleDateString([], { weekday: 'short' });
    }

    // Более 7 дней - показываем дату
    return date.toLocaleDateString([], { day: 'numeric', month: 'short' });
  }, []);

  // Обрезка текста
  const truncateText = useCallback((text: string, maxLength = 35) => {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + '...';
  }, []);

  // Получение информации о чате для отображения
  const getChatDisplayInfo = useCallback((chat: typeof chatsWithSystemOverride[0]) => {
    // Системный чат
    if (chat.isSystem) {
      return {
        name: 'ZeroChat',
        avatar: undefined,
        isOnline: false,
      };
    }

    if (chat.type === 'private') {
      // After F5, participants may only contain otherParticipant (without current user)
      // So we try to find other participant, or fall back to first participant, or use chat.name
      const otherParticipant = chat.participants.find((p: any) => p.id !== currentUser?.id) || chat.participants[0];
      return {
        name: otherParticipant?.displayName || otherParticipant?.username || chat.name || 'Неизвестный',
        avatar: otherParticipant?.avatar,
        isOnline: otherParticipant?.status === 'online',
      };
    }
    return {
      name: chat.name || 'Групповой чат',
      avatar: chat.avatar,
      isOnline: false,
    };
  }, [currentUser]);

  // Получение превью последнего сообщения или typing индикатора
  const getMessagePreview = useCallback((chat: typeof chatsWithSystemOverride[0], isTyping: boolean) => {
    // Show typing indicator if someone is typing
    if (isTyping) {
      return 'печатает...';
    }
    
    if (!chat.lastMessage) return 'Нет сообщений';
    
    const isOwn = chat.lastMessage.senderId === currentUser?.id;
    const prefix = isOwn ? 'Вы: ' : '';
    
    // Check for media attachments
    const hasAttachments = chat.lastMessage.attachments && chat.lastMessage.attachments.length > 0;
    const messageType = chat.lastMessage.type;
    const content = chat.lastMessage.content;
    
    // If there are attachments, show media type
    if (hasAttachments && chat.lastMessage.attachments && chat.lastMessage.attachments.length > 0) {
      const firstAttachment = chat.lastMessage.attachments[0]!;
      const mediaLabels: Record<string, string> = {
        'image': 'Изображение',
        'video': 'Видео',
        'audio': 'Аудио',
        'voice': 'Голосовое сообщение',
        'file': 'Файл',
      };
      const mediaType = firstAttachment.type;
      const mediaLabel = mediaLabels[mediaType] || 'Медиа';
      
      // If there's a caption, show it along with media indicator
      if (content && content.trim()) {
        return `${prefix}${mediaLabel}: ${truncateText(content)}`;
      }
      
      return prefix + mediaLabel;
    }
    
    // If no attachments but has content, show text
    if (content && content.trim()) {
      return prefix + truncateText(content);
    }
    
    // If message has a type but no content and no attachments (legacy)
    if (messageType && messageType !== 'TEXT') {
      const typeLabels: Record<string, string> = {
        'IMAGE': 'Изображение',
        'VIDEO': 'Видео',
        'AUDIO': 'Аудио',
        'FILE': 'Файл',
        'SYSTEM': 'Системное',
      };
      return prefix + (typeLabels[messageType] || 'Сообщение');
    }
    
    return 'Нет сообщений';
  }, [currentUser, truncateText]);

  if (chatsLoading) {
    return <ChatListSkeleton />;
  }

  // Render the full layout (with search bar) even when there are no
  // results — otherwise the user can't edit/clear their search query.
  //
  // On mobile, the outer container also captures touchstart/touchend for
  // swipe-to-switch-folder. We attach on the OUTER div (not the scroll
  // area) so the gesture works anywhere over the list/tabs; touch events
  // bubble up from the inner pull-to-refresh container.
  return (
    <div
      className="flex flex-col h-full"
      onTouchStart={isMobile ? handleTouchStart : undefined}
      onTouchEnd={isMobile ? handleTouchEnd : undefined}
    >
      {/* Mobile folder tabs (horizontal pills). Renders null when there
          are no folders, so this is a no-op on desktop / fresh installs. */}
      {isMobile && <MobileFolderTabs />}

      {/* Поиск */}
      <div className="p-3 border-b">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Поиск..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 bg-muted/50"
          />
        </div>
      </div>

      {/* Список чатов */}
       <div
         ref={containerRef}
         className="flex-1 min-w-0 w-full overflow-x-hidden overflow-y-auto"
         {...(isMobile ? pullHandlers : {})}
       >
         {filteredChats.length === 0 && (
           <div className="flex-1 flex items-center justify-center p-8 text-muted-foreground">
             <div className="text-center">
               <p className="text-sm">{searchQuery ? 'Чаты не найдены' : 'Нет сообщений'}</p>
             </div>
           </div>
         )}
         {/* Pull-to-refresh indicator */}
         {isMobile && pullState.isPulling && (
           <div
             className="flex items-center justify-center py-2 text-muted-foreground"
             style={{ height: `${pullState.pullDistance}px` }}
           >
             {pullState.isRefreshing ? (
               <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-primary" />
             ) : (
               <span className="text-xs">
                 {pullState.pullDistance >= 80 ? 'Отпустите для обновления' : 'Потяните для обновления'}
               </span>
             )}
           </div>
         )}
         <div className="p-2">
          {/* Group: Pinned */}
          {(() => {
            const pinned = filteredChats.filter(chat => chat.isPinned && chat.type !== 'favorites' && !chat.isArchived);
            if (pinned.length === 0) return null;
            return (
              <>
                <div className="px-2 py-1 text-xs font-medium text-muted-foreground flex items-center gap-1 mt-2">
                  <Pin className="w-3 h-3" />
                  Закрепленные
                </div>
                {pinned.map(chat => renderChat(chat))}
              </>
            );
          })()}

           {/* Group: Regular chats (non-archived, non-favorites, non-pinned) */}
           {(() => {
             const regular = filteredChats.filter(chat => 
               !chat.isArchived && 
               chat.type !== 'favorites' && 
               !chat.isPinned
             );
            if (regular.length === 0) return null;
            return (
              <>
                <div className="px-2 py-1 text-xs font-medium text-muted-foreground mt-2">
                  Чаты
                </div>
                {regular.map(chat => renderChat(chat))}
              </>
            );
          })()}

          {/* Group: Archived */}
          {(() => {
            const archived = filteredChats.filter(chat => chat.isArchived);
            if (archived.length === 0) return null;
            return (
              <>
                <div className="px-2 py-1 text-xs font-medium text-muted-foreground mt-2 flex items-center gap-1">
                  <Archive className="w-3 h-3" />
                  Архив
                </div>
                {archived.map(chat => renderChat(chat))}
              </>
            );
          })()}
        </div>
      </div>
    </div>
  );

  // Helper function to render a single chat item
  function renderChat(chat: typeof filteredChats[0]) {
    const displayInfo = getChatDisplayInfo(chat);
    const isSelected = activeChat?.id === chat.id;
    
    // Check if someone is typing in this chat
    const typingUsers = getTypingUsers(chat.id);
    const otherParticipantId = chat.type === 'private'
      ? (chat.participants.find((p: any) => p.id !== currentUser?.id)?.id)
      : null;
    // For private chats: show typing only if the OTHER participant is typing.
    // For group chats: show typing if ANYONE is typing.
    const isTyping = chat.type === 'private'
      ? (otherParticipantId && typingUsers.some(u => u.userId === otherParticipantId))
      : typingUsers.length > 0;

        return (
          <button
            key={chat.id}
            onClick={() => {
              void navigate({ to: '/chat/$chatId', params: { chatId: chat.id } });
            }}
            className={cn(
              'w-full flex items-center gap-2 rounded-lg transition-colors overflow-hidden',
              'hover:bg-muted/50',
              isSelected && 'bg-muted/50',
              chat.isArchived && 'opacity-60',
              'max-w-full',
              isMobile ? 'p-3 min-h-[60px]' : 'p-2'
            )}
          >
        {/* Аватар */}
        <div className="relative">
          {chat.isSystem ? (
            <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center">
              <Bell className="h-5 w-5 text-primary" />
            </div>
          ) : (
            <Avatar className="h-10 w-10 shrink-0">
              {displayInfo.avatar ? (
                <AvatarImage src={displayInfo.avatar} alt={displayInfo.name} />
              ) : (
                <AvatarFallback className="bg-primary/10">
                  <span className="text-sm font-medium text-primary">
                    {displayInfo.name.charAt(0).toUpperCase()}
                  </span>
                </AvatarFallback>
              )}
            </Avatar>
          )}
          {chat.type === 'private' && !chat.isSystem && displayInfo.isOnline && (
            <span className="absolute bottom-0 right-0 h-3 w-3 rounded-full bg-green-500 border-2 border-background" />
          )}
        </div>

        {/* Информация о чате */}
        <div className="flex-1 min-w-0 max-w-full text-left">
          <div className="flex items-center gap-2">
            <span className="font-medium truncate flex-1 min-w-0 max-w-full">{displayInfo.name}</span>
            <div className="flex items-center gap-1 shrink-0">
              {chat.isPinned && (
                <Pin className="h-3 w-3 text-primary shrink-0" />
              )}
              {chat.isMuted && (
                <VolumeOff className="h-3 w-3 text-muted-foreground shrink-0" />
              )}
              {chat.isArchived && (
                <Archive className="h-3 w-3 text-muted-foreground shrink-0" />
              )}
              {chat.lastMessage && (
                <span className="text-[11px] text-muted-foreground shrink-0">
                  {formatTime(chat.lastMessage.createdAt)}
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 mt-1">
            <p className={`text-sm truncate flex-1 min-w-0 max-w-full ${isTyping ? 'text-primary font-medium' : 'text-muted-foreground'}`}>
              {getMessagePreview(chat, !!isTyping)}
            </p>

            {/* Непрочитанные - показываем только если > 0 */}
            {(chat.unreadCount ?? 0) > 0 && (
              <Badge
                variant="default"
                className="h-5 min-w-[20px] px-1.5 rounded-full text-xs shrink-0"
              >
                {chat.unreadCount! > 99 ? '99+' : chat.unreadCount}
              </Badge>
            )}
          </div>
        </div>
      </button>
    );
  }
}

// Skeleton для loading состояния
function ChatListSkeleton() {
  return (
    <div className="flex flex-col h-full p-3">
      {/* Skeleton поиска */}
      <div className="relative mb-3">
        <Skeleton className="h-9 w-full rounded-lg" />
      </div>

      {/* Skeleton списка чатов */}
      <div className="flex-1 space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-center gap-2 p-2">
            <Skeleton className="h-10 w-10 rounded-full" />
            <div className="flex-1 space-y-1">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-3 w-full" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Пустой стейт
function EmptyChatList() {
  return (
    <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
      <MessageCircle className="h-12 w-12 mb-3 opacity-50" />
      <p className="text-sm font-medium">Чаты не найдены</p>
      <p className="text-xs opacity-70 mt-1">Начните новый чат, чтобы увидеть его здесь</p>
    </div>
  );
}

export default memo(ChatList);
