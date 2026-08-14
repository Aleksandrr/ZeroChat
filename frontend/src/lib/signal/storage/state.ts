/**
 * SignalClient State Persistence
 * Handles storage of SignalClient state for page reload recovery
 */

import { base64ToUint8Array,uint8ArrayToBase64 } from '@/lib/utils/buffer';

import type { SignalClientState } from '../types';
import { clearAllSignalData,get, getAll, initSignalDB, put, remove, STORES } from './db';
import { wrapSecret, unwrapSecret } from './keystore';
import { getAllIdentityKeys,hasIdentityKey, loadIdentityKey, loadLocalDeviceUuid, loadRegistration } from './identity';
import { loadAllKyberPreKeyRecords,loadAllPreKeyRecords, loadAllSignedPreKeyRecords } from './keys';
import { getAllLinkedDevices, getAllSenderKeys, loadSesameState } from './sesame';
import { getAllSessions,loadAllSessionRecords } from './sessions';

// ==================== SignalClient State Operations ====================

interface DBSignalClientState {
  id: string;
  userId: string;
  identityKeyPair: {
    publicKey: string;
    privateKey: string;
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

/**
 * Save SignalClient state to IndexedDB. The identity private key is
 * wrapped with the device-bound KEK before being written; the public
 * key is left as plaintext (it is public).
 */
export async function saveSignalClientState(state: {
  userId: string;
  identityKeyPair: { publicKey: Uint8Array; privateKey: Uint8Array };
  registrationId: number;
  deviceId: number;
  nextPreKeyId: number;
  nextSignedPreKeyId: number;
  nextKyberPreKeyId: number;
  localDeviceUuid: string;
}): Promise<void> {
  await initSignalDB();

  const wrappedPrivateKey = await wrapSecret(uint8ArrayToBase64(state.identityKeyPair.privateKey));
  const data: DBSignalClientState = {
    id: 'current',
    userId: state.userId,
    identityKeyPair: {
      publicKey: uint8ArrayToBase64(state.identityKeyPair.publicKey),
      privateKey: wrappedPrivateKey,
    },
    registrationId: state.registrationId,
    deviceId: state.deviceId,
    nextPreKeyId: state.nextPreKeyId,
    nextSignedPreKeyId: state.nextSignedPreKeyId,
    nextKyberPreKeyId: state.nextKyberPreKeyId,
    localDeviceUuid: state.localDeviceUuid,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await put(STORES.SIGNAL_CLIENT_STATE, data);
}

/**
 * Load SignalClient state from IndexedDB. The identity private key is
 * unwrapped from device-bound AES-GCM ciphertext. Legacy plaintext
 * records are returned transparently via the unwrap fallback.
 */
export async function loadSignalClientState(): Promise<{
  userId: string;
  identityKeyPair: { publicKey: Uint8Array; privateKey: Uint8Array };
  registrationId: number;
  deviceId: number;
  nextPreKeyId: number;
  nextSignedPreKeyId: number;
  nextKyberPreKeyId: number;
  localDeviceUuid: string;
} | null> {
  await initSignalDB();

  const data = await get<DBSignalClientState>(STORES.SIGNAL_CLIENT_STATE, 'current');
  if (!data) return null;

  const privateKeyBase64 = await unwrapSecret(data.identityKeyPair.privateKey);
  return {
    userId: data.userId,
    identityKeyPair: {
      publicKey: base64ToUint8Array(data.identityKeyPair.publicKey),
      privateKey: base64ToUint8Array(privateKeyBase64),
    },
    registrationId: data.registrationId,
    deviceId: data.deviceId,
    nextPreKeyId: data.nextPreKeyId,
    nextSignedPreKeyId: data.nextSignedPreKeyId,
    nextKyberPreKeyId: data.nextKyberPreKeyId,
    localDeviceUuid: data.localDeviceUuid,
  };
}

/**
 * Clear SignalClient state
 */
export async function clearSignalClientState(): Promise<void> {
  await initSignalDB();
  await remove(STORES.SIGNAL_CLIENT_STATE, 'current');
}

// ==================== Full State Export/Import ====================

/**
 * Key offsets for tracking identity key usage
 */
export interface KeyOffsets {
  createdAt: number;
  firstUse: number | null;
  verified: number | null;
  name: string;
}

/**
 * Full Signal Protocol state for export/import
 */
export interface FullSignalState {
  deviceId: number;
  localDeviceUuid: string | null;
  registrationId: number;
  identityKey: {
    publicKey: string;
    privateKey: string;
    offsets: KeyOffsets;
  } | null;
  preKeys: {
    id: number;
    publicKey: string;
    privateKey?: string;
    record?: string;
    createdAt: number;
  }[];
  signedPreKeys: {
    id: number;
    publicKey: string;
    privateKey: string;
    signature: string;
    record?: string;
    createdAt: number;
  }[];
  kyberPreKeys: {
    id: number;
    publicKey: string;
    privateKey: string;
    signature: string;
    record?: string;
    createdAt: number;
  }[];
  sessions: {
    id: string;
    recipientId: string;
    recipientDeviceId: number;
    sessionState: string;
    isActive: boolean;
    messageCount: number;
    createdAt: number;
    updatedAt: number;
  }[];
  senderKeys: {
    id: string;
    groupId: string;
    senderUserId: string;
    senderKeyId: number;
    senderKeyState: string;
    createdAt: number;
    updatedAt: number;
  }[];
  sesameState: string | null;
  exportedAt: number;
  version: number;
}

/**
 * Export full Signal state for backup/migration
 */
export async function exportFullSignalState(): Promise<FullSignalState> {
  await initSignalDB();
  
  const deviceId = (await loadRegistration())?.deviceId ?? 0;
  const localDeviceUuid = await loadLocalDeviceUuid();
  const registration = await loadRegistration();
  const identityKeyData = registration?.userId ? await loadIdentityKey(registration.userId) : null;
  
  // Export PreKeys
  const uuid = await loadLocalDeviceUuid();
  const preKeyRecords = uuid ? await loadAllPreKeyRecords(uuid) : [];
  const preKeys = preKeyRecords.map(pk => ({
    id: pk.id,
    publicKey: uint8ArrayToBase64(pk.publicKey),
    record: uint8ArrayToBase64(pk.record),
    createdAt: Date.now(),
  }));
  
  // Export SignedPreKeys
  const signedPreKeyRecords = uuid ? await loadAllSignedPreKeyRecords(uuid) : [];
  const signedPreKeys = signedPreKeyRecords.map(spk => ({
    id: spk.id,
    publicKey: uint8ArrayToBase64(spk.publicKey),
    privateKey: '',
    signature: uint8ArrayToBase64(spk.signature),
    record: uint8ArrayToBase64(spk.record),
    createdAt: spk.timestamp,
  }));
  
  // Export KyberPreKeys
  const kyberPreKeyRecords = uuid ? await loadAllKyberPreKeyRecords(uuid) : [];
  const kyberPreKeys = kyberPreKeyRecords.map(kpk => ({
    id: kpk.id,
    publicKey: uint8ArrayToBase64(kpk.publicKey),
    privateKey: '',
    signature: uint8ArrayToBase64(kpk.signature),
    record: uint8ArrayToBase64(kpk.record),
    createdAt: kpk.timestamp,
  }));
  
  // Export Sessions
  const sessionRecords = uuid ? await loadAllSessionRecords(uuid) : [];
  const sessions = sessionRecords.map(s => ({
    id: `${s.remoteUuid}.${s.remoteDeviceId}`,
    recipientId: s.remoteUuid,
    recipientDeviceId: s.remoteDeviceId,
    sessionState: uint8ArrayToBase64(s.record),
    isActive: true,
    messageCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }));
  
  // Export SenderKeys
  const senderKeys = (await getAllSenderKeys()).map(sk => ({
    id: sk.id,
    groupId: sk.groupId,
    senderUserId: sk.senderUserId,
    senderKeyId: sk.senderKeyId,
    senderKeyState: sk.senderKeyState,
    createdAt: sk.createdAt,
    updatedAt: sk.updatedAt,
  }));
  
  // Export SesameState
  const sesameState = await loadSesameState();
  
  return {
    deviceId,
    localDeviceUuid,
    registrationId: registration?.registrationId ?? 0,
    identityKey: identityKeyData ? {
      publicKey: identityKeyData.publicKey,
      privateKey: identityKeyData.privateKey,
      offsets: {
        createdAt: identityKeyData.createdAt,
        firstUse: null,
        verified: null,
        name: '',
      },
    } : null,
    preKeys,
    signedPreKeys,
    kyberPreKeys,
    sessions,
    senderKeys,
    sesameState,
    exportedAt: Date.now(),
    version: 1,
  };
}

/**
 * Verify Signal state integrity
 */
export async function verifySignalStateIntegrity(state: FullSignalState): Promise<{
  isValid: boolean;
  issues: string[];
}> {
  const issues: string[] = [];
  
  // Check identity key
  if (!state.identityKey) {
    issues.push('Missing identity key');
  } else {
    if (!state.identityKey.publicKey) {
      issues.push('Missing identity public key');
    }
    if (!state.identityKey.privateKey) {
      issues.push('Missing identity private key');
    }
  }
  
  // Check registration
  if (!state.registrationId) {
    issues.push('Missing registration ID');
  }
  
  // Check device ID
  if (!state.deviceId || state.deviceId < 1 || state.deviceId > 127) {
    issues.push('Invalid device ID');
  }
  
  // Check PreKeys
  if (state.preKeys.length === 0) {
    issues.push('No PreKeys available');
  }
  
  return {
    isValid: issues.length === 0,
    issues,
  };
}

// ==================== Statistics ====================

/**
 * Get Signal storage statistics
 */
export async function getSignalStorageStats(): Promise<{
  preKeyCount: number;
  signedPreKeyCount: number;
  kyberPreKeyCount: number;
  sessionCount: number;
  activeSessionCount: number;
  senderKeyCount: number;
  linkedDeviceCount: number;
}> {
  await initSignalDB();
  
  const uuid = await loadLocalDeviceUuid();
  
  const [preKeyRecords, signedPreKeyRecords, kyberPreKeyRecords, sessions, senderKeys, linkedDevices] = await Promise.all([
    uuid ? loadAllPreKeyRecords(uuid) : Promise.resolve([]),
    uuid ? loadAllSignedPreKeyRecords(uuid) : Promise.resolve([]),
    uuid ? loadAllKyberPreKeyRecords(uuid) : Promise.resolve([]),
    getAllSessions(),
    getAllSenderKeys(),
    getAllLinkedDevices(),
  ]);

  return {
    preKeyCount: preKeyRecords.length,
    signedPreKeyCount: signedPreKeyRecords.length,
    kyberPreKeyCount: kyberPreKeyRecords.length,
    sessionCount: sessions.length,
    activeSessionCount: sessions.filter(s => s.isActive).length,
    senderKeyCount: senderKeys.length,
    linkedDeviceCount: linkedDevices.length,
  };
}

// ==================== Re-export clearAllSignalData ====================

export { clearAllSignalData };

// Note: FullSignalState and KeyOffsets are exported from interface definitions above