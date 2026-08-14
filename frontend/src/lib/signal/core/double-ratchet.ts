/**
 * Double Ratchet Algorithm
 * Provides forward secrecy and break-in recovery for messaging
 * 
 * The Double Ratchet combines:
 * 1. Symmetric key ratchet - for message encryption
 * 2. Diffie-Hellman ratchet - for forward secrecy
 * 
 * Each message advances the ratchet state, ensuring that
 * compromise of current keys doesn't expose past messages.
 */

// @ts-nocheck - WASM types may not match perfectly

import { base64ToUint8Array,uint8ArrayToBase64 } from '@/lib/utils/buffer';

import type { DecryptedMessage,EncryptedMessage } from '../types';
import { deriveKeys,hkdf, sha256 } from '../utils/crypto';

// ==================== Constants ====================

/** Maximum number of message keys to keep for skipped messages */
const MAX_MESSAGE_KEYS = 2000;

/** Message type constants */
export const MESSAGE_TYPES = {
  PRE_KEY: 3,      // PreKeyMessage - establishes new session
  SIGNAL: 2,       // SignalMessage - existing session
  SENDER_KEY: 4,   // SenderKeyMessage - group messaging
};

// ==================== Double Ratchet State ====================

interface DoubleRatchetState {
  // DH ratchet
  DHs: { publicKey: Uint8Array; privateKey: Uint8Array }; // Self key pair
  DHr: Uint8Array; // Remote public key
  
  // Symmetric key ratchet
  RK: Uint8Array;  // Root key
  CKs: Uint8Array; // Sending chain key
  CKr: Uint8Array; // Receiving chain key
  
  // Message numbers
  Ns: number;  // Sending message number
  Nr: number;  // Receiving message number
  
  // Previous sending chain
  PN: number;  // Previous sending chain length
  
  // Skipped message keys (for out-of-order messages)
  MKSkipped: Map<string, Uint8Array>;
}

// ==================== Encryption ====================

/**
 * Encrypt a message using the Double Ratchet
 * 
 * This function:
 * 1. Advances the sending chain
 * 2. Derives a message key
 * 3. Encrypts the plaintext
 * 4. Returns the encrypted message with header
 */
export async function encryptMessage(
  client: any,
  recipientId: string,
  recipientDeviceId: number,
  plaintext: Uint8Array
): Promise<EncryptedMessage> {
  if (!client) {
    throw new Error('SignalClient not initialized');
  }
  
  // Encrypt through WASM
  const result = await client.encrypt_message(recipientId, recipientDeviceId, plaintext);
  
  const messageType = result.message_type;
  
  return {
    type: messageType,
    body: result.body,
    senderUserId: '', // Will be filled by caller
    senderDeviceId: 0, // Will be filled by caller
  };
}

// ==================== Decryption ====================

/**
 * Decrypt a message using the Double Ratchet
 * 
 * This function:
 * 1. Handles message key skipping for out-of-order messages
 * 2. Advances the receiving chain
 * 3. Derives the message key
 * 4. Decrypts the ciphertext
 */
export async function decryptMessage(
  client: any,
  senderId: string,
  senderDeviceId: number,
  ciphertext: Uint8Array,
  messageType: number
): Promise<DecryptedMessage> {
  if (!client) {
    throw new Error('SignalClient not initialized');
  }
  
  // Decrypt through WASM
  const plaintext = await client.decrypt_message(senderId, senderDeviceId, ciphertext, messageType);
  
  return {
    type: messageType,
    body: plaintext,
    senderUserId: senderId,
    senderDeviceId,
  };
}

// ==================== Session Management ====================

/**
 * Check if a session exists in WASM
 */
export async function hasWasmSession(
  client: any,
  recipientId: string,
  deviceId: number
): Promise<boolean> {
  if (!client || !client.has_session) {
    return false;
  }
  
  return client.has_session(recipientId, deviceId);
}

/**
 * Export session state for persistence
 */
export async function exportSession(
  client: any,
  recipientId: string,
  deviceId: number
): Promise<Uint8Array | null> {
  if (!client || !client.export_session) {
    return null;
  }
  
  return client.export_session(recipientId, deviceId);
}

/**
 * Import session state from persisted data
 */
export async function importSession(
  client: any,
  recipientId: string,
  deviceId: number,
  sessionBytes: Uint8Array
): Promise<void> {
  if (!client || !client.import_session) {
    throw new Error('Session import not supported');
  }
  
  await client.import_session(recipientId, deviceId, sessionBytes);
}

/**
 * Archive (deactivate) a session
 */
