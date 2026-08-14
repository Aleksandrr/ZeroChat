/**
 * Signal Protocol Storage Module
 * Re-exports all storage functions from submodules
 */

// Database infrastructure
export { clearAllSignalData,initSignalDB, STORES } from './db';

// Alias for compatibility
export { clearAllSignalData as clearAllStores } from './db';

// Identity key operations
export {
  cleanupOrphanedIdentityKeys,
  clearDeviceId,
  deleteIdentityKey,
  getAllIdentityKeys,
  getDeviceIdForRestore,
  getExistingDeviceId,
  getOrCreateDeviceId,
  hasIdentityKey,
  hasLocalDeviceUuid,
  loadIdentityKey,
  loadLocalDeviceUuid,
  loadRegistration,
  persistIdentity,
  storeIdentityKey,
  storeIdentityKeyWithOffsets,
  storeLocalDeviceUuid,
  storeRegistration,
} from './identity';

// PreKey operations
export {
  deleteKyberPreKeyRecord,
  deletePreKeyRecord,
  deleteSignedPreKeyRecord,
  getPreKeyCount,
  importKyberPreKeys,
  importPreKeyssWithRecords,
  importSignedPreKeys,
  loadAllKyberPreKeyRecords,
  loadAllPreKeyRecords,
  loadAllSignedPreKeyRecords,
  loadKyberPreKeyRecord,
  loadPreKeyRecord,
  loadSignedPreKeyRecord,
  migratePreKeysToNewFormat,
  storeKyberPreKeyWithRecord,
  storePreKey,
  storePreKeyRecords,
  storePreKeyWithRecord,
  storeSignedPreKeyWithRecord,
} from './keys';

// Session operations
export {
  deleteSession,
  deleteSessionRecord,
  generateSessionId,
  getAllSessions,
  getSessionCount,
  getSessionRecord,
  hasSession,
  importSessions,
  loadAllSessionRecords,
  loadSessionRecord,
  storeSessionWithRecord,
} from './sessions';

// Sesame multi-device operations
export {
  cleanupExpiredLinkingRequests,
  cleanupStaleUserRecords,
  deleteLinkedDevice,
  deleteLinkingRequest,
  deleteSenderKey,
  deleteUserRecord,
  generateSenderKeyId,
  getAllLinkedDevices,
  getAllSenderKeys,
  getLinkedDevice,
  getLinkedDeviceByDeviceId,
  getLinkingRequest,
  getSenderKey,
  getSenderKeysByGroup,
  getUserRecord,
  importSenderKeys,
  loadSesameState,
  storeLinkedDevice,
  storeLinkingRequest,
  storeSenderKey,
  storeSesameState,
  storeUserRecord,
  updateLinkedDeviceLastSeen,
} from './sesame';

// Alias for compatibility
export { deleteLinkedDevice as unlinkDevice } from './sesame';

// State persistence
export {
  clearSignalClientState,
  exportFullSignalState,
  getSignalStorageStats,
  loadSignalClientState,
  saveSignalClientState,
  verifySignalStateIntegrity,
} from './state';

// Types
export type { DBKyberPreKeyRecord,DBPreKeyRecord, DBSignedPreKeyRecord } from './keys';
export type { DBLinkedDevice, DBLinkingRequest, DBSenderKey, DBSesameState } from './sesame';
export type { DBSessionLegacy,DBSessionRecord } from './sessions';
export type { FullSignalState, KeyOffsets } from './state';