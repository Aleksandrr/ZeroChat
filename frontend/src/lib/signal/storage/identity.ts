/**
 * Identity Key Storage for Signal Protocol
 * Handles storage of identity key pairs and registration data
 */

import { base64ToUint8Array,uint8ArrayToBase64 } from '@/lib/utils/buffer';
import { secureRandomInt } from '@/lib/utils';

import type { IdentityKeyData, RegistrationData } from '../types';
import { get, getAll, initSignalDB, put, remove, STORES } from './db';
import { wrapSecret, unwrapSecret } from './keystore';
import { checkSignalDeviceId } from '@/services/device-check';
import { getAccessToken } from '@/services/auth/tokens';

// ==================== Identity Key Operations ====================

/**
 * Store identity key pair for a user. The private key is wrapped with
 * the device-bound KEK before being written to IndexedDB; the public
 * key is left as plaintext (it is, by definition, public).
 */
export async function storeIdentityKey(
  userId: string,
  publicKey: string,
  privateKey: string
): Promise<void> {
  await initSignalDB();

  const wrappedPrivateKey = await wrapSecret(privateKey);
  const data: IdentityKeyData = {
    id: `${userId}_identity`,
    userId,
    publicKey,
    privateKey: wrappedPrivateKey,
    createdAt: Date.now(),
  };
  await put(STORES.IDENTITY_KEY, data);
}

/**
 * Persist identity key with next*Id counters
 * Used to save identity along with current counter state after key generation
 *
 * The private key is preserved from the existing record (already wrapped
 * at rest) — we do NOT unwrap-then-rewrap on every counter update, both
 * for efficiency and to avoid mutating the wrapped ciphertext when no
 * Signal private key material has changed.
 */
export async function persistIdentity(
  userId: string,
  identityKey: string,
  registrationId: number,
  nextPreKeyId: number,
  nextSignedPreKeyId: number,
  nextKyberPreKeyId: number
): Promise<void> {
  await initSignalDB();

  // First load existing identity to preserve keys if they exist.
  // `loadIdentityKey` already unwraps the private key into plaintext —
  // we re-wrap it here so the persisted form stays wrapped.
  const existing = await loadIdentityKey(userId);

  const data: IdentityKeyData = {
    id: `${userId}_identity`,
    userId,
    publicKey: identityKey,
    privateKey: existing?.privateKey ? await wrapSecret(existing.privateKey) : '',
    createdAt: existing?.createdAt || Date.now(),
    nextPreKeyId,
    nextSignedPreKeyId,
    nextKyberPreKeyId,
  };
  await put(STORES.IDENTITY_KEY, data);
}

/**
 * Store identity key with offsets metadata. The private key is wrapped
 * with the device-bound KEK before being written to IndexedDB.
 */
export async function storeIdentityKeyWithOffsets(
  userId: string,
  publicKey: string,
  privateKey: string,
  offsets: { createdAt: number; firstUse: number | null; verified: number | null; name: string }
): Promise<void> {
  await initSignalDB();

  const wrappedPrivateKey = await wrapSecret(privateKey);
  const data: IdentityKeyData = {
    id: `${userId}_identity`,
    userId,
    publicKey,
    privateKey: wrappedPrivateKey,
    createdAt: offsets.createdAt,
    nextPreKeyId: undefined,
    nextSignedPreKeyId: undefined,
    nextKyberPreKeyId: undefined,
  };
  await put(STORES.IDENTITY_KEY, data);
}

/**
 * Load identity key for a user. The private key is unwrapped from
 * device-bound AES-GCM ciphertext back to plaintext base64. Legacy
 * plaintext records are returned as-is (the unwrap fallback handles
 * them transparently).
 */
export async function loadIdentityKey(userId: string): Promise<IdentityKeyData | undefined> {
  await initSignalDB();
  const stored = await get<IdentityKeyData>(STORES.IDENTITY_KEY, `${userId}_identity`);
  if (!stored) return undefined;
  // Unwrap only if there is a private key stored — early identities
  // created during a partial migration may have an empty privateKey.
  if (stored.privateKey) {
    stored.privateKey = await unwrapSecret(stored.privateKey);
  }
  return stored;
}

