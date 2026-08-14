/**
 * CallOverlay — full-screen call UI (incoming + active call).
 *
 * Shows:
 *   - Incoming call: caller name, avatar, Accept/Reject buttons
 *   - Active call: local + remote video, call timer, controls (mute/camera/flip/end)
 *   - Audio call: avatar + waveform animation + controls
 */

import { Mic, MicOff, Phone, PhoneOff, Video, VideoOff, Camera, User } from 'lucide-react';
import { useEffect } from 'react';
import { useCall } from '@/contexts/CallContext';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function CallOverlay() {
  const {
    callState,
    callType,
    remoteUserName,
    callDuration,
    incomingCall,
    localVideoRef,
    remoteVideoRef,
    isMuted,
    isCameraOff,
    acceptCall,
    rejectCall,
    endCall,
    toggleMute,
    toggleCamera,
    flipCamera,
  } = useCall();
  const isMobile = useIsMobile();

  // Don't render if no call activity
  if (callState === 'idle' && !incomingCall) return null;

  // ==================== Incoming Call ====================
  if (incomingCall) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-background/95 backdrop-blur-md">
        <div className="flex flex-col items-center gap-6">
          {/* Avatar */}
          <div className={cn(
            'rounded-full bg-primary/10 flex items-center justify-center',
            isMobile ? 'w-24 h-24' : 'w-28 h-28'
          )}>
            <User className={cn('text-primary', isMobile ? 'h-12 w-12' : 'h-14 w-14')} />
          </div>

          {/* Caller info */}
          <div className="text-center">
            <p className="text-muted-foreground text-sm mb-1">
              {incomingCall.callType === 'video' ? '📹 Видеозвонок' : '📞 Звонок'}
            </p>
            <h2 className={cn('font-semibold', isMobile ? 'text-xl' : 'text-2xl')}>
              {remoteUserName || incomingCall.callerName}
            </h2>
            <p className="text-muted-foreground text-sm mt-1">Входящий звонок...</p>
          </div>

          {/* Actions */}
          <div className="flex gap-8">
            {/* Reject */}
            <button
              onClick={rejectCall}
              className="flex flex-col items-center gap-2"
            >
              <div className={cn(
                'rounded-full bg-red-500 hover:bg-red-600 flex items-center justify-center text-white transition-colors',
                isMobile ? 'w-16 h-16' : 'w-14 h-14'
              )}>
                <PhoneOff className={isMobile ? 'h-7 w-7' : 'h-6 w-6'} />
              </div>
              <span className="text-xs text-muted-foreground">Отклонить</span>
            </button>

            {/* Accept */}
            <button
              onClick={acceptCall}
              className="flex flex-col items-center gap-2"
            >
              <div className={cn(
                'rounded-full bg-green-500 hover:bg-green-600 flex items-center justify-center text-white transition-colors animate-pulse',
                isMobile ? 'w-16 h-16' : 'w-14 h-14'
              )}>
                {incomingCall.callType === 'video'
                  ? <Video className={isMobile ? 'h-7 w-7' : 'h-6 w-6'} />
                  : <Phone className={isMobile ? 'h-7 w-7' : 'h-6 w-6'} />}
              </div>
              <span className="text-xs text-muted-foreground">Принять</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ==================== Active Call ====================
  const isActive = callState === 'active' || callState === 'connecting';

  if (!isActive) return null;

  const isVideoCall = callType === 'video';

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black">
      {/* Remote video (full screen for video calls) */}
      {isVideoCall && (
        <video
          ref={remoteVideoRef}
          autoPlay
          playsInline
          className="absolute inset-0 w-full h-full object-cover"
        />
      )}

      {/* For audio calls: show avatar */}
      {!isVideoCall && (
        <div className="flex-1 flex flex-col items-center justify-center gap-6">
          <div className={cn(
            'rounded-full bg-primary/20 flex items-center justify-center animate-pulse',
            isMobile ? 'w-32 h-32' : 'w-40 h-40'
          )}>
            <User className={cn('text-primary', isMobile ? 'h-16 w-16' : 'h-20 w-20')} />
          </div>
          <h2 className="text-white text-xl font-semibold">{remoteUserName}</h2>
          <p className="text-white/60 text-sm">
            {callState === 'connecting' ? 'Соединение...' : formatDuration(callDuration)}
          </p>
        </div>
      )}

      {/* Top bar: name + duration */}
      <div className="absolute top-0 left-0 right-0 p-4 flex items-center justify-between z-10">
        <div className="flex items-center gap-3">
          <div className={cn(
            'rounded-full bg-white/10 backdrop-blur-sm flex items-center justify-center',
            isMobile ? 'w-10 h-10' : 'w-12 h-12'
          )}>
            <User className="text-white/80 h-5 w-5" />
          </div>
          <div>
            <p className="text-white font-medium text-sm">{remoteUserName}</p>
            <p className="text-white/60 text-xs">
              {callState === 'connecting' ? 'Соединение...' : formatDuration(callDuration)}
            </p>
          </div>
        </div>
      </div>

      {/* Local video (picture-in-picture) */}
      {isVideoCall && (
        <div className={cn(
          'absolute bottom-24 right-4 rounded-lg overflow-hidden border-2 border-white/20 z-10',
          isMobile ? 'w-24 h-32' : 'w-32 h-44'
        )}>
          <video
            ref={localVideoRef}
            autoPlay
            playsInline
            muted
            className="w-full h-full object-cover"
          />
        </div>
      )}

      {/* Bottom controls */}
      <div className="absolute bottom-0 left-0 right-0 p-6 flex items-center justify-center gap-4 z-10">
        {/* Mute */}
        <button
          onClick={toggleMute}
          className={cn(
            'rounded-full flex items-center justify-center transition-colors',
            isMobile ? 'w-14 h-14' : 'w-12 h-12',
            isMuted ? 'bg-white text-black' : 'bg-white/10 text-white hover:bg-white/20'
          )}
          title={isMuted ? 'Включить микрофон' : 'Выключить микрофон'}
        >
          {isMuted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
        </button>

        {/* Camera toggle (video calls only) */}
        {isVideoCall && (
          <button
            onClick={toggleCamera}
            className={cn(
              'rounded-full flex items-center justify-center transition-colors',
              isMobile ? 'w-14 h-14' : 'w-12 h-12',
              isCameraOff ? 'bg-white text-black' : 'bg-white/10 text-white hover:bg-white/20'
            )}
            title={isCameraOff ? 'Включить камеру' : 'Выключить камеру'}
          >
            {isCameraOff ? <VideoOff className="h-5 w-5" /> : <Video className="h-5 w-5" />}
          </button>
        )}

        {/* Flip camera (video calls, mobile only) */}
        {isVideoCall && isMobile && (
          <button
            onClick={flipCamera}
            className="w-12 h-12 rounded-full bg-white/10 text-white hover:bg-white/20 flex items-center justify-center transition-colors"
            title="Сменить камеру"
          >
            <Camera className="h-5 w-5" />
          </button>
        )}

        {/* End call */}
        <button
          onClick={endCall}
          className={cn(
            'rounded-full bg-red-500 hover:bg-red-600 text-white flex items-center justify-center transition-colors',
            isMobile ? 'w-16 h-16' : 'w-14 h-14'
          )}
          title="Завершить звонок"
        >
          <PhoneOff className={isMobile ? 'h-7 w-7' : 'h-6 w-6'} />
        </button>
      </div>
    </div>
  );
}
