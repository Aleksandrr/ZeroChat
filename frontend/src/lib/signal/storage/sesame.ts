/**
 * Sesame Multi-Device Storage for Signal Protocol
 * Handles linked devices, linking requests, sender keys, and UserRecords
 */

import { base64ToUint8Array,uint8ArrayToBase64 } from '@/lib/utils/buffer';

import type { DeviceRecord,LinkedDevice, LinkingRequest, SenderKeyRecord } from '../types';
import { get, getAll,initSignalDB, put, remove, STORES } from './db';
import { wrapSecret, unwrapSecret } from './keystore';

// ==================== Database Record Types ====================

interface DBLinkedDevice {
  id: number;
  deviceId: number;
  identityKey: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
}

interface DBLinkingRequest {
  id: string;
  linkingId: string;
  userId: string;
  identityKey: string;
  ephemeralPublicKey: string;
  createdAt: number;
  expiresAt: number;
}

interface DBSenderKey {
  id: string;
  groupId: string;
  senderUserId: string;
  senderKeyId: number;
  senderKeyState: string;
  createdAt: number;
  updatedAt: number;
}

interface DBSesameState {
  id: string;
  state: string;
  updatedAt: number;
}

// ==================== Linked Devices Operations ====================

/**
 * Store a linked device
 */
export async function storeLinkedDevice(device: LinkedDevice): Promise<void> {
  await initSignalDB();
  
  const data: DBLinkedDevice = {
    id: device.deviceId,
    deviceId: device.deviceId,
    identityKey: uint8ArrayToBase64(device.identityKey),
    name: device.name,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt,
  };
  await put(STORES.LINKED_DEVICES, data);
}

/**
 * Get a linked device by ID
 */
export async function getLinkedDevice(id: number): Promise<LinkedDevice | undefined> {
  await initSignalDB();
  
  const data = await get<DBLinkedDevice>(STORES.LINKED_DEVICES, id);
  if (!data) return undefined;
  
  return {
    deviceId: data.deviceId,
    identityKey: base64ToUint8Array(data.identityKey),
    name: data.name,
    createdAt: data.createdAt,
    lastSeenAt: data.lastSeenAt,
  };
}

/**
 * Get linked device by device ID
 */
export async function getLinkedDeviceByDeviceId(deviceId: number): Promise<LinkedDevice | undefined> {
  await initSignalDB();
  
  const allDevices = await getAll<DBLinkedDevice>(STORES.LINKED_DEVICES);
  const data = allDevices.find(d => d.deviceId === deviceId);
  if (!data) return undefined;
  
  return {
    deviceId: data.deviceId,
    identityKey: base64ToUint8Array(data.identityKey),
    name: data.name,
    createdAt: data.createdAt,
    lastSeenAt: data.lastSeenAt,
  };
}

/**
 * Get all linked devices
 */
export async function getAllLinkedDevices(): Promise<LinkedDevice[]> {
  await initSignalDB();
  
  const allData = await getAll<DBLinkedDevice>(STORES.LINKED_DEVICES);
  return allData.map(data => ({
    deviceId: data.deviceId,
    identityKey: base64ToUint8Array(data.identityKey),
    name: data.name,
    createdAt: data.createdAt,
    lastSeenAt: data.lastSeenAt,
  }));
}

/**
 * Delete a linked device
 */
export async function deleteLinkedDevice(id: number): Promise<void> {
  await initSignalDB();
  await remove(STORES.LINKED_DEVICES, id);
}

/**
 * Update linked device last seen timestamp
 */
export async function updateLinkedDeviceLastSeen(id: number): Promise<void> {
  const device = await getLinkedDevice(id);
  if (device) {
    device.lastSeenAt = Date.now();
    await storeLinkedDevice(device);
  }
}

// ==================== Linking Requests Operations ====================

/**
 * Store a linking request
 */
export async function storeLinkingRequest(request: LinkingRequest): Promise<void> {
  await initSignalDB();
  
  const data: DBLinkingRequest = {
    id: request.linkingId,
    linkingId: request.linkingId,
    userId: request.userId,
    identityKey: uint8ArrayToBase64(request.identityKey),
    ephemeralPublicKey: uint8ArrayToBase64(request.ephemeralPublicKey),
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
  };
  await put(STORES.LINKING_REQUESTS, data);
}

