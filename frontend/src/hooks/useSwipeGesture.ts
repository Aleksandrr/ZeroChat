import { useCallback, useRef, useState } from 'react';

interface SwipeGestureOptions {
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
  threshold?: number;
}

interface SwipeGestureState {
  isSwiping: boolean;
  swipeDirection: 'left' | 'right' | null;
  swipeDistance: number;
}

export function useSwipeGesture({
  onSwipeLeft,
  onSwipeRight,
  threshold = 100,
}: SwipeGestureOptions) {
  const [state, setState] = useState<SwipeGestureState>({
    isSwiping: false,
    swipeDirection: null,
    swipeDistance: 0,
  });

  const startXRef = useRef<number>(0);
  const startYRef = useRef<number>(0);

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

    if (state.swipeDistance >= threshold) {
      if (state.swipeDirection === 'left' && onSwipeLeft) {
        onSwipeLeft();
      } else if (state.swipeDirection === 'right' && onSwipeRight) {
        onSwipeRight();
      }
    }

    setState({
      isSwiping: false,
      swipeDirection: null,
      swipeDistance: 0,
    });
  }, [state.isSwiping, state.swipeDistance, state.swipeDirection, threshold, onSwipeLeft, onSwipeRight]);

  return {
    swipeState: state,
    handlers: {
      onTouchStart: handleTouchStart,
      onTouchMove: handleTouchMove,
      onTouchEnd: handleTouchEnd,
    },
  };
}
