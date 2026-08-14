/**
 * PreKey Bundle Converter
 *
 * Converts API response format to Signal Protocol PreKeyBundle type.
 * Consolidates duplicate conversion logic from useChatMessages, useChatWebSocket, and useFavorites.
 */

import type { PreKeyBundle } from '@/lib/signal/types';

interface ApiPreKeyBundle {
  identityKeyPub: string;
  signedPreKey: { id: number; pub: string; sig: string };
  oneTimeEcPreKey?: { id: number; pub: string };
  oneTimePqPreKey?: { id: number; pub: string; sig: string };
  pqLastResortPreKey?: { id: number; pub: string; sig: string };
}

/**
 * Convert API PreKey bundle response to Signal Protocol PreKeyBundle format.
 * Handles base64→Uint8Array conversion for all key fields.
 */
export function apiBundleToPreKeyBundle(bundle: ApiPreKeyBundle): PreKeyBundle {
  return {
    // registrationId/deviceId are not in the API response; default to 0 and
    // let the caller fill them in if needed (the WASM processPreKeyBundle
    // path uses the recipient's registration_id but does not actually
    // validate it against the bundle's own field).
    registrationId: 0,
    deviceId: 0,
    identityKey: new Uint8Array(base64ToUint8Array(bundle.identityKeyPub)),
    signedPreKeyId: bundle.signedPreKey.id,
    signedPreKey: new Uint8Array(base64ToUint8Array(bundle.signedPreKey.pub)),
    signedPreKeySignature: new Uint8Array(base64ToUint8Array(bundle.signedPreKey.sig)),
    preKeyId: bundle.oneTimeEcPreKey?.id || 0,
    preKey: bundle.oneTimeEcPreKey
      ? new Uint8Array(base64ToUint8Array(bundle.oneTimeEcPreKey.pub))
      : undefined,
    kyberPreKeyId: bundle.oneTimePqPreKey?.id || bundle.pqLastResortPreKey?.id || 0,
    kyberPreKey: bundle.oneTimePqPreKey
      ? new Uint8Array(base64ToUint8Array(bundle.oneTimePqPreKey.pub))
      : bundle.pqLastResortPreKey
        ? new Uint8Array(base64ToUint8Array(bundle.pqLastResortPreKey.pub))
        : undefined,
    kyberPreKeySignature: bundle.oneTimePqPreKey
      ? new Uint8Array(base64ToUint8Array(bundle.oneTimePqPreKey.sig))
      : bundle.pqLastResortPreKey
        ? new Uint8Array(base64ToUint8Array(bundle.pqLastResortPreKey.sig))
        : undefined,
  };
}

/**
 * Convert base64 string to Uint8Array.
 */
export function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}
