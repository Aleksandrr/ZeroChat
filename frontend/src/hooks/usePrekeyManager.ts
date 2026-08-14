/**
 * usePrekeyManager — automatic Signal Protocol prekey maintenance.
 *
 * Handles two related tasks:
 *
 *   U10 — One-time prekey replenishment:
 *     When the server-side pool of one-time prekeys (EC + PQ) drops
 *     below 25% of the initial 100-key batch, generate a new batch
 *     of 50 keys and upload them to the server. The check runs:
 *       - once on mount (after Signal is initialized)
 *       - hourly thereafter (setInterval)
 *       - immediately after every successful sendMessage
 *
 *   U11 — Signed prekey rotation:
 *     Every 30 days, generate a new signed prekey locally and
 *     publish it to the server. The OLD SPK record is kept in
 *     IndexedDB so in-flight PreKey messages encrypted against it
 *     can still be decrypted. The check runs hourly.
 *
 * Both checks are best-effort: if the server rejects the upload
 * (e.g. because the backend's HMAC enforcement is stricter than
 * the frontend's JWT-only auth — see P0-1 in services/auth/api.ts),
 * the hook logs the failure and continues. The local prekeys ARE
 * still generated and persisted, so once the backend HMAC check is
 * relaxed the upload will "just work" without further changes.
 *
 * The hook is intended to be called once from SignalProvider's body
 * (so it auto-starts when the user is authenticated + Signal is
 * initialized and auto-cleans on unmount).
 */

import { useCallback, useEffect, useRef } from 'react';

import {
  generateKyberPreKeyBatch,
  generateNewSignedPreKey,
  generatePreKeyBatch,
  getSignedPreKeyInfo,
  getIdentityPublicKey,
  getRegistrationId,
  getCurrentDeviceId,
} from '@/lib/signal';
import {
  fetchPreKeyStatus,
  publishOneTimePreKeys,
  publishSignedPreKeyRotation,
} from '@/services/auth';
import { getDeviceId } from '@/services/auth/tokens';
import { arrayBufferToBase64 } from '@/contexts/SignalContext';

// ==================== Constants ====================

const PREKEY_THRESHOLD = 25;       // 25% of initial 100 = 25 keys
const PREKEY_REPLENISH_BATCH = 50;
const SIGNED_PREKEY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const HOURLY_CHECK_MS = 60 * 60 * 1000;

// ==================== Hook ====================

export interface UsePrekeyManagerOptions {
  /** Only run checks when both Signal is initialized AND a user is present. */
  enabled: boolean;
  /** The current authenticated user's id (used for status fetch + publication). */
  userId: string | null;
}

