/**
 * PreKey Storage for Signal Protocol
 * Handles storage of PreKeys, SignedPreKeys, and KyberPreKeys with full WASM records
 */

import { base64ToUint8Array,uint8ArrayToBase64 } from '@/lib/utils/buffer';

import { get, getAll,initSignalDB, put, remove, STORES } from './db';
import { wrapSecret, unwrapSecret } from './keystore';
import { loadLocalDeviceUuid } from './identity';

// ==================== Database Record Types ====================

interface DBPreKeyRecord {
  id: number;
  uuid: string;
  publicKey: string;
  record: string;
  createdAt: number;
}

interface DBSignedPreKeyRecord {
  id: number;
  uuid: string;
  publicKey: string;
  signature: string;
  record: string;
  timestamp: number;
  createdAt: number;
}

interface DBKyberPreKeyRecord {
  id: number;
  uuid: string;
  publicKey: string;
  signature: string;
  record: string;
  timestamp: number;
  createdAt: number;
}

// ==================== PreKey Operations ====================

/**
 * Store PreKey with full WASM record. The WASM record contains both
 * the public and the private key material, so it is wrapped with the
 * device-bound KEK before being written to IndexedDB. The `publicKey`
 * field is left as plaintext (it is public).
 */
export async function storePreKeyWithRecord(
  uuid: string,
  id: number,
  publicKey: Uint8Array,
  record: Uint8Array,
  createdAt: number = Date.now()
): Promise<void> {
  await initSignalDB();

  const data: DBPreKeyRecord = {
    uuid,
    id,
    publicKey: uint8ArrayToBase64(publicKey),
    record: await wrapSecret(uint8ArrayToBase64(record)),
    createdAt,
  };
  await put(STORES.PRE_KEY, data);
}

/**
 * Store PreKey with object interface (compatibility wrapper)
 * Used by signal/index.ts storePreKeys method. The `record` field
 * is wrapped with the device-bound KEK before being written; the
 * `publicKey` field is left as plaintext.
 */
export async function storePreKey(preKey: {
  id: number;
  publicKey: string;
  record: string;
  createdAt: number;
}): Promise<void> {
  const uuid = await loadLocalDeviceUuid();
  if (!uuid) {
    throw new Error('No device UUID found. Initialize Signal Protocol first.');
  }

  await initSignalDB();

  const data: DBPreKeyRecord = {
    uuid,
    id: preKey.id,
    publicKey: preKey.publicKey,
    record: await wrapSecret(preKey.record),
    createdAt: preKey.createdAt,
  };
  await put(STORES.PRE_KEY, data);
}

/**
 * Load PreKey record for WASM import. The wrapped `record` field is
 * unwrapped back to plaintext base64 before being decoded to Uint8Array.
 * Legacy plaintext records are returned transparently via the unwrap
 * fallback.
 */
export async function loadPreKeyRecord(
  uuid: string,
  id: number
): Promise<{ id: number; record: Uint8Array } | undefined> {
  await initSignalDB();

  const data = await get<DBPreKeyRecord>(STORES.PRE_KEY, [uuid, id]);
  if (!data) return undefined;

  const recordBase64 = await unwrapSecret(data.record);
  return {
    id: data.id,
    record: base64ToUint8Array(recordBase64),
  };
}

/**
 * Load all PreKey records for a device. The wrapped `record` field of
 * each record is unwrapped back to plaintext before being decoded.
 */
export async function loadAllPreKeyRecords(
  uuid: string
): Promise<{ id: number; record: Uint8Array; publicKey: Uint8Array }[]> {
  await initSignalDB();

  const allData = await getAll<DBPreKeyRecord>(STORES.PRE_KEY);
  const out: { id: number; record: Uint8Array; publicKey: Uint8Array }[] = [];
  for (const pk of allData) {
    if (pk.uuid !== uuid) continue;
    const recordBase64 = await unwrapSecret(pk.record);
    out.push({
      id: pk.id,
      record: base64ToUint8Array(recordBase64),
      publicKey: base64ToUint8Array(pk.publicKey),
    });
  }
  return out;
}

/**
 * Store batch of PreKeys
 */
export async function storePreKeyRecords(
  uuid: string,
  preKeys: { id: number; publicKey: Uint8Array; record: Uint8Array }[],
  createdAt: number = Date.now()
): Promise<void> {
  for (const pk of preKeys) {
    await storePreKeyWithRecord(uuid, pk.id, pk.publicKey, pk.record, createdAt);
  }
}

/**
 * Delete PreKey record
 */
