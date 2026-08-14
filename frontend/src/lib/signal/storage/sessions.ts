/**
 * Session Storage for Signal Protocol
 * Handles storage of session records for Double Ratchet algorithm
 */

import { base64ToUint8Array,uint8ArrayToBase64 } from '@/lib/utils/buffer';

import { get, getAll,initSignalDB, put, remove, STORES } from './db';
import { wrapSecret, unwrapSecret } from './keystore';
import { loadLocalDeviceUuid } from './identity';

// ==================== Database Record Types ====================

interface DBSessionRecord {
  localUuid: string;
  remoteUuid: string;
  remoteDeviceId: number;
  record: string;
  createdAt: number;
  updatedAt: number;
}

// Legacy session format (for migration)
interface DBSessionLegacy {
  id: string;
  recipientId: string;
  recipientDeviceId: number;
  sessionState: string;
  isActive: boolean;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}

// ==================== Session Operations ====================

/**
 * Store session with full WASM record. The WASM record contains the
 * Double Ratchet state — root key, chain keys, message keys — all of
 * which are private, so it is wrapped with the device-bound KEK before
 * being written to IndexedDB.
 */
export async function storeSessionWithRecord(
  localUuid: string,
  remoteUuid: string,
  remoteDeviceId: number,
  record: Uint8Array
): Promise<void> {
  await initSignalDB();

  const data: DBSessionRecord = {
    localUuid,
    remoteUuid,
    remoteDeviceId,
    record: await wrapSecret(uint8ArrayToBase64(record)),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await put(STORES.SESSION, data);
}

/**
 * Load session record for WASM import. The wrapped `record` field is
 * unwrapped back to plaintext base64 before being decoded to Uint8Array.
 */
export async function loadSessionRecord(
  localUuid: string,
  remoteUuid: string,
  remoteDeviceId: number
): Promise<{ localUuid: string; remoteUuid: string; remoteDeviceId: number; record: Uint8Array } | undefined> {
  await initSignalDB();

  const data = await get<DBSessionRecord>(STORES.SESSION, [localUuid, remoteUuid, remoteDeviceId]);
  if (!data) return undefined;

  const recordBase64 = await unwrapSecret(data.record);
  return {
    localUuid: data.localUuid,
    remoteUuid: data.remoteUuid,
    remoteDeviceId: data.remoteDeviceId,
    record: base64ToUint8Array(recordBase64),
  };
}

/**
 * Load all session records for a device. The wrapped `record` field
 * of each record is unwrapped back to plaintext before being decoded.
 */
export async function loadAllSessionRecords(
  localUuid: string
): Promise<{ localUuid: string; remoteUuid: string; remoteDeviceId: number; record: Uint8Array }[]> {
  await initSignalDB();

  const allData = await getAll<DBSessionRecord>(STORES.SESSION);
  const out: { localUuid: string; remoteUuid: string; remoteDeviceId: number; record: Uint8Array }[] = [];
  for (const s of allData) {
    if (s.localUuid !== localUuid) continue;
    const recordBase64 = await unwrapSecret(s.record);
    out.push({
      localUuid: s.localUuid,
      remoteUuid: s.remoteUuid,
      remoteDeviceId: s.remoteDeviceId,
      record: base64ToUint8Array(recordBase64),
    });
  }
  return out;
}

/**
 * Get session record by remote UUID and device ID. The wrapped `record`
 * field is unwrapped back to plaintext base64 before being decoded.
 */
export async function getSessionRecord(
  remoteUuid: string,
  remoteDeviceId: number
): Promise<{ localUuid: string; remoteUuid: string; remoteDeviceId: number; record: Uint8Array } | null> {
  const localUuid = await loadLocalDeviceUuid();
  if (!localUuid) return null;

  const sessionRecord = await get<DBSessionRecord>(STORES.SESSION, [localUuid, remoteUuid, remoteDeviceId]);
  if (!sessionRecord || !sessionRecord.record) return null;

  const recordBase64 = await unwrapSecret(sessionRecord.record);
  return {
    localUuid: sessionRecord.localUuid,
    remoteUuid: sessionRecord.remoteUuid,
    remoteDeviceId: sessionRecord.remoteDeviceId,
    record: base64ToUint8Array(recordBase64),
  };
}

/**
 * Delete session record
 */
export async function deleteSessionRecord(
  localUuid: string,
  remoteUuid: string,
  remoteDeviceId: number
): Promise<void> {
  await initSignalDB();
  await remove(STORES.SESSION, [localUuid, remoteUuid, remoteDeviceId]);
}

/**
 * Delete session (wrapper for compatibility)
 */
export async function deleteSession(
  recipientId: string,
  recipientDeviceId: number
): Promise<void> {
  const localUuid = await loadLocalDeviceUuid();
  if (localUuid) {
    await deleteSessionRecord(localUuid, recipientId, recipientDeviceId);
  }
}

/**
 * Check if session exists for a recipient
 */
export async function hasSession(
  recipientId: string,
  recipientDeviceId: number
): Promise<boolean> {
  const localUuid = await loadLocalDeviceUuid();
  if (localUuid) {
    const sessionRecord = await get<DBSessionRecord>(STORES.SESSION, [localUuid, recipientId, recipientDeviceId]);
    if (sessionRecord && sessionRecord.record) {
      return true;
    }
  }
  return false;
}

// ==================== Legacy Session ID Helper ====================

/**
 * Generate legacy session ID (for migration)
 */
export function generateSessionId(recipientId: string, recipientDeviceId: number): string {
  return `${recipientId}.${recipientDeviceId}`;
}

// ==================== Import Functions ====================

/**
 * Import sessions (for state restoration)
 */
export async function importSessions(
  sessions: {
    id: string;
    recipientId: string;
    recipientDeviceId: number;
    sessionState: string;
    isActive: boolean;
    messageCount: number;
    createdAt: number;
    updatedAt: number;
  }[],
  localUuid: string
): Promise<void> {
  for (const session of sessions) {
    // Convert legacy format to new format
    const record = session.sessionState;
    if (record) {
      await storeSessionWithRecord(
        localUuid,
        session.recipientId,
        session.recipientDeviceId,
        base64ToUint8Array(record)
      );
    }
  }
}

// ==================== Statistics ====================

/**
 * Get all sessions (for statistics)
 */
export async function getAllSessions(): Promise<{
  id: string;
  recipientId: string;
  recipientDeviceId: number;
  sessionState: string;
  isActive: boolean;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}[]> {
  await initSignalDB();
  
  const allData = await getAll<DBSessionRecord>(STORES.SESSION);
  
  // Convert from DBSessionRecord to legacy format for compatibility
  return allData.map(s => ({
    id: `${s.remoteUuid}.${s.remoteDeviceId}`,
    recipientId: s.remoteUuid,
    recipientDeviceId: s.remoteDeviceId,
    sessionState: s.record,
    isActive: true,
    messageCount: 0,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  }));
}

/**
 * Get session count
 */
export async function getSessionCount(): Promise<number> {
  const sessions = await getAllSessions();
  return sessions.length;
}

// ==================== Export Types ====================

export type { DBSessionLegacy,DBSessionRecord };