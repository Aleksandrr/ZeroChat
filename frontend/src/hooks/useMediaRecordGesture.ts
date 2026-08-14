/**
 * useMediaRecordGesture — Telegram-style media recording gestures.
 *
 * Gesture flow:
 *   - Short tap: toggle media mode (voice ↔ video)
 *   - Long press (350ms): start recording
 *   - Release (no swipe): stop → send (opens FileSendDialog)
 *   - Swipe up (while holding): lock recording (can release, recording continues)
 *   - Swipe left (while holding or locked): cancel recording
 *
 * Works for both voice (audio only) and video (camera + audio) recording.
 */

import { useCallback, useRef, useState } from 'react';

export type MediaMode = 'voice' | 'video';
export type RecordState = 'idle' | 'pressing' | 'recording' | 'locked' | 'canceling';

export interface MediaRecordGestureOptions {
  /** Called when user short-taps (no long press) */
  onToggleMode: () => void;
  /** Called when long-press triggers — start recording */
  onStartRecording: () => void;
  /** Called when user releases after recording (not locked, not canceled) — stop & send */
  onStopAndSend: () => void;
  /** Called when user swipes up — lock recording so user can release */
  onLock: () => void;
  /** Called when user swipes left — cancel recording */
  onCancel: () => void;
  /** Long press delay in ms (default 350) */
  longPressDelay?: number;
  /** Swipe threshold in pixels (default 60) */
  swipeThreshold?: number;
}

export interface MediaRecordGestureState {
  state: RecordState;
  mode: MediaMode;
  swipeDistance: number;
  swipeDirection: 'up' | 'left' | null;
}

export function useMediaRecordGesture({
  onToggleMode,
  onStartRecording,
  onStopAndSend,
  onLock,
  onCancel,
  longPressDelay = 350,
  swipeThreshold = 60,
}: MediaRecordGestureOptions) {
  const [state, setState] = useState<RecordState>('idle');
  const [swipeDirection, setSwipeDirection] = useState<'up' | 'left' | null>(null);
  const [swipeDistance, setSwipeDistance] = useState(0);

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTriggeredRef = useRef(false);
  const startXRef = useRef(0);
  const startYRef = useRef(0);
  const isLockedRef = useRef(false);

  const clearTimer = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  };

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0];
    if (!touch) return;
    startXRef.current = touch.clientX;
    startYRef.current = touch.clientY;
    longPressTriggeredRef.current = false;
    isLockedRef.current = false;
    setSwipeDirection(null);
    setSwipeDistance(0);
    setState('pressing');

    clearTimer();
    timeoutRef.current = setTimeout(() => {
      longPressTriggeredRef.current = true;
      setState('recording');
      onStartRecording();
    }, longPressDelay);
  }, [onStartRecording, longPressDelay]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0];
    if (!touch) return;

    const deltaX = touch.clientX - startXRef.current;
    const deltaY = touch.clientY - startYRef.current;

    // Only track swipes during recording or pressing
    if (state !== 'recording' && state !== 'pressing') return;

    // Determine direction: up (negative Y) or left (negative X)
    if (Math.abs(deltaY) > Math.abs(deltaX) && deltaY < 0) {
      // Swipe up
      setSwipeDirection('up');
      setSwipeDistance(Math.abs(deltaY));
    } else if (Math.abs(deltaX) > Math.abs(deltaY) && deltaX < 0) {
      // Swipe left
      setSwipeDirection('left');
      setSwipeDistance(Math.abs(deltaX));
    } else {
      setSwipeDirection(null);
      setSwipeDistance(0);
    }
  }, [state]);

  const handleTouchEnd = useCallback(() => {
    clearTimer();

    if (isLockedRef.current) {
      // Already locked — ignore release
      return;
    }

    if (!longPressTriggeredRef.current) {
      // Short tap — toggle mode
      setState('idle');
      setSwipeDirection(null);
      setSwipeDistance(0);
      onToggleMode();
      return;
    }

    // Was recording
    if (swipeDirection === 'left' && swipeDistance >= swipeThreshold) {
      // Cancel
      setState('canceling');
      onCancel();
    } else if (swipeDirection === 'up' && swipeDistance >= swipeThreshold) {
      // Lock recording
      isLockedRef.current = true;
      setState('locked');
      onLock();
    } else {
      // Release — stop and send
      setState('idle');
      setSwipeDirection(null);
      setSwipeDistance(0);
      onStopAndSend();
    }
  }, [swipeDirection, swipeDistance, swipeThreshold, onToggleMode, onCancel, onLock, onStopAndSend]);

  /** Called when locked recording should be stopped (user taps stop button) */
  const stopLockedRecording = useCallback(() => {
    if (isLockedRef.current) {
      isLockedRef.current = false;
      setState('idle');
      setSwipeDirection(null);
      setSwipeDistance(0);
      onStopAndSend();
    }
  }, [onStopAndSend]);

  /** Called when locked recording should be canceled (user taps cancel) */
  const cancelLockedRecording = useCallback(() => {
    if (isLockedRef.current) {
      isLockedRef.current = false;
      setState('idle');
      setSwipeDirection(null);
      setSwipeDistance(0);
      onCancel();
    }
  }, [onCancel]);

  return {
    state,
    swipeDirection,
    swipeDistance,
    isLocked: isLockedRef.current,
    handlers: {
      onTouchStart: handleTouchStart,
      onTouchMove: handleTouchMove,
      onTouchEnd: handleTouchEnd,
    },
    stopLockedRecording,
    cancelLockedRecording,
  };
}
