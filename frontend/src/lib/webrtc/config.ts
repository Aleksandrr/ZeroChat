/**
 * WebRTC Configuration — STUN/TURN servers.
 *
 * STUN: Used for NAT traversal (discovering public IP/port).
 * TURN: Used as relay when direct P2P fails (symmetric NAT, firewall).
 *
 * For development: Google's public STUN servers (free, no auth).
 * For production: deploy coturn and set VITE_TURN_URL env var.
 *
 * WebRTC media is encrypted via DTLS-SRTP (built-in, always on).
 * The signaling layer (SDP/ICE exchange through WebSocket) is NOT
 * encrypted by Signal Protocol — this is standard practice.
 * The media stream itself is always E2EE via DTLS-SRTP.
 */

export interface RTCConfig {
  iceServers: RTCIceServer[];
}

const DEV_STUN_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
];

function getProdIceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [...DEV_STUN_SERVERS];
  const turnUrl = (import.meta as any).env?.VITE_TURN_URL;
  const turnUser = (import.meta as any).env?.VITE_TURN_USER;
  const turnPass = (import.meta as any).env?.VITE_TURN_PASS;
  if (turnUrl && turnUser && turnPass) {
    servers.push({ urls: [turnUrl], username: turnUser, credential: turnPass });
  }
  return servers;
}

export const RTC_CONFIG: RTCConfig = {
  iceServers: (import.meta as any).env?.DEV === 'false' ? getProdIceServers() : DEV_STUN_SERVERS,
};

export const MEDIA_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  } as MediaTrackConstraints,
  video: {
    facingMode: 'user',
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30, max: 30 },
  } as MediaTrackConstraints,
};

export const VIDEO_CONSTRAINTS_MOBILE: MediaStreamConstraints = {
  audio: MEDIA_CONSTRAINTS.audio,
  video: {
    facingMode: 'user',
    width: { ideal: 640 },
    height: { ideal: 480 },
    frameRate: { ideal: 24, max: 24 },
  } as MediaTrackConstraints,
};
