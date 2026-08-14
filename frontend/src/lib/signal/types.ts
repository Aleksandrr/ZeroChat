/**
 * Signal Protocol Types for ZeroChat-TS
 * Implements Sesame algorithm for multi-device state management
 */

// ==================== Basic Types ====================

export interface IdentityKeyData {
  id: string;
  userId: string;
  publicKey: string;
  privateKey: string;
  createdAt: number;
  nextPreKeyId?: number;
  nextSignedPreKeyId?: number;
  nextKyberPreKeyId?: number;
}

export interface RegistrationData {
  userId: string;
  registrationId: number;
  identityKey: string;
  deviceId: number;
  preKeyIdOffset: number;
  signedPreKeyIdOffset: number;
  kyberPreKeyIdOffset: number;
}

export interface PreKeyRecord {
  id: number;
  publicKey: string;
  privateKey?: string;  // Optional - may be empty if record is stored
  record?: string;      // WASM record for import
  createdAt: number;
}

export interface SignedPreKeyRecord {
  id: number;
  publicKey: string;
  privateKey: string;
  signature: string;
  createdAt: number;
}

export interface KyberPreKeyRecord {
  id: number;
  publicKey: string;
  privateKey: string;
  signature: string;
  createdAt: number;
}

// ==================== Sesame State Types ====================

export interface SessionState {
  id: string;
  recipientId: string;
  recipientDeviceId: number;
  sessionState: string;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export interface DeviceRecord {
  userId: string;
  deviceId: number;
  identityKey: Uint8Array;
  activeSession: SessionState | null;
  inactiveSessions: SessionState[];
  isStale: boolean;
  staleSince?: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * UserRecord for Sesame algorithm - using Record instead of Map for JSON serialization
 * Changed from Map<number, DeviceRecord> to Record<number, DeviceRecord>
 */
export interface UserRecord {
  userId: string;
  devices: Record<number, DeviceRecord>;  // Changed from Map to Record for JSON serialization
  isStale: boolean;
  staleSince?: number;
  createdAt: number;
  updatedAt: number;
}

export interface SenderKeyRecord {
  id: string;
  groupId: string;
  senderUserId: string;
  senderKeyId: number;
  senderKeyState: string;
  createdAt: number;
  updatedAt: number;
}

// Multi-device linked devices (for syncing)
export interface LinkedDevice {
  deviceId: number;
  identityKey: Uint8Array;
  name: string;
  createdAt: number;
  lastSeenAt: number;
}

// ==================== SignalClient State Types ====================

/**
 * SignalClient persistent state stored in IndexedDB
 * Stores the minimum required data to restore SignalClient after page reload
 */
export interface SignalClientState {
  userId: string;
  identityKeyPair: {
    publicKey: Uint8Array;
    privateKey: Uint8Array;
  };
  registrationId: number;
  deviceId: number;
  nextPreKeyId: number;
  nextSignedPreKeyId: number;
  nextKyberPreKeyId: number;
  localDeviceUuid: string;
  createdAt: number;
  updatedAt: number;
}

export interface LinkingRequest {
  linkingId: string;
  userId: string;
  identityKey: Uint8Array;
  ephemeralPublicKey: Uint8Array;
  createdAt: number;
  expiresAt: number;
}

// ==================== Message Types ====================

export interface EncryptedMessage {
  type: number;
  body: Uint8Array;
  senderUserId: string;
  senderDeviceId: number;
  messageId?: string;
}

export interface DecryptedMessage {
  type: number;
  body: Uint8Array;
  senderUserId: string;
  senderDeviceId: number;
}

export interface PreKeyBundle {
  registrationId: number;
  deviceId: number;
  identityKey: Uint8Array;
  signedPreKey: Uint8Array;
  signedPreKeyId: number;
  signedPreKeySignature: Uint8Array;
  preKey?: Uint8Array;
  preKeyId?: number;
  kyberPreKey?: Uint8Array;
  kyberPreKeyId?: number;
  kyberPreKeySignature?: Uint8Array;
}

// ==================== Safety Numbers ====================

export interface SafetyNumber {
  displayable: string;
  scannable: Uint8Array;
}

// ==================== Sesame Protocol Constants ====================

export const SESAME_CONSTANTS = {
  MAX_INACTIVE_SESSIONS: 5,
  SESSION_EXPIRY_MS: 7 * 24 * 60 * 60 * 1000,
  STALE_RECORD_TIMEOUT_MS: 5 * 60 * 1000,
  MAX_SEND_ATTEMPTS: 3,
  MAX_RESEND_ATTEMPTS: 5,
} as const;


// ==================== PreKey Storage Types ====================

export interface StoredPreKey {
  id: number;
  publicKey: string;
  record?: string;
  createdAt: number;
}

export interface StoredSignedPreKey {
  id: number;
  publicKey: string;
  signature: string;
  record?: string;
  createdAt: number;
}

export interface StoredKyberPreKey {
  id: number;
  publicKey: string;
  signature: string;
  record?: string;
  createdAt: number;
}
// ==================== Initialization Result ====================

export interface SignalInitializationResult {
  success: boolean;
  error?: string;
  deviceId?: number;
  uuid?: string;
  isInitialized?: boolean;
  keysForPublishing?: {
    preKeys: StoredPreKey[];
    signedPreKeys: StoredSignedPreKey[];
    kyberPreKeys: StoredKyberPreKey[];
    identityKey: string;
    registrationId: number;
    deviceId?: number;
  };
}
