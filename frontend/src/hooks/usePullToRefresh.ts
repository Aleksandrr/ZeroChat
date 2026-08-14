import { useCallback, useRef, useState } from 'react';

interface PullToRefreshOptions {
  onRefresh: () => Promise<void>;
  threshold?: number;
}

interface PullToRefreshState {
  isPulling: boolean;
  pullDistance: number;
  isRefreshing: boolean;
}

export function usePullToRefresh({
  onRefresh,
  threshold = 80,
}: PullToRefreshOptions) {
  const [state, setState] = useState<PullToRefreshState>({
    isPulling: false,
    pullDistance: 0,
    isRefreshing: false,
  });

  const startYRef = useRef<number>(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    // Only trigger if scrolled to top
    if (containerRef.current && containerRef.current.scrollTop === 0) {
      startYRef.current = e.touches[0]?.clientY ?? 0;
      setState({
        isPulling: true,
        pullDistance: 0,
        isRefreshing: false,
      });
    }
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!state.isPulling || state.isRefreshing) return;

    const currentY = e.touches[0]?.clientY ?? 0;
    const deltaY = currentY - startYRef.current;

    // Only allow pulling down
    if (deltaY > 0) {
      // Apply resistance (diminishing returns)
      const distance = Math.min(deltaY * 0.5, threshold * 1.5);
      setState({
        isPulling: true,
        pullDistance: distance,
        isRefreshing: false,
      });
    }
  }, [state.isPulling, state.isRefreshing, threshold]);

  const handleTouchEnd = useCallback(async () => {
    if (!state.isPulling) return;

    if (state.pullDistance >= threshold && !state.isRefreshing) {
      setState({
        isPulling: false,
        pullDistance: 0,
        isRefreshing: true,
      });

      try {
        await onRefresh();
      } finally {
        setState({
          isPulling: false,
          pullDistance: 0,
          isRefreshing: false,
        });
      }
    } else {
      setState({
        isPulling: false,
        pullDistance: 0,
        isRefreshing: false,
      });
    }
  }, [state.isPulling, state.pullDistance, state.isRefreshing, threshold, onRefresh]);

  return {
    pullState: state,
    containerRef,
    handlers: {
      onTouchStart: handleTouchStart,
      onTouchMove: handleTouchMove,
      onTouchEnd: handleTouchEnd,
    },
  };
}
