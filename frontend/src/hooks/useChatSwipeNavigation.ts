import { useCallback, useRef, useState } from 'react';
import type { Chat } from '@/types';

interface ChatSwipeNavigationOptions {
  chats: Chat[];
  currentChatId: string;
  onSelectChat: (chat: Chat) => void;
}

interface ChatSwipeNavigationState {
  isSwiping: boolean;
  swipeDirection: 'left' | 'right' | null;
  swipeDistance: number;
}

export function useChatSwipeNavigation({
  chats,
  currentChatId,
  onSelectChat,
}: ChatSwipeNavigationOptions) {
  const [state, setState] = useState<ChatSwipeNavigationState>({
    isSwiping: false,
    swipeDirection: null,
    swipeDistance: 0,
  });

  const startXRef = useRef<number>(0);
  const startYRef = useRef<number>(0);

  const currentIndex = chats.findIndex(c => c.id === currentChatId);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    startXRef.current = e.touches[0]?.clientX ?? 0;
    startYRef.current = e.touches[0]?.clientY ?? 0;
    setState({
      isSwiping: true,
      swipeDirection: null,
      swipeDistance: 0,
    });
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!state.isSwiping) return;

    const currentX = e.touches[0]?.clientX ?? 0;
    const currentY = e.touches[0]?.clientY ?? 0;
    const deltaX = currentX - startXRef.current;
    const deltaY = currentY - startYRef.current;

    // Only track horizontal swipes (ignore vertical scrolling)
    if (Math.abs(deltaX) > Math.abs(deltaY)) {
      const direction = deltaX > 0 ? 'right' : 'left';
      setState({
        isSwiping: true,
        swipeDirection: direction,
        swipeDistance: Math.abs(deltaX),
      });
    }
  }, [state.isSwiping]);

  const handleTouchEnd = useCallback(() => {
    if (!state.isSwiping) return;

    const threshold = 100;
    if (state.swipeDistance >= threshold) {
      if (state.swipeDirection === 'left' && currentIndex < chats.length - 1) {
        // Swipe left - next chat
        onSelectChat(chats[currentIndex + 1]!);
      } else if (state.swipeDirection === 'right' && currentIndex > 0) {
        // Swipe right - previous chat
        onSelectChat(chats[currentIndex - 1]!);
      }
    }

    setState({
      isSwiping: false,
      swipeDirection: null,
      swipeDistance: 0,
    });
  }, [state.isSwiping, state.swipeDistance, state.swipeDirection, currentIndex, chats, onSelectChat]);

  return {
    swipeState: state,
    handlers: {
      onTouchStart: handleTouchStart,
      onTouchMove: handleTouchMove,
      onTouchEnd: handleTouchEnd,
    },
  };
}
