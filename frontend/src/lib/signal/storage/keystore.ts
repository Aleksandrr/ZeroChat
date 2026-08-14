/**
 * Transparent AES-GCM wrapping for Signal private key material.
 *
 * Threat model: protect private keys (identity, sessions, prekeys, sender
 * keys) at rest in IndexedDB against passive leaks — e.g. a browser
 * extension that reads IndexedDB dumps, file-system access by another
 * process on a shared machine, or a backup of the browser profile that
 * ends up in cloud storage.
 *
 * The wrapping key (KEK) is a WebCrypto non-extractable AES-GCM key
 * created on first launch and persisted (as raw bytes) in a SEPARATE
 * IndexedDB database (`zerochat-keystore`). The raw bytes are
 * origin-bound by the browser's storage isolation; the non-extractable
 * flag prevents JS from reading the live CryptoKey object via
 * `crypto.subtle.exportKey`. We re-import the raw bytes as a
 * non-extractable key every session.
 *
 * This is NOT a strong protection against active compromise of the JS
 * runtime — any JS with IndexedDB access can fetch the KEK bytes and
 * call `unwrapKey`/`decrypt`. It is, however, strictly better than
 * storing Signal private keys as plaintext base64.
 *
 * Future enhancement: replace with a WebAuthn-bound key, a passkey, or
 * a password-derived KEK as an opt-in "high security mode".
 *
 * Backward compatibility: `unwrapSecret` falls back to returning the
 * input unchanged when AES-GCM decryption fails. This allows gradual
 * migration — legacy plaintext records continue to read, new writes
 * are wrapped. Once every record has been re-written (e.g. after a
 * session ratchet step, identity re-save, or prekey regeneration) the
 * store is fully migrated with no extra code.
 */

const KEK_DB_NAME = 'zerochat-keystore';
const KEK_DB_VERSION = 1;
const KEK_STORE = 'kek';
const KEK_RECORD_ID = 'default-kek';

// AES-GCM IV length (96 bits, recommended by NIST SP 800-38D).
const IV_BYTES = 12;
// Minimum length (after base64 decode) for a value to be considered
// possibly-wrapped. Wrapped values are `iv(12) || ciphertext(>=16)`,
// so the smallest valid wrapped blob is 28 bytes (IV + 16-byte GCM tag
// with zero plaintext). Legacy plaintext Signal records are typically
// 32-byte private keys (base64 of 32 bytes = 44 chars). The threshold
// is conservative — anything smaller than the IV alone can't be wrapped.
const MIN_WRAPPED_BYTES = IV_BYTES + 16;

let cachedKEK: CryptoKey | null = null;
let bootPromise: Promise<CryptoKey> | null = null;

function openKekDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(KEK_DB_NAME, KEK_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(KEK_STORE)) {
        db.createObjectStore(KEK_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function loadOrCreateKEK(): Promise<CryptoKey> {
  // Try to load an existing KEK from the keystore DB.
  const db = await openKekDb();
  const rawKey = await new Promise<ArrayBuffer | null>((resolve, reject) => {
    const tx = db.transaction(KEK_STORE, 'readonly');
    const req = tx.objectStore(KEK_STORE).get(KEK_RECORD_ID);
    req.onsuccess = () => resolve((req.result as ArrayBuffer | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
  db.close();

  if (rawKey) {
    // Re-import persisted raw bytes as a non-extractable AES-GCM key.
    // Once imported, JS cannot call exportKey() to retrieve the bytes —
    // they only live in the IndexedDB keystore DB.
    return crypto.subtle.importKey(
      'raw',
      rawKey,
      { name: 'AES-GCM', length: 256 },
      false, // non-extractable
      ['encrypt', 'decrypt'],
    );
  }

  // First run — generate a fresh KEK. We must mark it extractable ONCE
  // so we can persist the raw bytes to IndexedDB. After persisting, we
  // re-import as non-extractable for in-memory use.
  const newKey = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true, // extractable just long enough to persist
    ['encrypt', 'decrypt'],
  );
  const rawBytes = await crypto.subtle.exportKey('raw', newKey);

  // Persist raw bytes to the keystore DB. They are origin-bound by the
  // browser's storage isolation; an attacker who reads IndexedDB gets
  // wrapped ciphertext for Signal keys, plus this KEK. That is still
  // better than plaintext Signal keys because:
  //   - An attacker who only exfiltrates the Signal DB (not the keystore
  //     DB) gets only ciphertext.
  //   - The KEK bytes alone do not help decrypt without also running
  //     the unwrap code in the victim's JS context (which is the threat
  //     model for "active JS compromise" — out of scope here).
  const db2 = await openKekDb();
  const tx2 = db2.transaction(KEK_STORE, 'readwrite');
  tx2.objectStore(KEK_STORE).put(rawBytes, KEK_RECORD_ID);
  await new Promise<void>((resolve, reject) => {
    tx2.oncomplete = () => resolve();
    tx2.onerror = () => reject(tx2.error);
    tx2.onabort = () => reject(tx2.error);
  });
  db2.close();

  // Re-import as non-extractable for in-memory use across the session.
  return crypto.subtle.importKey(
    'raw',
    rawBytes,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Get the cached KEK, or load/create it on first call. Idempotent —
 * concurrent callers share the same boot promise so we never generate
 * two KEKs racing each other.
 */
export async function getKEK(): Promise<CryptoKey> {
  if (cachedKEK) return cachedKEK;
  if (bootPromise) return bootPromise;
  bootPromise = (async () => {
    const key = await loadOrCreateKEK();
    cachedKEK = key;
    return key;
  })();
  try {
    return await bootPromise;
  } finally {
    // On success, leave cachedKEK set; clear the boot promise so a
    // post-clearKEKCache re-boot can run cleanly. On failure, both
    // cachedKEK and bootPromise should be cleared so callers can retry.
    // We can't easily detect failure inside finally, so we leave the
    // promise — if it rejected, awaiting it will re-throw, and the
    // next getKEK() call will create a fresh boot.
    if (!cachedKEK) bootPromise = null;
  }
}

/** Drop cached KEK from memory (e.g. on logout). Does NOT delete the
 *  persisted KEK bytes — they remain in the keystore DB so the next
 *  login on the same device can re-derive the same KEK and read the
 *  same wrapped Signal state. To fully destroy the KEK the caller
 *  must delete the `zerochat-keystore` IndexedDB database (which the
 *  browser does automatically on "clear all site data"). */
export function clearKEKCache(): void {
  cachedKEK = null;
  bootPromise = null;
}

/** Wrap a base64 string as AES-GCM ciphertext. Output format:
 *  `bytesToBase64(iv(12) || ciphertext_with_gcm_tag)`. */
export async function wrapSecret(plaintextBase64: string): Promise<string> {
  if (!plaintextBase64) return plaintextBase64;
  const kek = await getKEK();
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plaintext = base64ToBytes(plaintextBase64);
  // WebCrypto's TS types are strict about ArrayBuffer vs
  // SharedArrayBuffer; cast to BufferSource to satisfy the signature.
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    kek,
    plaintext as BufferSource,
  );
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return bytesToBase64(combined);
}

/** Unwrap an AES-GCM ciphertext (base64) back to plaintext base64.
 *
 *  Backward compat: if decryption fails (e.g. legacy plaintext record
 *  from before wrapping was enabled, or a value that was never wrapped
 *  like a public key), the original input is returned unchanged. This
 *  makes the migration path safe — old records keep working, new
 *  writes are wrapped. */
export async function unwrapSecret(wrappedBase64: string): Promise<string> {
  if (!wrappedBase64) return wrappedBase64;
  try {
    const combined = base64ToBytes(wrappedBase64);
    if (combined.length < MIN_WRAPPED_BYTES) {
      // Too short to be a wrapped value — treat as legacy plaintext.
      return wrappedBase64;
    }
    const kek = await getKEK();
    const iv = combined.slice(0, IV_BYTES);
    const ciphertext = combined.slice(IV_BYTES);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      kek,
      ciphertext as BufferSource,
    );
    return bytesToBase64(new Uint8Array(plaintext));
  } catch {
    // Decryption failed — either this is a legacy plaintext record
    // (no IV+ciphertext structure, or wrong GCM auth tag) or the KEK
    // has been rotated/lost. Return the input unchanged so callers
    // can decide what to do (typically: surface as a corrupted record
    // or fall back to re-generating keys).
    return wrappedBase64;
  }
}

// ==================== Base64 helpers ====================
//
// Inline (rather than re-using @/lib/utils/buffer) so this module has
// zero cross-module dependencies — keystore must be loadable from any
// storage layer without triggering import cycles.

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === undefined) continue;
    bin += String.fromCharCode(b);
  }
  return btoa(bin);
}