/**
 * Get a linking request by ID
 */
export async function getLinkingRequest(linkingId: string): Promise<LinkingRequest | undefined> {
  await initSignalDB();
  
  const allRequests = await getAll<DBLinkingRequest>(STORES.LINKING_REQUESTS);
  const data = allRequests.find(r => r.linkingId === linkingId);
  
  if (!data) return undefined;
  
  // Check if expired
  if (Date.now() > data.expiresAt) {
    await remove(STORES.LINKING_REQUESTS, data.id);
    return undefined;
  }
  
  return {
    linkingId: data.linkingId,
    userId: data.userId,
    identityKey: base64ToUint8Array(data.identityKey),
    ephemeralPublicKey: base64ToUint8Array(data.ephemeralPublicKey),
    createdAt: data.createdAt,
    expiresAt: data.expiresAt,
  };
}

/**
 * Delete a linking request
 */
export async function deleteLinkingRequest(id: string): Promise<void> {
  await initSignalDB();
  await remove(STORES.LINKING_REQUESTS, id);
}

/**
 * Cleanup expired linking requests
 */
export async function cleanupExpiredLinkingRequests(): Promise<void> {
  await initSignalDB();
  
  const allRequests = await getAll<DBLinkingRequest>(STORES.LINKING_REQUESTS);
  const now = Date.now();
  
  for (const request of allRequests) {
    if (now > request.expiresAt) {
      await remove(STORES.LINKING_REQUESTS, request.id);
    }
  }
}

// ==================== Sender Key Operations ====================

/**
 * Generate sender key ID
 */
export function generateSenderKeyId(groupId: string, senderUserId: string): string {
  return `${groupId}.${senderUserId}`;
}

/**
 * Store a sender key. The `senderKeyState` field is the base64 of an
 * exported WASM SenderKey state — it contains the chain key and the
 * private signing key, so it is wrapped with the device-bound KEK
 * before being written to IndexedDB.
 */
export async function storeSenderKey(senderKey: SenderKeyRecord): Promise<void> {
  await initSignalDB();

  const data: DBSenderKey = {
    id: senderKey.id,
    groupId: senderKey.groupId,
    senderUserId: senderKey.senderUserId,
    senderKeyId: senderKey.senderKeyId,
    senderKeyState: await wrapSecret(senderKey.senderKeyState),
    createdAt: senderKey.createdAt,
    updatedAt: senderKey.updatedAt,
  };
  await put(STORES.SENDER_KEY, data);
}

/**
 * Get a sender key. The wrapped `senderKeyState` field is unwrapped
 * back to plaintext base64 before being returned. Legacy plaintext
 * records are returned transparently via the unwrap fallback.
 */
export async function getSenderKey(
  groupId: string,
  senderUserId: string
): Promise<SenderKeyRecord | undefined> {
  await initSignalDB();

  const id = generateSenderKeyId(groupId, senderUserId);
  const data = await get<DBSenderKey>(STORES.SENDER_KEY, id);
  if (!data) return undefined;

  return {
    id: data.id,
    groupId: data.groupId,
    senderUserId: data.senderUserId,
    senderKeyId: data.senderKeyId,
    senderKeyState: await unwrapSecret(data.senderKeyState),
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
  };
}

/**
 * Delete a sender key
 */
export async function deleteSenderKey(
  groupId: string,
  senderUserId: string
): Promise<void> {
  await initSignalDB();
  const id = generateSenderKeyId(groupId, senderUserId);
  await remove(STORES.SENDER_KEY, id);
}

/**
 * Get all sender keys. Each wrapped `senderKeyState` field is
 * unwrapped back to plaintext base64 before being returned.
 */
export async function getAllSenderKeys(): Promise<SenderKeyRecord[]> {
  await initSignalDB();

  const allData = await getAll<DBSenderKey>(STORES.SENDER_KEY);
  const out: SenderKeyRecord[] = [];
  for (const data of allData) {
    out.push({
      id: data.id,
      groupId: data.groupId,
      senderUserId: data.senderUserId,
      senderKeyId: data.senderKeyId,
      senderKeyState: await unwrapSecret(data.senderKeyState),
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    });
  }
  return out;
}

/**
 * Get sender keys by group ID
 */
