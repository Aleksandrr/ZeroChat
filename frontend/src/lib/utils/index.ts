/**
 * Utils Index - Re-exports all utility modules
 * 
 * This module provides a single entry point for all utility functions.
 * Import from '@/lib/utils' or '@/lib/utils/' for specific modules.
 * 
 * @example
 * ```typescript
 * // Import specific functions
 * import { formatMessageTime, arrayBufferToBase64 } from '@/lib/utils';
 * 
 * // Or import from specific modules
 * import { formatMessageTime } from '@/lib/utils/date';
 * import { arrayBufferToBase64 } from '@/lib/utils/buffer';
 * ```
 */

// Buffer utilities for Base64 conversion
export {
  arrayBufferToBase64,
  base64ToArrayBuffer,
  base64ToUint8Array,
  concatArrayBuffers,
  uint8ArrayToBase64,
} from './buffer';

// Crypto utilities (CSPRNG-backed helpers)
export { secureRandomInt } from './crypto';

/**
 * Russian pluralization helper.
 *
 * @param n - Count
 * @param forms - Tuple of [one, few, many] forms, e.g. ['участник', 'участника', 'участников']
 * @returns The form matching the count
 *
 * @example
 *   pluralize(1, ['участник', 'участника', 'участников'])  // 'участник'
 *   pluralize(2, ['участник', 'участника', 'участников'])  // 'участника'
 *   pluralize(5, ['участник', 'участника', 'участников'])  // 'участников'
 *   pluralize(11, ['участник', 'участника', 'участников']) // 'участников'
 */
export function pluralize(
  n: number,
  forms: [string, string, string],
): string {
  const abs = Math.abs(n);
  const n10 = abs % 10;
  const n100 = abs % 100;
  if (n10 === 1 && n100 !== 11) return forms[0];
  if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return forms[1];
  return forms[2];
}

// Date utilities for formatting
export {
  formatMessageDate,
  formatMessageTime,
  formatRelativeTime,
  isSameDay,
  isToday,
  isYesterday,
} from './date';