/**
 * Broadcast Channel module for cross-tab UI synchronization
 *
 * This module provides functionality for synchronizing UI state between
 * browser tabs using the BroadcastChannel API with localStorage fallback.
 *
 * @example
 * ```tsx
 * // Broadcasting logout to other tabs
 * import { useBroadcastAction } from '@/lib/broadcast';
 *
 * function UserMenu() {
 *   const { broadcastLogout } = useBroadcastAction();
 *
 *   const handleLogout = async () => {
 *     await logout();
 *     broadcastLogout();
 *   };
 * }
 * ```
 *
 * @example
 * ```tsx
 * // Listening for events from other tabs
 * import { useCrossTabEvent } from '@/lib/broadcast';
 *
 * function AppContent() {
 *   const { logout } = useAuth();
 *
 *   useCrossTabEvent('auth:logout', () => {
 *     logout({ fromOtherTab: true });
 *   });
 * }
 * ```
 */

// Class and singleton
export { getCrossTabSync, resetCrossTabSync,UICrossTabSync } from './sync';

// Hooks
export {
  useBroadcastAction,
  useCrossTabAll,
  useCrossTabEvent,
  useCrossTabSync,
  useTypingSync,
} from './sync';

// Types
export type {
  ChatOpenedPayload,
  CrossTabEvent,
  CrossTabEventHandler,
  CrossTabEventType,
  MessageReadPayload,
  NotificationPayload,
  SettingsChangedPayload,
  ThemeChangedPayload,
  TypingPayload,
} from './types';
