/**
 * CallManager — manages WebRTC RTCPeerConnection lifecycle.
 *
 * Responsibilities:
 *   - Create RTCPeerConnection with STUN/TURN config
 *   - Manage local media stream (getUserMedia)
 *   - Create/set SDP offers and answers
 *   - Exchange ICE candidates (trickle ICE)
 *   - Render local and remote media to <video> elements
 *   - Handle call state transitions
 *
 * Encryption:
 *   - Media: DTLS-SRTP (built-in WebRTC, always on)
 *   - Signaling: sent through WS relay (SDP/ICE in cleartext — standard)
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API
 * @see https://webrtc.org/getting-started/peer-connections
 */

import { RTC_CONFIG, MEDIA_CONSTRAINTS, VIDEO_CONSTRAINTS_MOBILE } from './config';

export type CallState = 'idle' | 'offering' | 'incoming' | 'connecting' | 'active' | 'ended' | 'failed';
export type CallType = 'audio' | 'video';

export interface CallSession {
  callId: string;
  remoteUserId: string;
  remoteUserName: string;
  callType: CallType;
  state: CallState;
  isCaller: boolean;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  callDuration: number;
}

type SignalingCallbacks = {
  onSendOffer: (callId: string, remoteUserId: string, sdp: string, callType: CallType) => void;
  onSendAnswer: (callId: string, remoteUserId: string, sdp: string) => void;
  onSendIce: (callId: string, remoteUserId: string, candidate: string) => void;
  onSendEnd: (callId: string, remoteUserId: string, reason: string) => void;
  onSendReject: (callId: string, remoteUserId: string) => void;
  onSendBusy: (callId: string, remoteUserId: string) => void;
  onStateChange: (state: CallState) => void;
  onRemoteStream: (stream: MediaStream) => void;
  onCallDuration: (seconds: number) => void;
};

export class CallManager {
  private pc: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private session: CallSession | null = null;
  private callbacks: SignalingCallbacks;
  private durationTimer: ReturnType<typeof setInterval> | null = null;
  private isMobile: boolean;

  /**
   * ICE candidates that arrived BEFORE setRemoteDescription was called.
   * They are drained immediately after remoteDescription is set.
   * Without buffering, calling addIceCandidate before setRemoteDescription
   * throws InvalidStateError in WebRTC.
   */
  private pendingIceCandidates: RTCIceCandidateInit[] = [];

  /**
   * Flag set when we received a `call_end` (or busy/reject) from the remote
   * peer. Prevents `endCall()` from sending another `call_end` back, which
   * would otherwise cascade into an infinite loop of call_end messages.
   */
  private isRemoteEnded: boolean = false;

  constructor(callbacks: SignalingCallbacks, isMobile = false) {
    this.callbacks = callbacks;
    this.isMobile = isMobile;
  }

  get currentSession(): CallSession | null {
    return this.session;
  }

  /**
   * Current callId (used by CallContext to filter incoming signaling events
   * that belong to a different/stale call).
   */
  get currentCallId(): string | null {
    return this.session?.callId ?? null;
  }

  get isInCall(): boolean {
    return this.session?.state === 'active' || this.session?.state === 'connecting';
  }

  /**
   * Initiate a call (caller side).
   * 1. Get local media stream
   * 2. Create RTCPeerConnection
   * 3. Add local tracks
   * 4. Create SDP offer
   * 5. Send offer through signaling
   */
  async startCall(
    callId: string,
    remoteUserId: string,
    remoteUserName: string,
    callType: CallType,
    chatId?: string,
  ): Promise<void> {
    if (this.session) {
      throw new Error('Already in a call');
    }

    this.session = {
      callId,
      remoteUserId,
      remoteUserName,
      callType,
      state: 'offering',
      isCaller: true,
      localStream: null,
      remoteStream: null,
      callDuration: 0,
    };

    // Reset remote-ended flag for a fresh call session
    this.isRemoteEnded = false;
    this.pendingIceCandidates = [];

    try {
      // 1. Get local media
      const constraints = callType === 'video'
        ? (this.isMobile ? VIDEO_CONSTRAINTS_MOBILE : MEDIA_CONSTRAINTS)
        : { audio: true, video: false };
      this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
      this.session.localStream = this.localStream;

      // 2. Create peer connection
      this.pc = this.createPeerConnection();

      // 3. Add local tracks
      for (const track of this.localStream.getTracks()) {
        this.pc.addTrack(track, this.localStream);
      }

      // 4. Create SDP offer
      const offer = await this.pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: callType === 'video',
      });
      await this.pc.setLocalDescription(offer);

