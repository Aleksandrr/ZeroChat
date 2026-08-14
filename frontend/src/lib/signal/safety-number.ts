/**
 * Safety number formatting helpers.
 *
 * Signal-style: a 60-digit decimal number derived from both parties' identity
 * keys + UUIDs (computed by `signal.generateSafetyNumber`). Displayed either
 * in full (12 groups of 5 digits, space-separated) or in a shortened form
 * (first 12 digits, 3 groups of 4 separated by dashes) for compact UI.
 *
 * Example:
 *   full:     "12345 67890 12345 67890 12345 67890 12345 67890 12345 67890 12345 67890"
 *   short:    "12345-67890-12345"
 *
 * These helpers are pure string operations — they do not touch WASM, network
 * or storage — so they are safe to unit-test in isolation and tree-shake.
 */

/** Format a 60-digit safety number into 12 groups of 5 digits, space-separated. */
export function formatSafetyNumberFull(digits: string): string {
  const clean = digits.replace(/\D/g, '').slice(0, 60).padEnd(60, '0');
  return clean.match(/.{1,5}/g)!.join(' ');
}

/** Short version: first 12 digits in 3 groups of 4, dash-separated. */
export function formatSafetyNumberShort(digits: string): string {
  const clean = digits.replace(/\D/g, '').slice(0, 12).padEnd(12, '0');
  return clean.match(/.{1,4}/g)!.join('-');
}

/**
 * Generate a QR-code-compatible payload for the safety number.
 *
 * Signal apps use a binary QR encoding (the `scannable` field on
 * `WasmSafetyNumber`); we do not have a QR library wired up yet, so for the
 * MVP we expose a URL-style string that another ZeroChat client can scan and
 * decode back to the same digit string.
 */
export function safetyNumberToQrPayload(digits: string): string {
  return `safety-number:${digits.replace(/\D/g, '')}`;
}

/**
 * Constant-time comparison of two safety numbers.
 *
 * Avoids early-return on the first mismatching byte to prevent timing
 * attacks when comparing manually entered numbers. Returns true iff the two
 * digit strings (after stripping non-digits) are equal in length and content.
 */
export function safetyNumbersMatch(a: string, b: string): boolean {
  const cleanA = a.replace(/\D/g, '');
  const cleanB = b.replace(/\D/g, '');
  if (cleanA.length !== cleanB.length) return false;
  let diff = 0;
  for (let i = 0; i < cleanA.length; i++) {
    diff |= cleanA.charCodeAt(i) ^ cleanB.charCodeAt(i);
  }
  return diff === 0;
}

// ==================== Local trust state (TOFU + manual verification) ====================
//
// Stored in localStorage so we do not need a new IndexedDB store (which is
// owned by another agent). Two keys:
//   - "zc:known-identities"  → { [userId]: base64IdentityPub }   (first-seen keys)
//   - "zc:verified-contacts" → string[]                          (manually verified)
//
// TOFU model:
//   1. On first sight of a userId's identity pub, record it.
//   2. If the recorded key matches the current key → status is 'verified'
//      (if the user confirmed) or 'unverified' otherwise.
//   3. If the recorded key differs from the current key → status is 'changed'
//      (TOFU violation — possible MITM / device change).
//   4. We do NOT auto-overwrite the stored key on mismatch: the user must
//      explicitly re-verify via the dialog before we trust the new key.

const KNOWN_IDENTITIES_KEY = 'zc:known-identities';
const VERIFIED_CONTACTS_KEY = 'zc:verified-contacts';

interface KnownIdentities {
  [userId: string]: string; // base64-encoded identity pubkey
}

function readKnownIdentities(): KnownIdentities {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(KNOWN_IDENTITIES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as KnownIdentities) : {};
  } catch {
    return {};
  }
}

function writeKnownIdentities(map: KnownIdentities): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(KNOWN_IDENTITIES_KEY, JSON.stringify(map));
  } catch {
    // localStorage may be unavailable (private mode, quota); best-effort.
  }
}

function readVerifiedContacts(): Set<string> {
  if (typeof localStorage === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(VERIFIED_CONTACTS_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed as string[]) : new Set();
  } catch {
    return new Set();
  }
}

function writeVerifiedContacts(set: Set<string>): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(VERIFIED_CONTACTS_KEY, JSON.stringify([...set]));
  } catch {
    // best-effort
  }
}

/** Trust status for a contact, derived from local TOFU state. */
export type SafetyNumberStatus = 'verified' | 'unverified' | 'changed' | 'unknown';

/**
 * Record that we have seen this identity pubkey for the user and compute the
 * resulting status according to the TOFU model.
 *
 * - If no previous key was stored → record it, return 'unverified'.
 * - If the previous key matches AND user previously verified → 'verified'.
 * - If the previous key matches AND user did not verify → 'unverified'.
 * - If the previous key differs → return 'changed' (do NOT overwrite).
 */
export function recordIdentitySighting(userId: string, identityPubBase64: string): SafetyNumberStatus {
  const known = readKnownIdentities();
  const verified = readVerifiedContacts();
  const previous = known[userId];

  if (previous === undefined) {
    known[userId] = identityPubBase64;
    writeKnownIdentities(known);
    return 'unverified';
  }

  if (previous === identityPubBase64) {
    return verified.has(userId) ? 'verified' : 'unverified';
  }

  return 'changed';
}

/** Compute status without recording a sighting (read-only). */
export function peekIdentityStatus(userId: string, identityPubBase64: string): SafetyNumberStatus {
  const known = readKnownIdentities();
  const verified = readVerifiedContacts();
  const previous = known[userId];

  if (previous === undefined) return 'unverified';
  if (previous === identityPubBase64) return verified.has(userId) ? 'verified' : 'unverified';
  return 'changed';
}

/** Mark a contact as manually verified (user confirmed the safety number out-of-band). */
export function markContactVerified(userId: string): void {
  const set = readVerifiedContacts();
  set.add(userId);
  writeVerifiedContacts(set);
}

/** Remove the verified mark (e.g. after an identity change). */
export function unmarkContactVerified(userId: string): void {
  const set = readVerifiedContacts();
  set.delete(userId);
  writeVerifiedContacts(set);
}

/** Forget the stored identity pubkey for a user (used when re-accepting a changed key). */
export function forgetKnownIdentity(userId: string): void {
  const known = readKnownIdentities();
  delete known[userId];
  writeKnownIdentities(known);
}

/**
 * Accept a changed identity: clears the verified flag, overwrites the stored
 * key with the new one, and returns the new (unverified) status.
 *
 * The user must explicitly call this from the dialog after comparing the new
 * safety number — TOFU violations are never auto-resolved.
 */
export function acceptChangedIdentity(userId: string, newIdentityPubBase64: string): SafetyNumberStatus {
  unmarkContactVerified(userId);
  const known = readKnownIdentities();
  known[userId] = newIdentityPubBase64;
  writeKnownIdentities(known);
  return 'unverified';
}
