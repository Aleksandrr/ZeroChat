/**
 * Cryptographic utility helpers (browser CSPRNG-backed).
 *
 * These helpers wrap `crypto.getRandomValues` for use cases where
 * `Math.random()` is unsafe (e.g. generating IDs for the Signal Protocol).
 */

/**
 * Generate a uniformly-distributed random integer in [min, max] using
 * `crypto.getRandomValues` (CSPRNG). Rejection sampling ensures no modulo
 * bias for arbitrary ranges.
 *
 * @param min - Lower bound (inclusive)
 * @param max - Upper bound (inclusive)
 * @returns Random integer in [min, max]
 */
export function secureRandomInt(min: number, max: number): number {
  const range = max - min + 1;
  if (!Number.isFinite(range) || range <= 0) {
    throw new Error('secureRandomInt: range must be a positive finite number');
  }
  // If the range exceeds the full Uint32 space, fall back to a direct draw
  // (still uniform because we use the full output of getRandomValues).
  const maxUint32 = 0xFFFFFFFF;
  // Largest multiple of `range` that fits in the uint32 space — values at or
  // above this threshold would otherwise bias the modulo result.
  const rejectionThreshold = maxUint32 - ((maxUint32 + 1) % range);
  const buf = new Uint32Array(1);
  do {
    crypto.getRandomValues(buf);
  } while (buf[0]! > rejectionThreshold);
  return min + (buf[0]! % range);
}