export async function deletePreKeyRecord(uuid: string, id: number): Promise<void> {
  await initSignalDB();
  await remove(STORES.PRE_KEY, [uuid, id]);
}

/**
 * Get PreKey count for a device
 */
export async function getPreKeyCount(uuid: string): Promise<number> {
  await initSignalDB();
  const allData = await getAll<DBPreKeyRecord>(STORES.PRE_KEY);
  return allData.filter(pk => pk.uuid === uuid).length;
}

// ==================== Signed PreKey Operations ====================

/**
 * Store SignedPreKey with full WASM record. The WASM record contains
 * both public and private key material, so it is wrapped with the
 * device-bound KEK before being written. `publicKey` and `signature`
 * are left as plaintext (they are public).
 */
export async function storeSignedPreKeyWithRecord(
  uuid: string,
  id: number,
  publicKey: Uint8Array,
  signature: Uint8Array,
  record: Uint8Array,
  timestamp: number = Date.now(),
  createdAt: number = Date.now()
): Promise<void> {
  await initSignalDB();

  const data: DBSignedPreKeyRecord = {
    uuid,
    id,
    publicKey: uint8ArrayToBase64(publicKey),
    signature: uint8ArrayToBase64(signature),
    record: await wrapSecret(uint8ArrayToBase64(record)),
    timestamp,
    createdAt,
  };
  await put(STORES.SIGNED_PRE_KEY, data);
}

/**
 * Load SignedPreKey record for WASM import. The wrapped `record` field
 * is unwrapped back to plaintext base64 before being decoded.
 */
export async function loadSignedPreKeyRecord(
  uuid: string,
  id: number
): Promise<{ id: number; record: Uint8Array } | undefined> {
  await initSignalDB();

  const data = await get<DBSignedPreKeyRecord>(STORES.SIGNED_PRE_KEY, [uuid, id]);
  if (!data) return undefined;

  const recordBase64 = await unwrapSecret(data.record);
  return {
    id: data.id,
    record: base64ToUint8Array(recordBase64),
  };
}

/**
 * Load all SignedPreKey records for a device. The wrapped `record`
 * field of each record is unwrapped back to plaintext before being
 * decoded.
 */
export async function loadAllSignedPreKeyRecords(
  uuid: string
): Promise<{ id: number; record: Uint8Array; publicKey: Uint8Array; signature: Uint8Array; timestamp: number }[]> {
  await initSignalDB();

  const allData = await getAll<DBSignedPreKeyRecord>(STORES.SIGNED_PRE_KEY);
  const out: { id: number; record: Uint8Array; publicKey: Uint8Array; signature: Uint8Array; timestamp: number }[] = [];
  for (const pk of allData) {
    if (pk.uuid !== uuid) continue;
    const recordBase64 = await unwrapSecret(pk.record);
    out.push({
      id: pk.id,
      record: base64ToUint8Array(recordBase64),
      publicKey: base64ToUint8Array(pk.publicKey),
      signature: base64ToUint8Array(pk.signature),
      timestamp: pk.timestamp,
    });
  }
  return out;
}

/**
 * Delete SignedPreKey record
 */
export async function deleteSignedPreKeyRecord(uuid: string, id: number): Promise<void> {
  await initSignalDB();
  await remove(STORES.SIGNED_PRE_KEY, [uuid, id]);
}

// ==================== Kyber PreKey Operations (PQXDH) ====================

/**
 * Store KyberPreKey with full WASM record. The WASM record contains
 * both public and private key material, so it is wrapped with the
 * device-bound KEK before being written. `publicKey` and `signature`
 * are left as plaintext (they are public).
 */
export async function storeKyberPreKeyWithRecord(
  uuid: string,
  id: number,
  publicKey: Uint8Array,
  signature: Uint8Array,
  record: Uint8Array,
  timestamp: number = Date.now(),
  createdAt: number = Date.now()
): Promise<void> {
  await initSignalDB();

  const data: DBKyberPreKeyRecord = {
    uuid,
    id,
    publicKey: uint8ArrayToBase64(publicKey),
    signature: uint8ArrayToBase64(signature),
    record: await wrapSecret(uint8ArrayToBase64(record)),
    timestamp,
    createdAt,
  };
  await put(STORES.KYBER_PRE_KEY, data);
}

/**
 * Load KyberPreKey record for WASM import. The wrapped `record` field
 * is unwrapped back to plaintext base64 before being decoded.
 */