/**
 * Check if identity key exists for a user
 */
export async function hasIdentityKey(userId: string): Promise<boolean> {
  const key = await loadIdentityKey(userId);
  return !!key;
}

/**
 * Get all identity keys from storage
 */
export async function getAllIdentityKeys(): Promise<IdentityKeyData[]> {
  await initSignalDB();
  return getAll<IdentityKeyData>(STORES.IDENTITY_KEY);
}

/**
 * Delete identity key for a specific user
 */
export async function deleteIdentityKey(userId: string): Promise<void> {
  await initSignalDB();
  await remove(STORES.IDENTITY_KEY, `${userId}_identity`);
}

/**
 * Clean up orphaned identity keys (keys that don't belong to the current user)
 */
export async function cleanupOrphanedIdentityKeys(currentUserId: string): Promise<void> {
  try {
    const allKeys = await getAllIdentityKeys();
    let cleanedCount = 0;
    
    for (const key of allKeys) {
      if (key.userId !== currentUserId) {
        await deleteIdentityKey(key.userId);
        cleanedCount++;
      }
    }
    
  } catch (error) {
    // Silent fail - cleanup is best-effort
  }
}

// ==================== Registration Operations ====================

/**
 * Store registration data
 */
export async function storeRegistration(data: RegistrationData): Promise<void> {
  await initSignalDB();
  await put(STORES.REGISTRATION, { id: 'current', ...data });
}

/**
 * Load registration data
 */
export async function loadRegistration(): Promise<RegistrationData | undefined> {
  await initSignalDB();
  return get<RegistrationData>(STORES.REGISTRATION, 'current');
}

// ==================== Device ID Operations ====================

const STORAGE_DEVICE_ID_KEY = 'deviceId';

// RC-8 fix: Mutex to prevent parallel deviceId generation
let deviceIdPromise: Promise<number> | null = null;

/**
 * Get existing Signal deviceId without creating a new one
 * Returns null if no valid deviceId exists
 */
