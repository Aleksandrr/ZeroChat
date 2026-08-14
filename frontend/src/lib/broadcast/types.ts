/**
 * Types for cross-tab communication via Broadcast Channel
 */

/**
 * Event types for cross-tab synchronization
 */
export type CrossTabEventType =
  // Authentication
  | 'auth:logout' // User logged out in another tab
  | 'auth:session-expired' // Session expired
  | 'auth:login' // User logged in
  | 'auth:token-refreshed' // Token refreshed in another tab
  | 'auth:refresh-failed' // Token refresh failed in another tab

  // Chat UI
  | 'chat:opened' // Chat opened (for unread sync)
  | 'chat:closed' // Chat closed

  // Typing
  | 'typing:start' // Started typing
  | 'typing:stop' // Stopped typing

  // Notifications
  | 'notification:show' // Show notification
  | 'notification:hide' // Hide notification

  // Settings
  | 'settings:changed' // Settings changed

  // Theme
  | 'theme:changed'; // Theme changed

/**
 * Base event interface
 */
interface BaseEvent<T extends CrossTabEventType> {
  type: T;
  timestamp: number;
  sourceTabId: string;
}

/**
 * All possible cross-tab events
 */
export type CrossTabEvent =
  | BaseEvent<'auth:logout'>
  | BaseEvent<'auth:session-expired'>
  | BaseEvent<'auth:login'> & {
      userId: string;
    }
  | BaseEvent<'auth:token-refreshed'> & {
      newToken: string;
    }
  | BaseEvent<'auth:refresh-failed'> & {
      error: string;
    }
  | BaseEvent<'chat:opened'> & { chatId: string }
  | BaseEvent<'chat:closed'> & { chatId: string }
  | BaseEvent<'typing:start'> & { chatId: string; userId: string }
  | BaseEvent<'typing:stop'> & { chatId: string; userId: string }
  | BaseEvent<'notification:show'> & {
      notification: {
        type: 'info' | 'success' | 'error' | 'warning';
        title: string;
        message?: string;
      };
    }
  | BaseEvent<'notification:hide'> & { notificationId: string }
  | BaseEvent<'settings:changed'> & { key: string; value: unknown }
  | BaseEvent<'theme:changed'> & { theme: 'light' | 'dark' | 'system' };

/**
 * Callback for event handling
 */
export type CrossTabEventHandler = (event: CrossTabEvent) => void;

/**
 * Payload types for convenience
 */
export interface TypingPayload {
  chatId: string;
  userId: string;
}

export interface ChatOpenedPayload {
  chatId: string;
  userId: string;
}

export interface MessageReadPayload {
  chatId: string;
  messageIds: string[];
}

export interface SettingsChangedPayload {
  key: string;
  value: unknown;
}

export interface ThemeChangedPayload {
  theme: 'light' | 'dark' | 'system';
}

export interface NotificationPayload {
  type: 'info' | 'success' | 'error' | 'warning';
  title: string;
  message?: string;
}