export async function loadKyberPreKeyRecord(
  uuid: string,
  id: number
): Promise<{ id: number; record: Uint8Array } | undefined> {
  await initSignalDB();

  const data = await get<DBKyberPreKeyRecord>(STORES.KYBER_PRE_KEY, [uuid, id]);
  if (!data) return undefined;

  const recordBase64 = await unwrapSecret(data.record);
  return {
    id: data.id,
    record: base64ToUint8Array(recordBase64),
  };
}

/**
 * Load all KyberPreKey records for a device. The wrapped `record`
 * field of each record is unwrapped back to plaintext before being
 * decoded.
 */
export async function loadAllKyberPreKeyRecords(
  uuid: string
): Promise<{ id: number; record: Uint8Array; publicKey: Uint8Array; signature: Uint8Array; timestamp: number }[]> {
  await initSignalDB();

  const allData = await getAll<DBKyberPreKeyRecord>(STORES.KYBER_PRE_KEY);
  const out: { id: number; record: Uint8Array; publicKey: Uint8Array; signature: Uint8Array; timestamp: number }[] = [];
  for (const pk of allData) {
    if (pk.uuid !== uuid) continue;
    const recordBase64 = await unwrapSecret(pk.record);
    out.push({
      id: pk.id,
      record: base64ToUint8Array(recordBase64),
      publicKey: base64ToUint8Array(pk.publicKey),
      signature: base64ToUint8Array(pk.signature),
      timestamp: pk.timestamp,
    });
  }
  return out;
}

/**
 * Delete KyberPreKey record
 */
export async function deleteKyberPreKeyRecord(uuid: string, id: number): Promise<void> {
  await initSignalDB();
  await remove(STORES.KYBER_PRE_KEY, [uuid, id]);
}

// ==================== Import Functions for State Restoration ====================

/**
 * Import PreKeys with records (for state restoration)
 */
export async function importPreKeyssWithRecords(
  uuid: string,
  preKeys: { id: number; publicKey: string; privateKey?: string; record: string; createdAt: number }[]
): Promise<void> {
  for (const pk of preKeys) {
    await storePreKeyWithRecord(
      uuid,
      pk.id,
      base64ToUint8Array(pk.publicKey),
      base64ToUint8Array(pk.record),
      pk.createdAt
    );
  }
}

/**
 * Import SignedPreKeys (for state restoration)
 */
export async function importSignedPreKeys(
  signedPreKeys: {
    id: number;
    publicKey: string;
    privateKey: string;
    signature: string;
    record?: string;
    createdAt: number;
  }[]
): Promise<void> {
  const uuid = await loadLocalDeviceUuid();
  if (!uuid) throw new Error('No local device UUID found');
  
  for (const spk of signedPreKeys) {
    if (spk.record) {
      await storeSignedPreKeyWithRecord(
        uuid,
        spk.id,
        base64ToUint8Array(spk.publicKey),
        base64ToUint8Array(spk.signature),
        base64ToUint8Array(spk.record),
        spk.createdAt,
        spk.createdAt
      );
    }
  }
}

/**
 * Import KyberPreKeys (for state restoration)
 */
export async function importKyberPreKeys(
  kyberPreKeys: {
    id: number;
    publicKey: string;
    privateKey: string;
    signature: string;
    record?: string;
    createdAt: number;
  }[]
): Promise<void> {
  const uuid = await loadLocalDeviceUuid();
  if (!uuid) throw new Error('No local device UUID found');
  
  for (const kpk of kyberPreKeys) {
    if (kpk.record) {
      await storeKyberPreKeyWithRecord(
        uuid,
        kpk.id,
        base64ToUint8Array(kpk.publicKey),
        base64ToUint8Array(kpk.signature),
        base64ToUint8Array(kpk.record),
        kpk.createdAt,
        kpk.createdAt
      );
    }
  }
}

// ==================== Migration Functions ====================

/**
 * Migrate old-format PreKeys to new format with records
 * Returns count of migrated keys
 */
export async function migratePreKeysToNewFormat(
  oldPreKeys: { id: number; publicKey: string; privateKey?: string; record?: string; createdAt: number }[],
  uuid: string
): Promise<number> {
  let migratedCount = 0;
  
  for (const pk of oldPreKeys) {
    // Only migrate if there's no record (old format)
    if (!pk.record || pk.record.length === 0) {
      // Mark as needing regeneration by deleting
      await deletePreKeyRecord(uuid, pk.id);
      migratedCount++;
    }
  }
  
  return migratedCount;
}

// ==================== Export Types ====================

export type { DBKyberPreKeyRecord,DBPreKeyRecord, DBSignedPreKeyRecord };