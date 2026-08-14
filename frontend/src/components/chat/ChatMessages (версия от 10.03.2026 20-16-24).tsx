import { Pin } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { useAuth, useChat } from '@/contexts';
import { useImageGallery } from '@/contexts/ImageGalleryContext';
import { getMessage } from '@/lib/messages/db';
import { cn } from '@/lib/utils';
import { useMessages } from '@/queries';
import type { Attachment, Chat, Message, User } from '@/types';
import { batchResolveDisplayNames, resolveDisplayName, type ResolveNameOptions } from '@/lib/contacts/contacts-utils';

import { MessageBubble } from './MessageBubble';
import { MessageAttachments } from './MessageAttachment';

// Normalize message ID by stripping device suffixes and prefixes
// UUID format: 8-4-4-4-12 (e.g., "18dc3884-3d26-448f-a9b7-49ea491bb8d0")
// We strip:
//  - Numeric device suffixes (e.g., "-123", "-0", "-1")
//  - Sender-device pattern (e.g., "-sender-123")
//  - Pending pattern (e.g., "-pending-123")
//  - Frontend-generated "msg-" prefix (e.g., "msg-1772985252509-f5g0h23yk" -> "1772985252509-f5g0h23yk")
function normalizeMessageId(id: string | undefined | null | object): string {
  if (!id) {
    return '';
  }
  // Handle object case: extract id property if present
  if (typeof id === 'object' && id !== null) {
    const obj = id as { id?: string };
    if (obj.id && typeof obj.id === 'string') {
      id = obj.id;
    } else {
      // Can't extract a valid ID from object
      return '';
    }
  }
  // At this point, id should be a string (or we already returned)
  if (typeof id !== 'string') {
    return '';
  }
  // First, strip common prefixes like "msg-"
  let normalized = id;
  if (normalized.startsWith('msg-')) {
    normalized = normalized.substring(4);
  }
  // Check if the ID ends with a numeric device suffix (e.g., "-123", "-0", "-1")
  const match = normalized.match(/^(.+)-(\d+)$/);
  if (match && match[1]) {
    return match[1]; // Return the part before the numeric suffix
  }
  // Also check for sender-device pattern (e.g., "-sender-123")
  const match2 = normalized.match(/^(.+)-sender-\d+$/);
  if (match2 && match2[1]) {
    return match2[1];
  }
  // Check for pending pattern (e.g., "-pending-123")
  const match3 = normalized.match(/^(.+)-pending-\d+$/);
  if (match3 && match3[1]) {
    return match3[1];
  }
  return normalized; // Return normalized ID
}

interface ChatMessagesProps {
  chat: Chat | null;
}


function MessagesSkeleton() {
  return (
    <div className="flex flex-col gap-3 p-4">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className={`flex gap-2 ${i % 2 === 0 ? 'justify-end' : 'justify-start'}`}>
          <div className="h-10 w-1/3 bg-muted rounded animate-pulse" />
        </div>
      ))}
    </div>
  );
}

interface ChatMessageItem {
  type: 'message' | 'separator';
  id: string;
  message?: Message;
  date?: string;
  showAvatar?: boolean;
  showName?: boolean;
  sender?: User; // Full user object with displayName
  alignWithAvatar?: boolean;
}

const SCROLL_BOTTOM_THRESHOLD = 50;
const PAGE_SIZE = 100; // Increased to ensure all messages with replies are loaded

