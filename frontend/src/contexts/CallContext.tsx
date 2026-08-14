/**
 * CallContext — React context for WebRTC call management.
 *
 * Provides:
 *   - startCall(userId, callType) — initiate a call
 *   - acceptCall() — accept incoming call
 *   - rejectCall() — reject incoming call
 *   - endCall() — end current call
 *   - toggleMute() / toggleCamera() / flipCamera()
 *   - call state (idle, offering, incoming, connecting, active)
 *   - local/remote video refs for rendering
 *
 * Subscribes to WebSocket call signaling events (call_offer, call_answer,
 * call_ice, call_end, call_reject, call_busy) and routes them to CallManager.
 */

import { Phone, PhoneOff, Video, VideoOff } from 'lucide-react';
import React, { createContext, useCallback, useContext, useEffect, useRef,useState } from 'react';

import { useAuth } from '@/contexts/AuthContext';
import { useWebSocketContext } from '@/contexts/WebSocketContext';
import { toast } from '@/components/ui/toast';
import { CallManager, type CallState, type CallType } from '@/lib/webrtc/CallManager';

interface IncomingCallData {
  callId: string;
  callerId: string;
  callerName: string;
  callType: CallType;
  sdp?: string;
  chatId?: string;
}

interface CallContextType {
  callState: CallState;
  callType: CallType | null;
  remoteUserName: string;
  callDuration: number;
  incomingCall: IncomingCallData | null;
  localVideoRef: React.RefObject<HTMLVideoElement | null>;
  remoteVideoRef: React.RefObject<HTMLVideoElement | null>;
  isMuted: boolean;
  isCameraOff: boolean;
  startCall: (userId: string, userName: string, callType: CallType, chatId?: string) => Promise<void> | void;
  acceptCall: () => Promise<void> | void;
  rejectCall: () => void;
  endCall: () => void;
  toggleMute: () => void;
  toggleCamera: () => void;
  flipCamera: () => void;
}

const CallContext = createContext<CallContextType | null>(null);

