import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

/**
 * Combines class names using clsx and tailwind-merge.
 * Useful for conditional and dynamic class name composition.
 * 
 * @param inputs - Class values to combine
 * @returns Merged class string
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Re-export utilities from utils subdirectory
// This allows importing from '@/lib/utils' for both cn and other utilities
export {
  // Buffer utilities
  arrayBufferToBase64,
  base64ToArrayBuffer,
  base64ToUint8Array,
  concatArrayBuffers,
  formatMessageDate,
  // Date utilities
  formatMessageTime,
  formatRelativeTime,
  isSameDay,
  isToday,
  isYesterday,
  uint8ArrayToBase64,
} from './utils/index';

// Crypto helpers (CSPRNG-backed)
export { secureRandomInt } from './utils/crypto';

// Re-export pluralize so callers using '@/lib/utils' can access it
export { pluralize } from './utils/index';