export function usePrekeyManager({ enabled, userId }: UsePrekeyManagerOptions): void {
  // Re-entrancy guard: a single in-flight check at a time. If the
  // hourly timer fires while a previous check is still running, the
  // new invocation bails out immediately.
  const inFlightRef = useRef(false);

  /**
   * U10: check server-side prekey pool and replenish if below 25%.
   * Wrapped in a `useCallback` so `useChatMessages` can call it after
   * every sendMessage without needing the user to wait for the
   * hourly interval.
   */
  const checkAndReplenish = useCallback(async (): Promise<void> => {
    if (!userId) return;
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const status = await fetchPreKeyStatus(userId);

      const ecLow = status.ecPreKeyCount < PREKEY_THRESHOLD;
      const pqLow = status.pqPreKeyCount < PREKEY_THRESHOLD;

      if (!ecLow && !pqLow) {
        // Pool is healthy — nothing to do.
        return;
      }

      // Generate a fresh batch locally (always both EC and PQ, even if
      // only one is low — saves a round-trip on the next low-water
      // event for the other kind).
      const newEc = ecLow ? await generatePreKeyBatch(PREKEY_REPLENISH_BATCH) : [];
      const newPq = pqLow ? await generateKyberPreKeyBatch(PREKEY_REPLENISH_BATCH) : [];

      if (newEc.length === 0 && newPq.length === 0) {
        return;
      }

      // Upload to the server. Best-effort — see the file-level comment
      // about the HMAC/JWT mismatch.
      const sessionDeviceId = getDeviceId();
      if (!sessionDeviceId) {
        console.warn('[PrekeyManager] No session deviceId — skipping upload');
        return;
      }

      try {
        await publishOneTimePreKeys({
          deviceId: sessionDeviceId,
          ecOneTimePreKeys: newEc.map(pk => ({
            id: pk.id,
            pub: arrayBufferToBase64(pk.publicKey),
          })),
          pqOneTimePreKeys: newPq.map(pk => ({
            id: pk.id,
            pub: arrayBufferToBase64(pk.publicKey),
            sig: arrayBufferToBase64(pk.signature),
          })),
        });
        console.log('[PrekeyManager] Replenished one-time prekeys:', {
          ec: newEc.length,
          pq: newPq.length,
        });
      } catch (err) {
        // Expected 401 if the backend HMAC check is still in place —
        // log at debug level so it doesn't spam the console.
        console.warn('[PrekeyManager] Upload failed (likely HMAC/JWT mismatch):', err);
      }
    } catch (err) {
      console.error('[PrekeyManager] Replenishment check failed:', err);
    } finally {
      inFlightRef.current = false;
    }
  }, [userId]);

  /**
   * U11: check the local signed prekey age and rotate if > 30 days.
   */
  const checkAndRotateSignedPreKey = useCallback(async (): Promise<void> => {
    if (!userId) return;
    try {
      const spkInfo = await getSignedPreKeyInfo();
      if (!spkInfo) {
        // No SPK in storage — initial registration handles this. Skip.
        return;
      }

      const age = Date.now() - spkInfo.createdAt;
      if (age <= SIGNED_PREKEY_MAX_AGE_MS) {
        return;
      }

      // Generate a new SPK locally (also persists to IndexedDB +
      // increments nextSignedPreKeyId counter).
      const newSpk = await generateNewSignedPreKey();

      // Publish the new SPK to the server. We use the full
      // `publishSignalKeys` call (via `publishSignedPreKeyRotation`)
      // because there's no dedicated SPK-only endpoint. To avoid
      // wiping the server's existing one-time prekey pool, we
      // generate a fresh batch of one-time prekeys too and upload
      // them alongside the rotated SPK.
      const identityKeyPub = getIdentityPublicKey();
      if (!identityKeyPub) {
        console.warn('[PrekeyManager] No identity key — skipping SPK rotation publish');
        return;
      }

      const registrationId = await getRegistrationId();
      // `getCurrentDeviceId()` returns the Signal protocol deviceId
      // (numeric, 1-127) — that's what the publish route expects. NOT
      // the session deviceId from `getDeviceId()` (which is a string
      // like "dev_<uuid>").
      const signalDeviceId = getCurrentDeviceId();
      const signalDeviceIdArg: number | null = signalDeviceId > 0 ? signalDeviceId : null;

      // Best-effort: generate a small batch of one-time prekeys so the
      // publish call doesn't deplete the server's pool. If this fails,
      // we still log success on the local rotation — the new SPK is
      // in IndexedDB and will be used by the next `generatePreKeyBundle`.
      let ecOneTime: Array<{ id: number; publicKey: string }> = [];
      let pqOneTime: Array<{ id: number; publicKey: string; signature: string }> = [];
      try {
        const ecBatch = await generatePreKeyBatch(PREKEY_REPLENISH_BATCH);
        ecOneTime = ecBatch.map(pk => ({
          id: pk.id,
          publicKey: arrayBufferToBase64(pk.publicKey),
        }));
        const pqBatch = await generateKyberPreKeyBatch(PREKEY_REPLENISH_BATCH);
        pqOneTime = pqBatch.map(pk => ({
          id: pk.id,
          publicKey: arrayBufferToBase64(pk.publicKey),
          signature: arrayBufferToBase64(pk.signature),
        }));
      } catch (err) {
        console.warn('[PrekeyManager] Failed to generate one-time prekeys for SPK rotation:', err);
      }

      // The kyberPreKey field required by publishSignalKeys is the
      // LAST-RESORT pq prekey, NOT a one-time pq prekey. We don't
      // have a separate "last resort" key here — re-use the most
      // recently generated PQ one-time prekey as the last-resort
      // (this matches what initial registration does in
      // SignalContext: it picks kyberPreKeys[0] as the last-resort).
      const lastResortPq = pqOneTime[0]
        ? {
            id: pqOneTime[0].id,
            publicKey: pqOneTime[0].publicKey,
            signature: pqOneTime[0].signature,
          }
        : {
            id: 0,
            publicKey: '',
            signature: '',
          };

      try {
        await publishSignedPreKeyRotation({
          userId,
          deviceId: signalDeviceIdArg,
          registrationId,
          identityKey: arrayBufferToBase64(identityKeyPub),
          signedPreKey: {
            id: newSpk.id,
            publicKey: arrayBufferToBase64(newSpk.publicKey),
            signature: arrayBufferToBase64(newSpk.signature),
          },
          kyberPreKey: lastResortPq,
          ecOneTimePreKeys: ecOneTime,
          pqOneTimePreKeys: pqOneTime.slice(1), // first one is the last-resort
        });
        console.log('[PrekeyManager] Rotated signed prekey:', {
          spkId: newSpk.id,
          ecUploaded: ecOneTime.length,
          pqUploaded: Math.max(0, pqOneTime.length - 1),
        });
      } catch (err) {
        console.warn('[PrekeyManager] SPK rotation publish failed (likely HMAC/JWT mismatch):', err);
      }
    } catch (err) {
      console.error('[PrekeyManager] SPK rotation check failed:', err);
    }
  }, [userId]);

  // Single combined check — runs U10 + U11 in sequence.
  const runCheck = useCallback(async (): Promise<void> => {
    if (!enabled || !userId) return;
    await checkAndReplenish();
    await checkAndRotateSignedPreKey();
  }, [enabled, userId, checkAndReplenish, checkAndRotateSignedPreKey]);

  // Hourly interval + initial mount check.
  useEffect(() => {
    if (!enabled || !userId) return;

    // Initial check after a short delay (don't race with SignalContext
    // initialization — the hook's `enabled` flag already gates on
    // `isInitialized`, but giving it 5s lets any in-flight key
    // publication from registration settle first).
    const initialTimer = setTimeout(() => {
      void runCheck();
    }, 5_000);

    const intervalId = setInterval(() => {
      void runCheck();
    }, HOURLY_CHECK_MS);

    return () => {
      clearTimeout(initialTimer);
      clearInterval(intervalId);
    };
  }, [enabled, userId, runCheck]);

  // Expose `runCheck` via a ref so other hooks (useChatMessages) can
  // trigger a check after sendMessage without needing a new effect.
  // The ref pattern avoids re-renders when the callback identity
  // changes (it changes when `userId` changes, which is fine —
  // callers read through the ref).
  const runCheckRef = useRef(runCheck);
  useEffect(() => {
    runCheckRef.current = runCheck;
  }, [runCheck]);

  // Register a global event so `useChatMessages.sendMessage` can
  // trigger a post-send prekey check without importing this hook
  // (which lives in SignalProvider's tree, not ChatProvider's).
  useEffect(() => {
    if (!enabled || !userId) return;

    const handler = (): void => {
      void runCheckRef.current();
    };
    window.addEventListener('zerochat:prekey-check', handler);
    return () => {
      window.removeEventListener('zerochat:prekey-check', handler);
    };
  }, [enabled, userId]);

  // Helper for callers that want to invoke a check directly (mostly
  // for tests). Not used in the production code path — the event
  // listener above is the canonical trigger.
  //
  // We intentionally do NOT return anything from this hook: the
  // hook's job is to run side effects (timers, event listeners), not
  // to expose state. Callers that need to trigger a check should
  // dispatch `window.dispatchEvent(new Event('zerochat:prekey-check'))`.
  void runCheck;
}