export async function archiveSession(
  client: any,
  recipientId: string,
  deviceId: number
): Promise<void> {
  if (!client) {
    throw new Error('SignalClient not initialized');
  }
  
  if (client.archive_session) {
    await client.archive_session(recipientId, deviceId);
  }
}

// ==================== Key Ratcheting ====================
//
// SECURITY (P0-4): The previous implementations of `advanceSendingChain`,
// `advanceReceivingChain`, and `dhRatchetStep` were broken JS stubs:
//   - KDF used plain SHA-256 (vulnerable to length-extension) instead of
//     HMAC-SHA256.
//   - Domain-separation constants were `'msg'[0]` / `'chain'[0]` (the
//     bytes 0x6d / 0x63) instead of the spec-mandated 0x01 / 0x02.
//   - `dhRatchetStep` did not actually perform a DH calculation — it
//     only mutated counters, so root-key/chain-key derivation was
//     effectively skipped.
// Anyone calling these functions would silently get an insecure
// ratchet state, which is worse than failing loudly. signal-wasm 0.2.x
// already implements the Double Ratchet correctly inside
// `encryptMessage` / `decryptMessage`, so these helpers are no longer
// needed. They now throw a descriptive error so that any stale caller
// is forced to switch to the WASM-backed API.

/**
 * @deprecated Double Ratchet is handled by signal-wasm. Do not call.
 *
 * Calling this function means the caller is trying to advance a sending
 * chain in pure JS, which is insecure (see P0-4 above). Use
 * `encryptMessage` from `@/lib/signal` instead — it advances the chain
 * inside signal-wasm with a correct HMAC-based KDF.
 */
export async function advanceSendingChain(_state: DoubleRatchetState): Promise<never> {
  throw new Error(
    'advanceSendingChain removed (P0-4): Double Ratchet is handled by signal-wasm. ' +
      'Use `encryptMessage` from @/lib/signal instead.',
  );
}

/**
 * @deprecated Double Ratchet is handled by signal-wasm. Do not call.
 *
 * See `advanceSendingChain` for rationale. Use `decryptMessage` from
 * `@/lib/signal` instead.
 */
export async function advanceReceivingChain(_state: DoubleRatchetState): Promise<never> {
  throw new Error(
    'advanceReceivingChain removed (P0-4): Double Ratchet is handled by signal-wasm. ' +
      'Use `decryptMessage` from @/lib/signal instead.',
  );
}

/**
 * @deprecated Double Ratchet is handled by signal-wasm. Do not call.
 *
 * See `advanceSendingChain` for rationale. The DH ratchet step is
 * performed automatically inside `encryptMessage` / `decryptMessage`
 * when a new remote DH header is observed.
 */
export async function dhRatchetStep(
  _state: DoubleRatchetState,
  _newRemotePublicKey: Uint8Array,
): Promise<never> {
  throw new Error(
    'dhRatchetStep removed (P0-4): Double Ratchet is handled by signal-wasm. ' +
      'The DH ratchet advances automatically inside encryptMessage/decryptMessage.',
  );
}

// ==================== Message Key Skipping ====================

/**
 * Store a skipped message key for later decryption
 */
export function storeSkippedMessageKey(
  state: DoubleRatchetState,
  publicKey: Uint8Array,
  messageNumber: number,
  messageKey: Uint8Array
): void {
  const key = `${uint8ArrayToBase64(publicKey)}:${messageNumber}`;
  state.MKSkipped.set(key, messageKey);
  
  // Limit stored keys
  if (state.MKSkipped.size > MAX_MESSAGE_KEYS) {
    // Remove oldest key
    const firstKey = state.MKSkipped.keys().next().value;
    if (firstKey) {
      state.MKSkipped.delete(firstKey);
    }
  }
}

/**
 * Find a skipped message key
 */
export function findSkippedMessageKey(
  state: DoubleRatchetState,
  publicKey: Uint8Array,
  messageNumber: number
): Uint8Array | null {
  const key = `${uint8ArrayToBase64(publicKey)}:${messageNumber}`;
  return state.MKSkipped.get(key) || null;
}

// ==================== Utility Functions ====================

/**
 * Get the current sending message number
 */
export function getSendingMessageNumber(state: DoubleRatchetState): number {
  return state.Ns;
}

/**
 * Get the current receiving message number
 */
export function getReceivingMessageNumber(state: DoubleRatchetState): number {
  return state.Nr;
}

/**
 * Check if the DH ratchet needs to advance
 */
export function needsDHRatchet(state: DoubleRatchetState, remoteHeader: { publicKey: Uint8Array; messageNumber: number }): boolean {
  return !buffersEqual(state.DHr, remoteHeader.publicKey);
}

/**
 * Compare two Uint8Arrays
 */
function buffersEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}