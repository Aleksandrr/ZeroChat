import { Pin } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

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
      loadAround,
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

  // ===== REFS FOR LATE-DECLARED VALUES =====
  // `regularMessages` and `virtualizer` are declared further down (after
  // the pinned/regular split + useVirtualizer call), but `scrollToMessage`
  // and `handleScroll` need to reference them. We use refs so the early-
  // declared callbacks read the latest values without TS "used before
  // declaration" errors and without re-creating the callback identities
  // on every render.
  const regularMessagesRef = useRef<ChatMessageItem[]>([]);
  const virtualizerRef = useRef<ReturnType<typeof useVirtualizer<HTMLDivElement, Element>> | null>(null);

  // F5 (silent scroll-to-unloaded):
  //
  // Behaviour, in priority order:
  //   1. If the target message is currently rendered in the DOM
  //      (data-message-id selector) → scrollIntoView. Fast path, no
  //      async work.
  //   2. Else if it's in the virtualizer's known item list but
  //      virtualized out → `virtualizer.scrollToIndex(idx, center)`.
  //   3. Else the message is outside the loaded page. Call
  //      `loadAround(messageId)` which fetches ~30 messages on each
  //      side from IndexedDB, merges them into `useMessages` state,
  //      and returns the target's index in the new sorted array. Then
  //      wait one animation frame for the virtualizer to re-render
  //      and `scrollToIndex(idx, { align: 'center', behavior: 'auto' })`.
  //
  // NO toasts. NO spinners. NO user-facing indication. If the message
  // isn't found in IndexedDB either, we silently no-op (matching the
  // "как в ТГ" requirement from the user). Errors are logged to
  // console only.
  const scrollToMessage = useCallback(async (messageId: string, smooth = false) => {
    const container = scrollRef.current;
    if (!container) return;

    // 1. DOM fast path
    const el = container.querySelector(`[data-message-id="${messageId}"]`) as HTMLElement | null;
    if (el) {
      el.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'center' });
      return;
    }

    const targetNorm = normalizeMessageId(messageId);
    const virtualizer = virtualizerRef.current;

    // 2. Virtualizer index lookup (item is in the list but virtualized out)
    if (virtualizer) {
      const idx = regularMessagesRef.current.findIndex(it =>
        it.type === 'message' && it.message && normalizeMessageId(it.message.id) === targetNorm
      );
      if (idx >= 0) {
        virtualizer.scrollToIndex(idx, { align: 'center', behavior: smooth ? 'smooth' : 'auto' });
        return;
      }
    }

    // 3. Silent load-around. `loadAround` is owned by `useMessages` and
    //    handles IndexedDB fetch + merge into the hook's state. Returns
    //    the new index of the target message, or null if it doesn't
    //    exist in this chat's local DB.
    if (!loadAround || !chatId) return;

    try {
      const newIdx = await loadAround(messageId);
      if (newIdx === null) return; // not in DB — silent no-op

      // Wait one frame for the virtualizer to re-render with the new
      // messages, then scroll. Use 'auto' (not 'smooth') so the jump
      // is instant — matches Telegram's UX where the scroll happens
      // in a single frame after the message window is loaded.
      requestAnimationFrame(() => {
        const v = virtualizerRef.current;
        if (v) {
          v.scrollToIndex(newIdx, { align: 'center', behavior: 'auto' });
        }
      });
    } catch (err) {
      console.error('[ChatMessages] scrollToMessage silent-load failed:', err);
    }
  }, [chatId, loadAround]);

  const findFirstUnreadMessage = useCallback((): string | null => {
    if (!chat?.unreadCount || chat.unreadCount === 0) return null;
    // Only count non-pinned, non-separator messages for unread position.
    const msgs = listItems.filter((item): item is ChatMessageItem & { type: 'message'; message: Message } =>
      item.type === 'message' && !!item.message && !item.message.isPinned
    );
    if (msgs.length === 0) return null;
    const unreadStartIndex = Math.max(0, msgs.length - (chat.unreadCount ?? 0));
    return msgs[unreadStartIndex]?.message?.id ?? null;
  }, [listItems, chat?.unreadCount]);

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

     try {
       await fetchNextPage();
     } finally {
       // Reset pagination flag in next tick (after layout effect runs)
       setTimeout(() => { isPaginatingRef.current = false; }, 0);
     }
   }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  // ===== SCROLL HANDLER =====
  // NOTE: declared AFTER `handleLoadMore` so the dependency array
  // doesn't trigger TS2448 ("used before declaration"). The scroll
  // handler is attached to the container DOM node in JSX below, so
  // ordering of the callback declaration here is purely a TS-safety
  // concern — there's no observable runtime difference.
  
   const handleScroll = useCallback(() => {
     isAtBottomRef.current = checkIsAtBottom();
     // Fallback: trigger loadMore when scrolled near top (in case
     // IntersectionObserver is killed by a re-render).
     if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
     scrollTimeoutRef.current = setTimeout(() => {
       const container = scrollRef.current;
       if (container && container.scrollTop < 200 && hasNextPage && !isFetchingNextPage && !isPaginatingRef.current) {
         void handleLoadMore();
       }
     }, 150);
   }, [checkIsAtBottom, hasNextPage, isFetchingNextPage, handleLoadMore]);

  // Intersection Observer
  //
  // F4 fix: previously the effect early-returned when an observer
  // already existed (`if (observerRef.current) return;`), which meant
  // that after a `chatId` change the observer kept invoking a STALE
  // `handleLoadMore` closure (the one captured when the observer was
  // first created). The new `handleLoadMore` (with the new chatId,
  // new `hasNextPage`, etc.) was never wired up.
  //
  // Fix: keep `handleLoadMore` in a ref and always recreate the
  // observer whenever `chatId` or `hasNextPage` changes (cleanup
  // disconnects the old one). The observer callback reads through
  // the ref so it always invokes the latest version.
  const handleLoadMoreRef = useRef(handleLoadMore);
  useEffect(() => {
    handleLoadMoreRef.current = handleLoadMore;
  }, [handleLoadMore]);

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

    const obs = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];

        if (entry?.isIntersecting) {
          // Always invoke the latest handleLoadMore via the ref —
          // avoids stale-closure bug after chat change.
          void handleLoadMoreRef.current();
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
  }, [chatId, hasNextPage]);

  // ===== Scroll restoration =====

  useLayoutEffect(() => {
    if (!isPaginatingRef.current) return;

    const container = scrollRef.current;
    if (!container) {
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

  // ===== Reset on chat change =====
  // NOTE: do NOT disconnect the IntersectionObserver here — that was
  // BUG #1 which killed pagination after initial load. The observer
  // effect at line 461 manages its own lifecycle.

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
      // Try to scroll to the first unread message first; fall back to
      // scrolling to the bottom if there are no unread messages.
      const unreadId = findFirstUnreadMessage();
      if (unreadId) {
        setTimeout(() => { scrollToMessage(unreadId, false); hasScrolledToUnreadRef.current = true; }, 100);
      } else {
        setTimeout(() => scrollToBottom(false), 100);
      }
    };
    window.addEventListener('zerochat:chat-selected', handler as EventListener);
    return () => window.removeEventListener('zerochat:chat-selected', handler as EventListener);
  }, [chatId, scrollToBottom, findFirstUnreadMessage, scrollToMessage]);

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
    // Include separators AND non-pinned messages so date dividers are
    // rendered in the virtualized list (BUG #6 fix).
    return listItems.filter(item => item.type === 'separator' || (item.type === 'message' && !item.message?.isPinned));
  }, [listItems]);

  // Virtualization for long message lists.
  // MUST be called before any early returns to comply with Rules of Hooks.
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: regularMessages.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 80,
    overscan: 5,
  });

  // Sync the late-declared values into the refs that the early-declared
  // `scrollToMessage` callback reads through. `virtualizer` is stable
  // across renders (per @tanstack/react-virtual's contract), but we
  // still update the ref in `useEffect` to be defensive against future
  // changes.
  useEffect(() => {
    regularMessagesRef.current = regularMessages;
  }, [regularMessages]);

  useEffect(() => {
    virtualizerRef.current = virtualizer;
  }, [virtualizer]);

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
     // F3 fix: also clear the pending-loads guard so that re-entering
     // this chat (or loading a different one) can re-fetch any quoted
     // messages that were in-flight when we left. Without this, the
     // Set would keep stale IDs forever and silently skip reloads.
     pendingQuotedLoadsRef.current.clear();
   }, [chatId]);

   
   if (isLoading && !initialLoadDone && listItems.length === 0) return <MessagesSkeleton />;
   if (isError) return <div className="flex-1 flex items-center justify-center text-muted-foreground"><p>Ошибка загрузки</p></div>;
   if (listItems.length === 0) return <div className="flex-1 flex items-center justify-center text-muted-foreground">{!initialLoadDone ? <MessagesSkeleton /> : <p>Нет сообщений</p>}</div>;
   if (!chat) return <div className="flex-1 flex items-center justify-center text-muted-foreground"><p>Выберите чат</p></div>;

  return (
    <div
      ref={(el) => {
        scrollRef.current = el;
        parentRef.current = el;
      }}
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
      
      {/* Regular messages - virtualized */}
      <div
        className="flex flex-col"
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const item = regularMessages[virtualItem.index];
          if (!item) return null;
          
          return (
            <div
              key={item.id}
              data-index={virtualItem.index}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualItem.start}px)`,
              }}
            >
              {renderItem(item)}
            </div>
          );
        })}
      </div>
      <div className="h-4" />
    </div>
  );
}
