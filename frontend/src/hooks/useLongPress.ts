import { useCallback, useRef, useState } from 'react';

interface LongPressOptions {
  onLongPress: () => void;
  onPress?: () => void;
  delay?: number;
}

interface LongPressState {
  isLongPressing: boolean;
  isPressed: boolean;
}

export function useLongPress({
  onLongPress,
  onPress,
  delay = 500,
}: LongPressOptions) {
  const [state, setState] = useState<LongPressState>({
    isLongPressing: false,
    isPressed: false,
  });

  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isLongPressTriggeredRef = useRef(false);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    isLongPressTriggeredRef.current = false;
    setState({
      isLongPressing: false,
      isPressed: true,
    });

    timeoutRef.current = setTimeout(() => {
      isLongPressTriggeredRef.current = true;
      setState({
        isLongPressing: true,
        isPressed: false,
      });
      onLongPress();
    }, delay);
  }, [onLongPress, delay]);

  const handleTouchEnd = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }

    if (!isLongPressTriggeredRef.current && onPress) {
      onPress();
    }

    setState({
      isLongPressing: false,
      isPressed: false,
    });
  }, [onPress]);

  const handleTouchMove = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }

    setState({
      isLongPressing: false,
      isPressed: false,
    });
  }, []);

  return {
    longPressState: state,
    handlers: {
      onTouchStart: handleTouchStart,
      onTouchEnd: handleTouchEnd,
      onTouchMove: handleTouchMove,
    },
  };
}