export async function getSenderKeysByGroup(groupId: string): Promise<SenderKeyRecord[]> {
  const allKeys = await getAllSenderKeys();
  return allKeys.filter(k => k.groupId === groupId);
}

/**
 * Import sender keys (for state restoration)
 */
export async function importSenderKeys(
  senderKeys: {
    id: string;
    groupId: string;
    senderUserId: string;
    senderKeyId: number;
    senderKeyState: string;
    createdAt: number;
    updatedAt: number;
  }[]
): Promise<void> {
  for (const sk of senderKeys) {
    await storeSenderKey(sk);
  }
}

// ==================== Sesame State Operations ====================

/**
 * Store Sesame state. The `state` blob is opaque, but historically
 * contains serialized session/device info for the Sesame algorithm,
 * so it is wrapped with the device-bound KEK before being written.
 */
export async function storeSesameState(state: string): Promise<void> {
  await initSignalDB();

  const data: DBSesameState = {
    id: 'current',
    state: await wrapSecret(state),
    updatedAt: Date.now(),
  };
  await put(STORES.SESAME_STATE, data);
}

/**
 * Load Sesame state. The wrapped `state` field is unwrapped back to
 * plaintext before being returned. Legacy plaintext records are
 * returned transparently via the unwrap fallback.
 */
export async function loadSesameState(): Promise<string | null> {
  await initSignalDB();

  const data = await get<DBSesameState>(STORES.SESAME_STATE, 'current');
  if (!data?.state) return null;
  return await unwrapSecret(data.state);
}

// ==================== UserRecord Operations ====================

/**
 * Store a complete UserRecord (Sesame algorithm)
 */
export async function storeUserRecord(record: {
  userId: string;
  devices: Record<number, DeviceRecord>;
  isStale: boolean;
  staleSince?: number;
  createdAt: number;
  updatedAt: number;
}): Promise<void> {
  await initSignalDB();
  
  // Serialize the devices Record for storage
  const devicesArray = Object.entries(record.devices).map(([deviceId, device]) => ({
    deviceId: parseInt(deviceId, 10),
    userId: device.userId,
    identityKey: uint8ArrayToBase64(device.identityKey),
    activeSession: device.activeSession,
    inactiveSessions: device.inactiveSessions,
    isStale: device.isStale,
    staleSince: device.staleSince,
    createdAt: device.createdAt,
    updatedAt: device.updatedAt,
    messageCount: device.activeSession?.messageCount ?? 0,
  }));
  
  await put(STORES.SESAME_STATE, {
    id: `user_${record.userId}`,
    userId: record.userId,
    devices: JSON.stringify(devicesArray),
    isStale: record.isStale,
    staleSince: record.staleSince,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

/**
 * Load a UserRecord from storage
 */
export async function getUserRecord(userId: string): Promise<{
  userId: string;
  devices: Record<number, DeviceRecord>;
  isStale: boolean;
  staleSince?: number;
  createdAt: number;
  updatedAt: number;
} | null> {
  await initSignalDB();
  
  const data = await get<any>(STORES.SESAME_STATE, `user_${userId}`);
  
  if (!data) return null;
  
  const devicesArray = JSON.parse(data.devices || '[]');
  const devices: Record<number, DeviceRecord> = {};
  
  for (const device of devicesArray) {
    devices[device.deviceId] = {
      ...device,
      identityKey: base64ToUint8Array(device.identityKey),
    };
  }
  
  return {
    userId: data.userId,
    devices,
    isStale: data.isStale,
    staleSince: data.staleSince,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
  };
}

/**
 * Delete a UserRecord
 */
export async function deleteUserRecord(userId: string): Promise<void> {
  await initSignalDB();
  await remove(STORES.SESAME_STATE, `user_${userId}`);
}

/**
 * Clean up stale UserRecords (Sesame algorithm)
 */
export async function cleanupStaleUserRecords(cutoffTime: number): Promise<void> {
  await initSignalDB();
  
  const allData = await getAll<any>(STORES.SESAME_STATE);
  
  for (const data of allData) {
    // Only check UserRecords (id starts with 'user_')
    if (data.id?.startsWith('user_') && data.staleSince && data.staleSince < cutoffTime) {
      await remove(STORES.SESAME_STATE, data.id);
    }
  }
}

// ==================== Export Types ====================

export type { DBLinkedDevice, DBLinkingRequest, DBSenderKey, DBSesameState };