      // 5. Send offer
      this.callbacks.onSendOffer(callId, remoteUserId, offer.sdp!, callType);
      this.setCallState('connecting');
    } catch (error) {
      console.error('[CallManager] Failed to start call:', error);
      this.setCallState('failed');
      this.cleanup();
      throw error;
    }
  }

  /**
   * Accept an incoming call (callee side).
   * 1. Get local media stream
   * 2. Create RTCPeerConnection
   * 3. Set remote description (SDP offer)
   * 4. Create SDP answer
   * 5. Send answer through signaling
   */
  async acceptCall(
    callId: string,
    remoteUserId: string,
    remoteUserName: string,
    callType: CallType,
    remoteSdp: string,
  ): Promise<void> {
    this.session = {
      callId,
      remoteUserId,
      remoteUserName,
      callType,
      state: 'incoming',
      isCaller: false,
      localStream: null,
      remoteStream: null,
      callDuration: 0,
    };

    // Reset remote-ended flag for a fresh call session
    this.isRemoteEnded = false;
    this.pendingIceCandidates = [];

    try {
      const constraints = callType === 'video'
        ? (this.isMobile ? VIDEO_CONSTRAINTS_MOBILE : MEDIA_CONSTRAINTS)
        : { audio: true, video: false };
      this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
      this.session.localStream = this.localStream;

      this.pc = this.createPeerConnection();
      for (const track of this.localStream.getTracks()) {
        this.pc.addTrack(track, this.localStream);
      }

      // Set remote offer
      await this.pc.setRemoteDescription({ type: 'offer', sdp: remoteSdp });
      // Drain pending ICE candidates that arrived before the remote offer was set
      await this.drainPendingIceCandidates();

      // Create answer
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);

      this.callbacks.onSendAnswer(callId, remoteUserId, answer.sdp!);
      this.setCallState('connecting');
    } catch (error) {
      console.error('[CallManager] Failed to accept call:', error);
      this.setCallState('failed');
      this.cleanup();
      throw error;
    }
  }

  /**
   * Handle SDP answer from remote (caller side).
   */
  async handleAnswer(sdp: string): Promise<void> {
    if (!this.pc) return;
    try {
      await this.pc.setRemoteDescription({ type: 'answer', sdp });
      // Drain pending ICE candidates that arrived before the answer was set
      await this.drainPendingIceCandidates();
    } catch (error) {
      console.error('[CallManager] Failed to set remote answer:', error);
    }
  }

  /**
   * Handle ICE candidate from remote.
   *
   * If the remote description is not set yet (offer/answer hasn't arrived),
   * buffer the candidate and apply it later. This prevents InvalidStateError
   * from `addIceCandidate` being called too early — a common issue with
   * trickle ICE when signaling transport reorders messages.
   */
  async handleIceCandidate(candidateJson: string): Promise<void> {
    let candidate: RTCIceCandidateInit;
    try {
      candidate = JSON.parse(candidateJson) as RTCIceCandidateInit;
    } catch (error) {
      console.error('[CallManager] Failed to parse ICE candidate JSON:', error);
      return;
    }

    if (this.pc && this.pc.remoteDescription) {
      try {
        await this.pc.addIceCandidate(candidate);
      } catch (error) {
        console.error('[CallManager] addIceCandidate failed:', error);
      }
    } else {
      this.pendingIceCandidates.push(candidate);
    }
  }

  /**
   * Apply all buffered ICE candidates. Called immediately after
   * setRemoteDescription in handleOffer/handleAnswer/acceptCall.
   */
  private async drainPendingIceCandidates(): Promise<void> {
    if (!this.pc || this.pendingIceCandidates.length === 0) return;
    const queued = this.pendingIceCandidates;
    this.pendingIceCandidates = [];
    for (const candidate of queued) {
      try {
        await this.pc.addIceCandidate(candidate);
      } catch (error) {
        console.error('[CallManager] drain ICE candidate failed:', error);
      }
    }
  }

  /**
   * Reject an incoming call.
   */
  rejectCall(): void {
    if (!this.session) return;
    this.callbacks.onSendReject(this.session.callId, this.session.remoteUserId);
    this.cleanup();
  }

  /**
   * Mark the call as ended by the REMOTE peer.
   *
   * Sets the `isRemoteEnded` flag so that a subsequent local `endCall()`
   * (e.g. triggered by the connection-state machine or by the user clicking
   * "Hang up") will NOT send another `call_end` message back, which would
   * otherwise cause a cascade of `call_end` messages bouncing between peers.
   */
  handleRemoteEnd(): void {
    this.isRemoteEnded = true;
    this.cleanup();
  }

  /**
   * End the current call (local user action or local connection failure).
   *
   * If the remote peer already sent `call_end` (or busy/reject), we do NOT
   * send another `call_end` back — the remote already knows the call is over.
   */
  endCall(reason: 'ended' | 'failed' = 'ended'): void {
    if (!this.session) return;
    if (this.isRemoteEnded) {
      // Remote already ended the call — don't echo `call_end` back (cascade guard)
      this.cleanup();
      return;
    }
    this.callbacks.onSendEnd(this.session.callId, this.session.remoteUserId, reason);
    this.cleanup();
  }

  /**
   * Toggle microphone mute.
   */
  toggleMute(): boolean {
    if (!this.localStream) return false;
    const audioTrack = this.localStream.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled;
      return !audioTrack.enabled; // returns true if now muted
    }
    return false;
  }

  /**
   * Toggle camera on/off (video calls only).
   */
  toggleCamera(): boolean {
    if (!this.localStream) return false;
    const videoTrack = this.localStream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.enabled = !videoTrack.enabled;
      return !videoTrack.enabled; // returns true if now off
    }
    return false;
  }

  /**
   * Switch between front and back camera (mobile).
   */
  async flipCamera(): Promise<void> {
    if (!this.localStream || !this.session) return;
    const videoTrack = this.localStream.getVideoTracks()[0];
    if (!videoTrack) return;

    const currentFacing = videoTrack.getSettings().facingMode;
    const newFacing = currentFacing === 'user' ? 'environment' : 'user';

    // Stop current video track
    videoTrack.stop();

    // Get new video stream with opposite camera
    const newStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: newFacing },
      audio: false,
    });
    const newVideoTrack = newStream.getVideoTracks()[0];
    if (!newVideoTrack) return;

    // Replace track in the stream
    this.localStream.removeTrack(videoTrack);
    this.localStream.addTrack(newVideoTrack);

    // Replace track in the peer connection
    if (this.pc) {
      const sender = this.pc.getSenders().find(s => s.track?.kind === 'video');
      if (sender) {
        await sender.replaceTrack(newVideoTrack);
      }
    }
  }

  // ==================== Private Methods ====================

  private createPeerConnection(): RTCPeerConnection {
    const pc = new RTCPeerConnection(RTC_CONFIG);

    // Handle ICE candidates
    pc.onicecandidate = (event) => {
      if (event.candidate && this.session) {
        this.callbacks.onSendIce(
          this.session.callId,
          this.session.remoteUserId,
          JSON.stringify(event.candidate.toJSON()),
        );
      }
    };

    // Handle connection state changes
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === 'connected') {
        this.setCallState('active');
        this.startDurationTimer();
      } else if (state === 'disconnected' || state === 'failed') {
        this.setCallState('failed');
        this.endCall('failed');
      } else if (state === 'closed') {
        this.cleanup();
      }
    };

    // Handle incoming remote stream
    pc.ontrack = (event) => {
      const stream = event.streams[0];
      if (stream) {
        this.remoteStream = stream;
        if (this.session) {
          this.session.remoteStream = stream;
        }
        this.callbacks.onRemoteStream(stream);
      }
    };

    return pc;
  }

  private setCallState(state: CallState): void {
    if (this.session) {
      this.session.state = state;
      this.callbacks.onStateChange(state);
    }
  }

  private startDurationTimer(): void {
    if (this.durationTimer) clearInterval(this.durationTimer);
    let seconds = 0;
    this.durationTimer = setInterval(() => {
      seconds++;
      if (this.session) this.session.callDuration = seconds;
      this.callbacks.onCallDuration(seconds);
    }, 1000);
  }

  private cleanup(): void {
    if (this.durationTimer) {
      clearInterval(this.durationTimer);
      this.durationTimer = null;
    }
    if (this.localStream) {
      this.localStream.getTracks().forEach(t => t.stop());
      this.localStream = null;
    }
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
    this.remoteStream = null;
    this.session = null;
    // Discard any buffered ICE candidates — they belong to a defunct session
    this.pendingIceCandidates = [];
    this.setCallState('ended');
  }
}