export function CallProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const { send, subscribe } = useWebSocketContext();
  const [callState, setCallState] = useState<CallState>('idle');
  const [callType, setCallType] = useState<CallType | null>(null);
  const [remoteUserName, setRemoteUserName] = useState('');
  const [callDuration, setCallDuration] = useState(0);
  const [incomingCall, setIncomingCall] = useState<IncomingCallData | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isCameraOff, setIsCameraOff] = useState(false);

  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const callManagerRef = useRef<CallManager | null>(null);
  // Mirror incomingCall into a ref so the subscribe effect can read the latest
  // value without re-subscribing on every state change (which would drop
  // WebSocket messages during the re-subscribe window).
  const incomingCallRef = useRef<IncomingCallData | null>(null);
  useEffect(() => {
    incomingCallRef.current = incomingCall;
  }, [incomingCall]);

  // Initialize CallManager
  useEffect(() => {
    const isMobile = window.matchMedia('(max-width: 768px)').matches;
    callManagerRef.current = new CallManager({
      onSendOffer: (callId, remoteUserId, sdp, type) => {
        void send('call_offer', {
          callId, recipientId: remoteUserId, callerId: user?.id,
          callerName: user?.username, callType: type, sdp,
        });
      },
      onSendAnswer: (callId, remoteUserId, sdp) => {
        void send('call_answer', { callId, callerId: remoteUserId, answer: sdp });
      },
      onSendIce: (callId, remoteUserId, candidate) => {
        void send('call_ice', { callId, candidate, toUserId: remoteUserId });
      },
      onSendEnd: (callId, remoteUserId, reason) => {
        void send('call_end', { callId, recipientId: remoteUserId, reason });
      },
      onSendReject: (callId, remoteUserId) => {
        void send('call_reject', { callId, callerId: remoteUserId });
      },
      onSendBusy: (callId, remoteUserId) => {
        void send('call_busy', { callId, callerId: remoteUserId });
      },
      onStateChange: (state) => setCallState(state),
      onRemoteStream: (stream) => {
        if (remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = stream;
        }
      },
      onCallDuration: (seconds) => setCallDuration(seconds),
    }, isMobile);

    return () => {
      callManagerRef.current?.endCall();
    };
  }, [send, user]);

  // Attach local stream to video element when it becomes available
  useEffect(() => {
    if (callState === 'connecting' || callState === 'active') {
      const session = callManagerRef.current?.currentSession;
      if (session?.localStream && localVideoRef.current) {
        localVideoRef.current.srcObject = session.localStream;
      }
    }
  }, [callState]);

  // Subscribe to call signaling events
  useEffect(() => {
    const unsubOffer = subscribe('call_offer', (msg: any) => {
      const p = msg.payload;
      // If already in a call OR already have an incoming call pending — send busy
      // and DO NOT overwrite incomingCall state. This prevents caller A from
      // being left without any answer when caller C sends a second offer.
      if (callManagerRef.current?.isInCall || incomingCallRef.current) {
        if (p?.callId && p?.callerId) {
          void send('call_busy', { callId: p.callId, callerId: p.callerId });
        }
        return;
      }
      setIncomingCall({
        callId: p.callId,
        callerId: p.callerId,
        callerName: p.callerName,
        callType: p.callType,
        sdp: p.sdp,
        chatId: p.chatId,
      });
    });

    const unsubAnswer = subscribe('call_answer', (msg: any) => {
      const currentCallId = callManagerRef.current?.currentCallId;
      const incomingCallId = msg.payload?.callId;
      // Filter out answers that belong to a different (stale) call
      if (incomingCallId && currentCallId && incomingCallId !== currentCallId) {
        return;
      }
      void callManagerRef.current?.handleAnswer(msg.payload.answer);
    });

    const unsubIce = subscribe('call_ice', (msg: any) => {
      const currentCallId = callManagerRef.current?.currentCallId;
      const incomingCallId = msg.payload?.callId;
      // Filter out ICE candidates that belong to a different (stale) call
      if (incomingCallId && currentCallId && incomingCallId !== currentCallId) {
        return;
      }
      void callManagerRef.current?.handleIceCandidate(msg.payload.candidate);
    });

    const unsubEnd = subscribe('call_end', (msg: any) => {
      const currentCallId = callManagerRef.current?.currentCallId;
      const incomingCallId = msg.payload?.callId;
      // Ignore call_end for a different call — protects against late/stale messages
      if (incomingCallId && currentCallId && incomingCallId !== currentCallId) {
        return;
      }
      // Use handleRemoteEnd (NOT endCall) — sets isRemoteEnded flag so
      // CallManager.cleanup() won't send another call_end back (cascade guard)
      callManagerRef.current?.handleRemoteEnd();
      setIncomingCall(null);
      setCallState('idle');
    });

    const unsubReject = subscribe('call_reject', (msg: any) => {
      const currentCallId = callManagerRef.current?.currentCallId;
      const incomingCallId = msg.payload?.callId;
      if (incomingCallId && currentCallId && incomingCallId !== currentCallId) {
        return;
      }
      callManagerRef.current?.handleRemoteEnd();
      setIncomingCall(null);
      setCallState('idle');
    });

    const unsubBusy = subscribe('call_busy', (msg: any) => {
      const currentCallId = callManagerRef.current?.currentCallId;
      const incomingCallId = msg.payload?.callId;
      if (incomingCallId && currentCallId && incomingCallId !== currentCallId) {
        return;
      }
      callManagerRef.current?.handleRemoteEnd();
      setIncomingCall(null);
      setCallState('idle');
      toast.error('Звонок отклонён', 'Собеседник занят');
    });

    return () => {
      unsubOffer(); unsubAnswer(); unsubIce();
      unsubEnd(); unsubReject(); unsubBusy();
    };
  }, [subscribe, send]);

  // ==================== Actions ====================

  const startCall = useCallback(async (userId: string, userName: string, type: CallType, chatId?: string) => {
    const callId = crypto.randomUUID();
    setCallType(type);
    setRemoteUserName(userName);
    setCallDuration(0);
    try {
      await callManagerRef.current?.startCall(callId, userId, userName, type, chatId);
    } catch (err) {
      console.error('[CallContext] startCall failed:', err);
      const msg = err instanceof Error && err.name === 'NotAllowedError'
        ? 'Доступ к микрофону/камере запрещён'
        : err instanceof Error && err.name === 'NotFoundError'
          ? 'Микрофон/камера не найдены'
          : 'Не удалось начать звонок';
      toast.error('Ошибка звонка', msg);
      setCallState('idle');
    }
  }, []);

  const acceptCall = useCallback(async () => {
    if (!incomingCall || !callManagerRef.current) return;
    setCallType(incomingCall.callType);
    setRemoteUserName(incomingCall.callerName);
    setCallDuration(0);
    try {
      await callManagerRef.current.acceptCall(
        incomingCall.callId,
        incomingCall.callerId,
        incomingCall.callerName,
        incomingCall.callType,
        incomingCall.sdp || '',
      );
      setIncomingCall(null);
    } catch (err) {
      console.error('[CallContext] acceptCall failed:', err);
      const msg = err instanceof Error && err.name === 'NotAllowedError'
        ? 'Доступ к микрофону/камере запрещён'
        : err instanceof Error && err.name === 'NotFoundError'
          ? 'Микрофон/камера не найдены'
          : 'Не удалось принять звонок';
      toast.error('Ошибка звонка', msg);
      setIncomingCall(null);
      setCallState('idle');
    }
  }, [incomingCall]);

  const rejectCall = useCallback(() => {
    if (!incomingCall) return;
    callManagerRef.current?.rejectCall();
    setIncomingCall(null);
  }, [incomingCall]);

  const endCall = useCallback(() => {
    callManagerRef.current?.endCall();
    setIncomingCall(null);
  }, []);

  const toggleMute = useCallback(() => {
    const muted = callManagerRef.current?.toggleMute() ?? false;
    setIsMuted(muted);
  }, []);

  const toggleCamera = useCallback(() => {
    const off = callManagerRef.current?.toggleCamera() ?? false;
    setIsCameraOff(off);
  }, []);

  const flipCamera = useCallback(() => {
    void callManagerRef.current?.flipCamera();
  }, []);

  return (
    <CallContext.Provider value={{
      callState,
      callType,
      remoteUserName,
      callDuration,
      incomingCall,
      localVideoRef,
      remoteVideoRef,
      isMuted,
      isCameraOff,
      startCall,
      acceptCall,
      rejectCall,
      endCall,
      toggleMute,
      toggleCamera,
      flipCamera,
    }}>
      {children}
    </CallContext.Provider>
  );
}

export function useCall(): CallContextType {
  const ctx = useContext(CallContext);
  if (!ctx) throw new Error('useCall must be used within CallProvider');
  return ctx;
}
