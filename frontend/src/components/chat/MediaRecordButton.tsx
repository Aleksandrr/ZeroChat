/**
 * MediaRecordButton — Telegram-style media recording button.
 *
 * Gestures:
 *   - Short tap: toggle voice/video mode
 *   - Long press: start recording
 *   - Release: stop & send
 *   - Swipe up: lock recording (hands-free)
 *   - Swipe left: cancel
 *
 * When locked, shows a panel with Stop and Cancel buttons.
 * When recording, shows timer + swipe hints.
 *
 * Camera flip button appears in video mode.
 */

import { Mic, MicOff, Video, VideoOff, X, Lock, Camera, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { useIsMobile } from '@/hooks/use-mobile';
import { useMediaRecordGesture, type MediaMode } from '@/hooks/useMediaRecordGesture';
import { cn } from '@/lib/utils';

interface MediaRecordButtonProps {
  /** Current media mode (voice or video) */
  mode: MediaMode;
  /** Toggle between voice and video mode */
  onToggleMode: () => void;
  /** Start recording */
  onStartRecording: () => void;
  /** Stop recording and send (opens FileSendDialog) */
  onStopAndSend: () => void;
  /** Cancel recording (discard) */
  onCancel: () => void;
  /** Recording timer in seconds */
  recordingTime: number;
  /** Whether recording is currently active (from parent state) */
  isRecording: boolean;
  /** Whether video preview is shown (video mode only) */
  isVideoRecording: boolean;
  /** Camera flip handler (video mode only) */
  onFlipCamera?: () => void;
  /** Disabled state */
  disabled?: boolean;
}

function formatTime(seconds: number) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function MediaRecordButton({
  mode,
  onToggleMode,
  onStartRecording,
  onStopAndSend,
  onCancel,
  recordingTime,
  isRecording,
  isVideoRecording,
  onFlipCamera,
  disabled,
}: MediaRecordButtonProps) {
  const isMobile = useIsMobile();
  const buttonSize = isMobile ? 'h-11 w-11' : 'h-10 w-10';
  const iconSize = isMobile ? 'h-6 w-6' : 'h-5 w-5';

  const {
    state: gestureState,
    swipeDirection,
    swipeDistance,
    isLocked,
    handlers,
    stopLockedRecording,
    cancelLockedRecording,
  } = useMediaRecordGesture({
    onToggleMode,
    onStartRecording,
    onStopAndSend,
    onLock: () => {}, // Lock is handled internally
    onCancel,
    longPressDelay: 350,
    swipeThreshold: 50,
  });

  const isActivelyRecording = isRecording || isVideoRecording || gestureState === 'recording' || gestureState === 'locked';
  const isPressed = gestureState === 'pressing' || gestureState === 'recording';
  const showCancelHint = swipeDirection === 'left' && swipeDistance > 20;
  const showLockHint = swipeDirection === 'up' && swipeDistance > 20;

  // Auto-cancel when swipe distance exceeds threshold significantly
  useEffect(() => {
    if (swipeDirection === 'left' && swipeDistance > 120 && isActivelyRecording && !isLocked) {
      onCancel();
    }
  }, [swipeDirection, swipeDistance, isActivelyRecording, isLocked, onCancel]);

  // U9: removed dead useEffect that called stopLockedRecording() while in the
  // 'recording' gesture state. stopLockedRecording is a no-op unless
  // isLockedRef.current === true, which is only set in handleTouchEnd after a
  // successful swipe-up gesture — so this effect never had any effect. The
  // actual lock transition happens in useMediaRecordGesture.handleTouchEnd
  // (lines 135-139 of that file), and stopLockedRecording is still used by
  // the locked panel Stop button below.

  // Locked recording panel
  if (isLocked || gestureState === 'locked') {
    return (
      <div className="flex items-center gap-2 shrink-0">
        {/* Timer */}
        <div className="flex items-center gap-2 px-3 py-2 rounded-full bg-red-500/10 border border-red-500/20">
          <div className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" />
          <span className="text-sm font-medium text-red-500">
            {formatTime(recordingTime)}
          </span>
        </div>
        {/* Stop button */}
        <button
          type="button"
          onClick={stopLockedRecording}
          className={cn(
            'flex items-center justify-center rounded-full bg-primary text-primary-foreground hover:bg-primary/90 transition-colors',
            isMobile ? 'h-11 w-11' : 'h-10 w-10'
          )}
          title="Отправить"
        >
          <Square className={cn(isMobile ? 'h-5 w-5' : 'h-4 w-4', 'fill-current')} />
        </button>
        {/* Cancel button */}
        <button
          type="button"
          onClick={cancelLockedRecording}
          className={cn(
            'flex items-center justify-center rounded-full bg-destructive/10 text-destructive hover:bg-destructive/20 transition-colors',
            isMobile ? 'h-11 w-11' : 'h-10 w-10'
          )}
          title="Отменить"
        >
          <X className={iconSize} />
        </button>
      </div>
    );
  }

  // Recording indicator (not locked)
  if (isActivelyRecording) {
    return (
      <div className="flex items-center gap-1 shrink-0">
        {/* Cancel zone (visible when swiping left) */}
        {showCancelHint && (
          <div className="flex items-center gap-1 px-2 text-destructive">
            <X className="h-4 w-4" />
            <span className="text-xs font-medium">Отмена</span>
          </div>
        )}
        {/* Lock zone (visible when swiping up) */}
        {showLockHint && (
          <div className="flex items-center gap-1 px-2 text-amber-500">
            <Lock className="h-4 w-4" />
            <span className="text-xs font-medium">Блок</span>
          </div>
        )}
        {/* Main recording button */}
        <button
          type="button"
          {...handlers}
          disabled={disabled}
          className={cn(
            'flex items-center justify-center rounded-full transition-all shrink-0 select-none touch-none',
            buttonSize,
            isPressed ? 'bg-red-500/20 scale-110' : 'bg-red-500/10',
            swipeDirection === 'left' && 'translate-x-[-20px]',
            swipeDirection === 'up' && '-translate-y-[10px]',
          )}
          title={mode === 'voice' ? 'Запись голосового' : 'Запись видео'}
        >
          {mode === 'voice' ? (
            <Mic className={cn(iconSize, 'text-red-500 animate-pulse')} />
          ) : (
            <Video className={cn(iconSize, 'text-red-500 animate-pulse')} />
          )}
        </button>
        {/* Camera flip button (video mode only) */}
        {mode === 'video' && onFlipCamera && (
          <button
            type="button"
            onClick={onFlipCamera}
            className={cn(
              'flex items-center justify-center rounded-full bg-muted hover:bg-muted/80 transition-colors shrink-0',
              isMobile ? 'h-9 w-9' : 'h-8 w-8'
            )}
            title="Сменить камеру"
          >
            <Camera className={isMobile ? 'h-5 w-5' : 'h-4 w-4 text-muted-foreground'} />
          </button>
        )}
      </div>
    );
  }

  // Idle state — show mode toggle button
  return (
    <button
      type="button"
      {...handlers}
      disabled={disabled}
      className={cn(
        'flex items-center justify-center rounded-full transition-all shrink-0 select-none touch-none',
        buttonSize,
        'text-muted-foreground hover:text-foreground hover:bg-muted/50',
        isPressed && 'scale-90',
      )}
      title={mode === 'voice' ? 'Голосовое (удерживайте для записи)' : 'Видео (удерживайте для записи)'}
    >
      {mode === 'voice' ? <Mic className={iconSize} /> : <Video className={iconSize} />}
    </button>
  );
}