export function ChatMessages({ chat }: ChatMessagesProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const topObserverRef = useRef<HTMLDivElement>(null);
  const { user: currentUser } = useAuth();
  const { openContactCard } = useChat();
  const chatId = chat?.id;
  const chatType = chat?.type;

  // State for resolved display names (senderId -> displayName)
  const [resolvedSenderNames, setResolvedSenderNames] = useState<Map<string, string>>(new Map());

   // console.log('[ChatMessages] Rendering with chatId:', chatId, 'chatType:', chatType, 'chat:', chat);

  // ===== REFS =====
  const isAtBottomRef = useRef(true);
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messageIdsRef = useRef<Set<string>>(new Set());
  const hasScrolledToUnreadRef = useRef(false);
  const observerRef = useRef<IntersectionObserver | null>(null);

   // ПАГИНАЦИЯ
    const isPaginatingRef = useRef(false);
    const savedScrollHeightRef = useRef<number>(0);

    // ===== QUOTED MESSAGE CACHE =====
    // Cache for quoted messages that are not in the current page
    const [quotedMessagesCache, setQuotedMessagesCache] = useState<Map<string, Message>>(new Map());
    const pendingQuotedLoadsRef = useRef<Set<string>>(new Set());

    // ===== HIGHLIGHT STATE =====
    // ID сообщения, которое нужно подсветить (при клике на репли)
    const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
    const highlightTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

        // Запрашиваем сообщения
    const {
      fetchNextPage,
      hasNextPage,
      isFetchingNextPage,
      isLoading,
      isError,
      paginationCutoffTime,
      allMessages,
      initialLoadDone,
     } = useMessages(chatId || null, PAGE_SIZE);

    // Image gallery context
    const { openGallery } = useImageGallery();

    // ===== RESOLVE DISPLAY NAMES FOR SENDERS =====
    // Batch resolve display names for senders not in participants
    useEffect(() => {
      if (!allMessages || allMessages.length === 0) return;

      // Collect data for each missing sender: chatId and whether they have any non-forwarded message
      const missingSenderData = new Map<string, { chatId: string; hasNonForwarded: boolean }>();

      for (const msg of allMessages) {
        const senderInParticipants = chat?.participants.some(p => p.id === msg.senderId);
        if (!senderInParticipants) {
          const existing = missingSenderData.get(msg.senderId);
          const chatId = msg.chatId || chat?.id || '';
          const isNonForwarded = msg.metadata?.forwardedFrom === undefined;
          if (existing) {
            // If we already have a record, update hasNonForwarded if this message is non-forwarded
            if (isNonForwarded) {
              existing.hasNonForwarded = true;
            }
            // Keep the first chatId (they should all be the same for a given chat)
          } else {
            missingSenderData.set(msg.senderId, {
              chatId,
              hasNonForwarded: isNonForwarded,
            });
          }
        }
      }

      if (missingSenderData.size === 0) return;

      // Build requests: isForwarded = true only if ALL messages from this sender are forwarded
      const requests: ResolveNameOptions[] = Array.from(missingSenderData.entries()).map(([senderId, data]) => ({
        userId: senderId,
        chatId: data.chatId,
        isForwarded: !data.hasNonForwarded,
      }));

      batchResolveDisplayNames(requests).then(result => {
        setResolvedSenderNames(result);
      }).catch(error => {
        console.error('[ChatMessages] Failed to resolve display names:', error);
      });
    }, [allMessages, chat?.participants, chat?.id]);

    // Compute all image attachments from all messages in order (by message time)
    const allImageAttachments = useMemo(() => {
      if (!allMessages || allMessages.length === 0) return [];
      const images: Attachment[] = [];
      // Sort messages by createdAt to maintain order
      const sortedMessages = [...allMessages].sort((a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );
      sortedMessages.forEach(message => {
        if (message.attachments) {
          message.attachments.forEach(att => {
            if (att.type === 'image') {
              images.push(att);
            }
          });
        }
      });
      return images;
    }, [allMessages]);

    // Handler for image click - opens gallery with all images in chat
    const handleImageClick = useCallback((clickedAttachment: Attachment) => {
      // Find the global index of the clicked image in allImageAttachments
      const globalIndex = allImageAttachments.findIndex(att => att.id === clickedAttachment.id);
      if (globalIndex !== -1) {
        openGallery(allImageAttachments, globalIndex);
      }
    }, [allImageAttachments, openGallery]);


  // ===== QUOTED MESSAGE LOADING =====
  
  // Function to load a quoted message from IndexedDB
  const loadQuotedMessage = useCallback(async (replyToId: string, currentChatId: string): Promise<void> => {
    const normalizedId = normalizeMessageId(String(replyToId));
    
    // Skip if already in cache or already loading
    if (quotedMessagesCache.has(normalizedId) || pendingQuotedLoadsRef.current.has(normalizedId)) {
      return;
    }
    
    // Mark as loading
    pendingQuotedLoadsRef.current.add(normalizedId);
    
    try {
      // Load from IndexedDB using the original replyToId (not normalized)
      const stored = await getMessage(replyToId);
      if (!stored) {
        console.warn('[ChatMessages] Quoted message not found in DB:', { replyToId, chatId: currentChatId });
        return;
      }
      
      // Ensure the message belongs to the current chat
      if (stored.chatId !== currentChatId) {
        console.warn('[ChatMessages] Quoted message from different chat:', { 
          replyToId, 
          storedChatId: stored.chatId, 
          currentChatId 
        });
        return;
      }
      
      // Convert StoredMessage to Message
      // Find sender from current chat participants to get displayName
      let sender = chat?.participants.find(p => p.id === stored.senderId);
      
      // If not found, resolve using contacts/cache/server
      if (!sender) {
        const isForwarded = stored.metadata?.forwardedFrom !== undefined;
        const resolvedName = await resolveDisplayName(stored.senderId, currentChatId, isForwarded);
        sender = {
          id: stored.senderId,
          username: resolvedName,
          displayName: resolvedName,
        };
      }
      
      const message: Message = {
        id: stored.id,
        chatId: stored.chatId,
        senderId: stored.senderId,
        senderUsername: stored.senderUsername,
        sender: sender || undefined, // Include full sender object if available
        content: stored.content,
        type: (stored.type as Message['type']) || 'TEXT',
        status: stored.status === 'delivered' ? 'DELIVERED' : stored.status === 'read' ? 'READ' : 'SENT',
        createdAt: new Date(stored.timestamp).toISOString(),
        replyTo: stored.replyTo,
        replyToOriginalSenderId: stored.replyToOriginalSenderId,
        metadata: stored.metadata,
        attachments: stored.attachments?.map(att => ({
          id: att.id,
          type: att.type,
          fileName: att.fileName,
          size: att.size,
          mimeType: att.mimeType,
          data: att.data,
          contentHash: att.contentHash,
        })) as Attachment[],
      };
      
      // Cache it
      setQuotedMessagesCache(prev => {
        const next = new Map(prev);
        next.set(normalizedId, message);
        return next;
      });
    } catch (error) {
      console.error('[ChatMessages] Failed to load quoted message:', error, { replyToId, chatId: currentChatId });
    } finally {
      pendingQuotedLoadsRef.current.delete(normalizedId);
    }
    }, [quotedMessagesCache]);

   // Преобразуем в list items
   const listItems = useMemo<ChatMessageItem[]>(() => {
     if (!allMessages || allMessages.length === 0) {
       return [];
     }

     // Sort: pinned first, then by createdAt ascending (for date separators)
     const sorted = [...allMessages].sort((a, b) => {
       // Pinned messages first
       if (a.isPinned && !b.isPinned) return -1;
       if (!a.isPinned && b.isPinned) return 1;
       // Then by creation time
       return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
     });

     const items: ChatMessageItem[] = [];
     let currentDate = '';

     for (let i = 0; i < sorted.length; i++) {
       const message = sorted[i]!;
       const date = new Date(message.createdAt).toDateString();

       if (date !== currentDate) {
         currentDate = date;
         items.push({ type: 'separator', id: `sep-${date}`, date });
       }

       const prevMessage = i > 0 ? sorted[i - 1] : null;
       const nextMessage = i < sorted.length - 1 ? sorted[i + 1] : null;
       const isSameSenderAsPrev = prevMessage && prevMessage.senderId === message.senderId;
       const isSameSenderAsNext = nextMessage && nextMessage.senderId === message.senderId;
       const timeDiff = prevMessage
         ? new Date(message.createdAt).getTime() - new Date(prevMessage.createdAt).getTime()
         : Infinity;

        let showAvatar = false;
        let showName = false;
        let senderUser: User | undefined;

        // Find sender from participants first (works for both group and private chats)
        senderUser = chat?.participants.find(p => p.id === message.senderId);

         // If not found in participants, try to use resolved name from batch resolution
         if (!senderUser) {
           const resolvedName = resolvedSenderNames.get(message.senderId);
           if (resolvedName) {
             senderUser = {
               id: message.senderId,
               username: resolvedName,
               displayName: resolvedName,
             };
           }
         }

        if (chatType === 'group') {
          showAvatar = !isSameSenderAsNext || (nextMessage && new Date(nextMessage.createdAt).getTime() - new Date(message.createdAt).getTime() >= 60000);
          showName = !isSameSenderAsPrev || timeDiff >= 60000;
        }

        items.push({
          type: 'message',
          id: message.id,
          message: {
            ...message,
            sender: senderUser,
          },
          showAvatar,
          showName,
          sender: senderUser,
          alignWithAvatar: chatType === 'group' && !showAvatar && message.senderId !== currentUser?.id,
        });
     }

      console.log('[ChatMessages] listItems computed, items count:', items.length, 'items:', items.map(i => i.type === 'message' ? i.message?.id : i.id));
      return items;
    }, [allMessages, chatType, chat?.participants, currentUser?.id, resolvedSenderNames, openContactCard, chatId]);

  // ===== SCROLL HELPERS =====

  const checkIsAtBottom = useCallback((): boolean => {
    const container = scrollRef.current;
    if (!container) return false;
    const { scrollTop, scrollHeight, clientHeight } = container;
    return scrollHeight - scrollTop - clientHeight <= SCROLL_BOTTOM_THRESHOLD;
  }, []);

  const scrollToBottom = useCallback((smooth = false) => {
    const container = scrollRef.current;
    if (!container) return;
    container.scrollTo({ top: container.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    isAtBottomRef.current = true;
  }, []);

  const scrollToMessage = useCallback((messageId: string, smooth = false) => {
    const container = scrollRef.current;
    if (!container) return;
    const el = container.querySelector(`[data-message-id="${messageId}"]`) as HTMLElement | null;
    if (el) el.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'center' });
  }, []);

  const findFirstUnreadMessage = useCallback((): string | null => {
    if (!chat?.unreadCount || chat.unreadCount === 0) return null;
    const msgs = listItems.filter((item): item is ChatMessageItem & { type: 'message'; message: Message } =>
      item.type === 'message' && !!item.message && item.message.senderId !== (currentUser?.id ?? '')
    );
    return msgs[0]?.message?.id ?? null;
  }, [listItems, chat?.unreadCount, currentUser?.id]);

  // ===== SCROLL HANDLER =====
  
   const handleScroll = useCallback(() => {
     isAtBottomRef.current = checkIsAtBottom();
     if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
     scrollTimeoutRef.current = setTimeout(() => {
       // Debounce scroll handling
     }, 150);
   }, [checkIsAtBottom]);

  // ===== ПАГИНАЦИЯ =====

   const handleLoadMore = useCallback(async () => {
     if (!hasNextPage) {
       return;
     }
     if (isFetchingNextPage) {
       return;
     }
     if (isPaginatingRef.current) {
       return;
     }

     const container = scrollRef.current;
     if (!container) {
       return;
     }

     savedScrollHeightRef.current = container.scrollHeight;
     isPaginatingRef.current = true;

     await fetchNextPage();
   }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  // Intersection Observer
  useEffect(() => {
    const topEl = topObserverRef.current;
    const scrollEl = scrollRef.current;

    if (!topEl || !scrollEl || !hasNextPage) {
      if (observerRef.current) {
        observerRef.current.disconnect();
        observerRef.current = null;
      }
      return;
    }
    
    if (observerRef.current) {
      return;
    }

     const obs = new IntersectionObserver(
       (entries) => {
         const entry = entries[0];
         
         if (entry?.isIntersecting) {
           void handleLoadMore();
         }
       },
       { root: scrollEl, threshold: 0, rootMargin: '500px 0px 0px 0px' }
     );

    obs.observe(topEl);
    observerRef.current = obs;

    return () => {
      obs.disconnect();
      observerRef.current = null;
    };
  }, [chatId, hasNextPage, handleLoadMore]);

  // ===== Scroll restoration =====

  useLayoutEffect(() => {
    if (!isPaginatingRef.current) return;

    const container = scrollRef.current;
    if (!container) {
      isPaginatingRef.current = false;
      return;
    }

    const oldHeight = savedScrollHeightRef.current;
    const newHeight = container.scrollHeight;
    const diff = newHeight - oldHeight;

    if (diff > 0) {
      container.scrollTop += diff;
    }

    savedScrollHeightRef.current = 0;
  }, [allMessages.length]);

  // Reset pagination flag
  useEffect(() => {
    if (isPaginatingRef.current) {
      const timer = setTimeout(() => {
        isPaginatingRef.current = false;
      }, 0);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [allMessages.length]);

  // ===== Reset on chat change =====

  useEffect(() => {
    isAtBottomRef.current = true;
    isPaginatingRef.current = false;
    hasScrolledToUnreadRef.current = false;
    messageIdsRef.current = new Set();
    savedScrollHeightRef.current = 0;

    if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);

    if (scrollRef.current && !isLoading) {
      setTimeout(() => scrollToBottom(false), 50);
    }

    return () => {
      if (observerRef.current) { observerRef.current.disconnect(); observerRef.current = null; }
    };
  }, [chatId, isLoading, scrollToBottom]);

  // ===== Scroll to unread =====

  useEffect(() => {
    if (isLoading || !listItems.length || hasScrolledToUnreadRef.current) return;
    const id = findFirstUnreadMessage();
    if (id) setTimeout(() => { scrollToMessage(id, false); hasScrolledToUnreadRef.current = true; }, 100);
    else hasScrolledToUnreadRef.current = true;
  }, [isLoading, listItems.length, findFirstUnreadMessage, scrollToMessage]);

  // ===== Chat selected event =====

  useEffect(() => {
    const handler = (evt: CustomEvent<{ chatId: string }>) => {
      if (evt.detail.chatId !== chatId) return;
      hasScrolledToUnreadRef.current = false;
      setTimeout(() => scrollToBottom(false), 100);
    };
    window.addEventListener('zerochat:chat-selected', handler as EventListener);
    return () => window.removeEventListener('zerochat:chat-selected', handler as EventListener);
  }, [chatId, scrollToBottom]);

  // ===== New messages =====

  useEffect(() => {
    if (isPaginatingRef.current) {
      messageIdsRef.current = new Set(allMessages.map(m => m.id));
      return;
    }

    const currentIds = new Set(allMessages.map(m => m.id));
    const newMsgs = allMessages.filter(m => !messageIdsRef.current.has(m.id));

    if (newMsgs.length > 0) {
      const isPagination = newMsgs.some(m => new Date(m.createdAt).getTime() < paginationCutoffTime);

      if (!isPagination) {
        const hasOwn = newMsgs.some(m => m.senderId === currentUser?.id);

        if (hasOwn) {
          scrollToBottom(!checkIsAtBottom());
        } else if (isAtBottomRef.current) {
          scrollToBottom(false);
        }
      }
    }

    messageIdsRef.current = currentIds;
  }, [allMessages, paginationCutoffTime, currentUser?.id, checkIsAtBottom, scrollToBottom]);

   // ===== Message sent event =====

   useEffect(() => {
     const handler = () => scrollToBottom(!checkIsAtBottom());
     window.addEventListener('zerochat:message-sent', handler);
     return () => window.removeEventListener('zerochat:message-sent', handler);
   }, [checkIsAtBottom, scrollToBottom]);

   // ===== Scroll to quoted message event =====

   useEffect(() => {
     const handler = (evt: CustomEvent<{ messageId: string; chatId: string }>) => {
       if (evt.detail.chatId !== chatId) return;

       const targetMessageId = normalizeMessageId(evt.detail.messageId);

       // Clear previous highlight
       if (highlightTimeoutRef.current) {
         clearTimeout(highlightTimeoutRef.current);
       }

       // Function to scroll and highlight
       const scrollAndHighlight = async () => {
         // Check if message is in current list
         const message = allMessages.find(m => normalizeMessageId(m.id) === targetMessageId);

         if (message) {
           // Message is loaded, scroll to it
           scrollToMessage(message.id, true);
           setHighlightedMessageId(targetMessageId);

           // Remove highlight after 3 seconds
           highlightTimeoutRef.current = setTimeout(() => {
             setHighlightedMessageId(null);
           }, 3000);
         } else {
           // Message not in current page, try to load from IndexedDB
           console.log('[ChatMessages] Scrolling to quoted message not in current list, loading from DB:', targetMessageId);
           await loadQuotedMessage(evt.detail.messageId, chatId);

           // After loading, scroll to it (it should be in cache now)
           // Wait a bit for state update
           setTimeout(() => {
             const cachedMessage = quotedMessagesCache.get(targetMessageId);
             if (cachedMessage) {
               scrollToMessage(cachedMessage.id, true);
               setHighlightedMessageId(targetMessageId);

               // Remove highlight after 3 seconds
               highlightTimeoutRef.current = setTimeout(() => {
                 setHighlightedMessageId(null);
               }, 3000);
             } else {
               console.warn('[ChatMessages] Could not load quoted message for highlighting:', targetMessageId);
             }
           }, 100);
         }
       };

       void scrollAndHighlight();
     };

     window.addEventListener('zerochat:scroll-to-message', handler as EventListener);
     return () => window.removeEventListener('zerochat:scroll-to-message', handler as EventListener);
   }, [chatId, allMessages, quotedMessagesCache, scrollToMessage, loadQuotedMessage]);

  // ===== RENDER =====

  // Separate pinned and regular messages for display
  const pinnedMessages = useMemo(() => {
    return listItems.filter(item => item.type === 'message' && item.message?.isPinned);
  }, [listItems]);

  const regularMessages = useMemo(() => {
    return listItems.filter(item => item.type === 'message' && !item.message?.isPinned);
  }, [listItems]);

  const renderItem = useCallback((item: ChatMessageItem): React.ReactElement | null => {
    if (item.type === 'separator') {
      const d = new Date(item.date || '');
      const today = new Date();
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);

      let s: string;
      if (d.toDateString() === today.toDateString()) s = 'Сегодня';
      else if (d.toDateString() === yesterday.toDateString()) s = 'Вчера';
      else s = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: d.getFullYear() !== today.getFullYear() ? 'numeric' : undefined });

      return (
        <div className="flex items-center justify-center my-4">
          <span className="text-xs text-muted-foreground bg-muted/50 px-3 py-1 rounded-full">{s}</span>
        </div>
      );
    }

     if (!item.message) return null;
     const message = item.message; // TypeScript now knows this is defined
     const isOwn = message.senderId === currentUser?.id;
     
      // Найти исходное сообщение, на которое отвечают
      // Сначала ищем в allMessages, затем в кэше quotedMessagesCache
      const replyToId = message.replyTo;
      let replyToMessage: Message | null = null;
      if (replyToId) {
        const normalizedReplyToId = normalizeMessageId(String(replyToId));
        // Search in allMessages
        replyToMessage = allMessages.find(m => normalizeMessageId(m.id) === normalizedReplyToId) || null;
        // If not found, check cache
        if (!replyToMessage) {
          replyToMessage = quotedMessagesCache.get(normalizedReplyToId) || null;
        }
      }
          
       // DEBUG: Log reply lookup (only when not found to reduce noise)
      if (replyToId && process.env.NODE_ENV === 'development' && !replyToMessage) {
        const replyToStr = String(replyToId);
        const normalized = normalizeMessageId(replyToStr);
        console.log('[ChatMessages] Reply lookup (not found):', {
          messageId: message.id,
          replyToId: replyToId,
          replyToType: typeof replyToId,
          normalizedReplyToId: normalized,
          allMessagesCount: allMessages.length,
          allMessageIds: allMessages.map(m => m.id),
        });
        
        // Diagnostic: Check if quoted message exists in IndexedDB at all
        getMessage(normalized).then(foundMsg => {
          if (foundMsg) {
            console.warn('[ChatMessages] Quoted message exists in DB but NOT in current chat:', {
              replyToId,
              normalizedReplyToId: normalized,
              foundChatId: foundMsg.chatId,
              currentChatId: chatId,
              messageId: message.id,
              match: foundMsg.chatId === chatId
            });
          } else {
            console.warn('[ChatMessages] Quoted message completely missing from DB:', {
              replyToId,
              normalizedReplyToId: normalized,
              currentChatId: chatId,
              messageId: message.id
            });
          }
        }).catch(err => {
          console.error('[ChatMessages] Error checking quoted message:', err);
        });
      }

      const isHighlighted = highlightedMessageId === normalizeMessageId(message.id);

             return (
        <div
          className="px-4 py-0.5"
          data-message-id={message.id}
        >
          <MessageBubble
            key={message.id}
            message={message}
            isOwn={isOwn}
            showAvatar={item.showAvatar}
            showName={item.showName}
            name={item.sender?.displayName || item.sender?.username}
            avatar={item.sender?.avatar}
            alignWithAvatar={item.alignWithAvatar}
            replyToMessage={replyToMessage}
            replyToOriginalSenderId={message.replyToOriginalSenderId}
            highlighted={isHighlighted}
            onImageClick={handleImageClick}
            participants={chat?.participants || []}
            onOpenContactCard={openContactCard}
          />
        </div>
      );

     }, [currentUser?.id, allMessages, quotedMessagesCache, highlightedMessageId, normalizeMessageId, chatType, chat?.participants]);

  // Effect to load missing quoted messages when listItems change
  useEffect(() => {
    if (!chatId) return;
    
    // Collect all replyTo IDs from visible messages
    const replyToIds = new Set<string>();
    listItems.forEach(item => {
      if (item.type === 'message' && item.message?.replyTo) {
        replyToIds.add(item.message.replyTo);
      }
    });
    
    if (replyToIds.size > 0 && process.env.NODE_ENV === 'development') {
      console.log('[ChatMessages] Loading quoted messages for replyTo IDs:', Array.from(replyToIds));
    }
    
    // Load each missing quoted message
    replyToIds.forEach(replyToId => {
      const normalizedId = normalizeMessageId(String(replyToId));
      
      // Check if already in allMessages or cache
      const inAllMessages = allMessages.some(m => normalizeMessageId(m.id) === normalizedId);
      if (inAllMessages || quotedMessagesCache.has(normalizedId)) {
        return;
      }
      
      // Load asynchronously
      void loadQuotedMessage(replyToId, chatId);
    });
  }, [listItems, allMessages, quotedMessagesCache, chatId, loadQuotedMessage]);

   // Clear quoted messages cache when chat changes to avoid showing messages from other chats
   useEffect(() => {
     setQuotedMessagesCache(new Map());
   }, [chatId]);

    console.log('[ChatMessages] Render state: isLoading:', isLoading, 'initialLoadDone:', initialLoadDone, 'listItems.length:', listItems.length, 'isError:', isError, 'chat:', chat?.id);
   
   if (isLoading && !initialLoadDone && listItems.length === 0) return <MessagesSkeleton />;
   if (isError) return <div className="flex-1 flex items-center justify-center text-muted-foreground"><p>Ошибка загрузки</p></div>;
   if (listItems.length === 0) return <div className="flex-1 flex items-center justify-center text-muted-foreground">{!initialLoadDone ? <MessagesSkeleton /> : <p>Нет сообщений</p>}</div>;
   if (!chat) return <div className="flex-1 flex items-center justify-center text-muted-foreground"><p>Выберите чат</p></div>;

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto overflow-x-hidden"
      style={{ overflowAnchor: 'none' }}
    >
      <div ref={topObserverRef} className="h-px w-full" />
      {!hasNextPage && listItems.length > 0 && <p className="text-center py-4 text-sm text-muted-foreground">Начало переписки</p>}
      
      {/* Pinned messages section */}
      {pinnedMessages.length > 0 && (
        <>
          <div className="px-4 py-2 bg-muted/30 border-b">
            <p className="text-xs font-medium text-muted-foreground flex items-center gap-1">
              <Pin className="w-3 h-3" />
              Закрепленные сообщения
            </p>
          </div>
          <div className="flex flex-col">
            {pinnedMessages.map(item => (
              <div key={item.id}>{renderItem(item)}</div>
            ))}
          </div>
          <div className="px-4 py-2 border-t">
            <p className="text-xs text-muted-foreground">Остальные сообщения</p>
          </div>
        </>
      )}
      
      {/* Regular messages */}
      <div className="flex flex-col">{regularMessages.map(item => <div key={item.id}>{renderItem(item)}</div>)}</div>
      <div className="h-4" />
    </div>
  );
}
