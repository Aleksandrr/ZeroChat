/**
 * IndexedDB Infrastructure for Signal Protocol Storage
 * Provides low-level database operations for all storage modules
 */

// Database configuration
const DB_NAME = 'ZeroChatSignalDB';
const DB_VERSION = 4;

// Store names as constants
export const STORES = {
  IDENTITY_KEY: 'identityKeys',
  PRE_KEY: 'preKeys',
  SIGNED_PRE_KEY: 'signedPreKeys',
  KYBER_PRE_KEY: 'kyberPreKeys',
  SESSION: 'sessions',
  SENDER_KEY: 'senderKeys',
  REGISTRATION: 'registration',
  LINKED_DEVICES: 'linkedDevices',
  LINKING_REQUESTS: 'linkingRequests',
  SESAME_STATE: 'sesameState',
  SIGNAL_CLIENT_STATE: 'signalClientState',
} as const;

// Database instance
let db: IDBDatabase | null = null;

// RC-8 fix: Mutex to prevent parallel DB initialization
let signalDbInitPromise: Promise<IDBDatabase> | null = null;

// ==================== Database Initialization ====================

/**
 * Initialize Signal Protocol IndexedDB
 * Creates or opens the database with all required object stores
 * 
 * RC-8 fix: Uses promise-based mutex to prevent parallel initialization.
 * If two calls happen simultaneously, both will wait for the same connection.
 */
export async function initSignalDB(): Promise<IDBDatabase> {
  // Check if we have a valid, open database connection
  if (db && db.version !== 0) {
    try {
      // Test if the database is still accessible
      const transaction = db.transaction(STORES.REGISTRATION, 'readonly');
      transaction.onerror = () => {
        db = null;
      };
      transaction.commit?.();
      return db;
    } catch {
      db = null;
    }
  }
  
  // RC-8 fix: If already initializing, wait for the existing promise
  if (signalDbInitPromise) {
    return signalDbInitPromise;
  }
  
  signalDbInitPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      signalDbInitPromise = null;
      reject(request.error);
    };

    (request as any).onabort = () => {
      signalDbInitPromise = null;
      reject(new DOMException('Database upgrade aborted', 'AbortError'));
    };

    request.onsuccess = () => {
      db = request.result;
      signalDbInitPromise = null;
      resolve(db);
    };

    request.onupgradeneeded = (event) => {
      const database = (event.target as IDBOpenDBRequest).result;

      // Identity Keys store
      if (!database.objectStoreNames.contains(STORES.IDENTITY_KEY)) {
        database.createObjectStore(STORES.IDENTITY_KEY, { keyPath: 'id' });
      }

      // Pre Keys store (with uuid compound key)
      if (!database.objectStoreNames.contains(STORES.PRE_KEY)) {
        const preKeyStore = database.createObjectStore(STORES.PRE_KEY, { keyPath: ['uuid', 'id'] });
        preKeyStore.createIndex('id', 'id', { unique: false });
        preKeyStore.createIndex('createdAt', 'createdAt', { unique: false });
      }

      // Signed Pre Keys store (with uuid compound key)
      if (!database.objectStoreNames.contains(STORES.SIGNED_PRE_KEY)) {
        const store = database.createObjectStore(STORES.SIGNED_PRE_KEY, { keyPath: ['uuid', 'id'] });
        store.createIndex('id', 'id', { unique: false });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }

      // Kyber Pre Keys store (PQXDH, with uuid compound key)
      if (!database.objectStoreNames.contains(STORES.KYBER_PRE_KEY)) {
        const store = database.createObjectStore(STORES.KYBER_PRE_KEY, { keyPath: ['uuid', 'id'] });
        store.createIndex('id', 'id', { unique: false });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }

      // Sessions store (with compound key)
      if (!database.objectStoreNames.contains(STORES.SESSION)) {
        const sessionStore = database.createObjectStore(STORES.SESSION, { keyPath: ['localUuid', 'remoteUuid', 'remoteDeviceId'] });
        sessionStore.createIndex('remoteUuid', 'remoteUuid', { unique: false });
        sessionStore.createIndex('remoteDeviceId', 'remoteDeviceId', { unique: false });
      }

      // Sender Keys store (for groups)
      if (!database.objectStoreNames.contains(STORES.SENDER_KEY)) {
        const store = database.createObjectStore(STORES.SENDER_KEY, { keyPath: 'id' });
        store.createIndex('groupId', 'groupId', { unique: false });
      }

      // Registration data store
      if (!database.objectStoreNames.contains(STORES.REGISTRATION)) {
        database.createObjectStore(STORES.REGISTRATION, { keyPath: 'id' });
      }

      // Linked Devices store (Sesame)
      if (!database.objectStoreNames.contains(STORES.LINKED_DEVICES)) {
        const store = database.createObjectStore(STORES.LINKED_DEVICES, { keyPath: 'id' });
        store.createIndex('deviceId', 'deviceId', { unique: true });
      }

      // Linking Requests store (Sesame)
      if (!database.objectStoreNames.contains(STORES.LINKING_REQUESTS)) {
        const store = database.createObjectStore(STORES.LINKING_REQUESTS, { keyPath: 'id' });
        store.createIndex('expiresAt', 'expiresAt', { unique: false });
      }

      // Sesame State store
      if (!database.objectStoreNames.contains(STORES.SESAME_STATE)) {
        database.createObjectStore(STORES.SESAME_STATE, { keyPath: 'id' });
      }

      // Local Device UUID store
      if (!database.objectStoreNames.contains('localDevice')) {
        database.createObjectStore('localDevice', { keyPath: 'id' });
      }

      // Signal Client State store
      if (!database.objectStoreNames.contains(STORES.SIGNAL_CLIENT_STATE)) {
        database.createObjectStore(STORES.SIGNAL_CLIENT_STATE, { keyPath: 'id' });
      }
    };
  });
  
  return signalDbInitPromise;
}

// ==================== Generic Operations ====================

/**
 * Get object store for transactions
 */
function getStore(storeName: string, mode: IDBTransactionMode = 'readonly'): IDBObjectStore {
  if (!db) throw new Error('Database not initialized. Call initSignalDB() first.');
  
  const transaction = db.transaction(storeName, mode);
  return transaction.objectStore(storeName);
}

/**
 * Put data into store
 */
export async function put<T>(storeName: string, data: T): Promise<void> {
  return new Promise((resolve, reject) => {
    const store = getStore(storeName, 'readwrite');
    const request = store.put(data);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/**
 * Get data from store by key
 */
export async function get<T>(
  storeName: string,
  key: string | number | [string, number] | [string, string, number]
): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const store = getStore(storeName);
    const request = store.get(key);
    request.onsuccess = () => resolve(request.result as T);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Get all data from store
 */
export async function getAll<T>(storeName: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const store = getStore(storeName);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result as T[]);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Remove data from store by key
 */
export async function remove(
  storeName: string,
  key: string | number | [string, number] | [string, string, number]
): Promise<void> {
  return new Promise((resolve, reject) => {
    const store = getStore(storeName, 'readwrite');
    const request = store.delete(key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/**
 * Clear all data from store
 */
export async function clear(storeName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const store = getStore(storeName, 'readwrite');
    const request = store.clear();
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/**
 * Clear all Signal data from all stores
 */
export async function clearAllSignalData(): Promise<void> {
  const storeNames = Object.values(STORES);
  
  for (const storeName of storeNames) {
    await clear(storeName);
  }
  
  // Also clear localDevice store
  await clear('localDevice');
}