export async function getExistingDeviceId(): Promise<number | null> {
  await initSignalDB();
  
  try {
    const existing = await get<{ id: string; deviceId: number }>(STORES.REGISTRATION, STORAGE_DEVICE_ID_KEY);
    if (existing && existing.deviceId >= 1 && existing.deviceId <= 127) {
      return existing.deviceId;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Get deviceId for restoration (skip server check - we already own this deviceId)
 * Used when restoring existing Signal state
 */
export async function getDeviceIdForRestore(): Promise<number | null> {
  await initSignalDB();
  
  try {
    const existing = await get<{ id: string; deviceId: number }>(STORES.REGISTRATION, STORAGE_DEVICE_ID_KEY);
    if (existing && existing.deviceId >= 1 && existing.deviceId <= 127) {
      return existing.deviceId;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Get or create a persistent device ID for this device
 * Generates a unique device ID and stores it in IndexedDB
 * 
 * RC-8 fix: Uses promise-based mutex to prevent parallel deviceId generation.
 * If two calls happen simultaneously, both will return the same deviceId.
 * 
 * @param skipServerCheck - If true, skip server availability check (used for restoration)
 */
export async function getOrCreateDeviceId(skipServerCheck = false): Promise<number> {
  // RC-8 fix: If already generating, wait for the result
  if (deviceIdPromise) {
    return deviceIdPromise;
  }
  
   deviceIdPromise = (async (): Promise<number> => {
     await initSignalDB();

     // Use direct imports (circular dependency broken via device-check module)
     const token = getAccessToken();

     try {
      const existing = await get<{ id: string; deviceId: number }>(STORES.REGISTRATION, STORAGE_DEVICE_ID_KEY);
      if (existing && existing.deviceId >= 1 && existing.deviceId <= 127) {
        // If skipServerCheck is true, trust the existing deviceId (restoration scenario)
        if (skipServerCheck) {
          return existing.deviceId;
        }
        
        // Check if the existing device ID is still available on the server
        try {
          if (getAccessToken()) {
            const isAvailable = await checkSignalDeviceId(existing.deviceId);
            if (!isAvailable) {
              await remove(STORES.REGISTRATION, STORAGE_DEVICE_ID_KEY);
            } else {
              return existing.deviceId;
            }
          } else {
            // No token yet (initial login) - trust existing deviceId
            return existing.deviceId;
          }
        } catch (e) {
          return existing.deviceId;
        }
      }
      
      // Clear invalid device ID if present
      if (existing) {
        await remove(STORES.REGISTRATION, STORAGE_DEVICE_ID_KEY);
      }
      
      // Generate unique device ID within Signal Protocol valid range (1-127)
      const maxAttempts = 10;
      let newDeviceId: number | null = null;
      
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        // U1: CSPRNG-backed candidateId instead of Math.random() — avoids
        // predictable device IDs that an attacker could use to impersonate a
        // device during the Signal Protocol registration handshake.
        const candidateId = secureRandomInt(1, 127);
        
        try {
          const token = getAccessToken();
          if (token && !skipServerCheck) {
            const isAvailable = await checkSignalDeviceId(candidateId);
            if (isAvailable) {
              newDeviceId = candidateId;
              break;
            }
          } else {
            newDeviceId = candidateId;
            break;
          }
        } catch (e) {
          newDeviceId = candidateId;
          break;
        }
      }
      
      if (newDeviceId === null) {
        newDeviceId = secureRandomInt(1, 127);
      }
      
      await put(STORES.REGISTRATION, { id: STORAGE_DEVICE_ID_KEY, deviceId: newDeviceId });
      
      return newDeviceId;
    } catch (error) {
      console.error('[Signal] Failed to get/create deviceId:', error);
      // U1: still prefer CSPRNG on the fallback path.
      try {
        return secureRandomInt(1, 127);
      } catch {
        return Math.floor(Math.random() * 127) + 1;
      }
    }
  })();
  
  try {
    return await deviceIdPromise;
  } finally {
    deviceIdPromise = null;
  }
}

/**
 * Clear the stored device ID
 */
export async function clearDeviceId(): Promise<void> {
  await initSignalDB();
  await remove(STORES.REGISTRATION, STORAGE_DEVICE_ID_KEY);
}

// ==================== Local Device UUID Operations ====================

interface DBLocalDevice {
  id: string;
  uuid: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Store local device UUID
 */
export async function storeLocalDeviceUuid(uuid: string): Promise<void> {
  await initSignalDB();
  
  const data: DBLocalDevice = {
    id: 'local_device',
    uuid,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await put('localDevice', data);
}

/**
 * Load local device UUID
 */
export async function loadLocalDeviceUuid(): Promise<string | null> {
  await initSignalDB();
  const data = await get<DBLocalDevice>('localDevice', 'local_device');
  
  if (!data?.uuid) return null;
  
  // Handle legacy Uint8Array stored as object (from old generate_uuid())
  const uuid = data.uuid;
  if (typeof uuid === 'string') {
    return uuid;
  }
  
  // Convert legacy Uint8Array to string and update storage
  if (typeof uuid === 'object' && uuid !== null) {
    // Check if it's a Uint8Array-like object
    const bytes = Object.values(uuid as Record<string, unknown>);
    if (Array.isArray(bytes) && bytes.length === 16) {
      const hex = (bytes as number[]).map(b => b.toString(16).padStart(2, '0')).join('');
      const uuidString = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
      
      // Update storage with correct string format
      await storeLocalDeviceUuid(uuidString);
      return uuidString;
    }
  }
  
  return null;
}

/**
 * Check if local device UUID exists
 */
export async function hasLocalDeviceUuid(): Promise<boolean> {
  const uuid = await loadLocalDeviceUuid();
  return !!uuid;
}