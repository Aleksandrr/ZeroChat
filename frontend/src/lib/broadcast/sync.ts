import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  CrossTabEvent,
  CrossTabEventHandler,
  CrossTabEventType,
  SettingsChangedPayload,
  ThemeChangedPayload,
  TypingPayload,
} from './types';

const CHANNEL_NAME = 'zerochat-cross-tab';

/**
 * Generate unique tab ID
 */
function generateTabId(): string {
  return `tab-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
}

/**
 * Class for synchronizing UI events between browser tabs
 */
export class UICrossTabSync {
  private channel: BroadcastChannel | null = null;
  private tabId: string;
  private handlers = new Map<CrossTabEventType, Set<CrossTabEventHandler>>();
  private isDestroyed = false;
  private useFallback = false;

  constructor(channelName: string = CHANNEL_NAME) {
    this.tabId = generateTabId();

    // Check BroadcastChannel support
    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(channelName);
      this.channel.onmessage = this.handleMessage.bind(this);
    } else {
      // Fallback: use localStorage events (for older browsers)
      this.useFallback = true;
      this.setupLocalStorageFallback(channelName);
    }
  }

  /**
   * Get unique tab ID
   */
  getTabId(): string {
    return this.tabId;
  }

  /**
   * Broadcast event to other tabs
   */
  broadcast<T extends CrossTabEventType>(
    type: T,
    payload?: Omit<Partial<CrossTabEvent>, 'type' | 'timestamp' | 'sourceTabId'>
  ): void {
    if (this.isDestroyed) return;

    const event: CrossTabEvent = {
      type,
      timestamp: Date.now(),
      sourceTabId: this.tabId,
      ...payload,
    } as CrossTabEvent;

    if (this.channel) {
      this.channel.postMessage(event);
    } else if (this.useFallback) {
      // Fallback via localStorage
      const key = `zerochat-broadcast-${Date.now()}`;
      localStorage.setItem(key, JSON.stringify(event));
      // Remove immediately to keep storage clean
      setTimeout(() => localStorage.removeItem(key), 100);
    }
  }

  /**
   * Subscribe to events of a specific type
   */
  subscribe(eventType: CrossTabEventType, handler: CrossTabEventHandler): () => void {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set());
    }

    this.handlers.get(eventType)!.add(handler);

    // Return unsubscribe function
    return () => {
      this.handlers.get(eventType)?.delete(handler);
    };
  }

  /**
   * Subscribe to all events
   */
  subscribeAll(handler: CrossTabEventHandler): () => void {
    const eventTypes: CrossTabEventType[] = [
      'auth:logout',
      'auth:session-expired',
      'auth:login',
      'auth:token-refreshed',
      'auth:refresh-failed',
      'chat:opened',
      'chat:closed',
      'typing:start',
      'typing:stop',
      'notification:show',
      'notification:hide',
      'settings:changed',
      'theme:changed',
    ];

    const unsubscribers = eventTypes.map((type) => this.subscribe(type, handler));

    return () => unsubscribers.forEach((unsub) => unsub());
  }

  /**
   * Handle incoming message
   */
  private handleMessage(event: MessageEvent): void {
    const crossTabEvent = event.data as CrossTabEvent;

    // Ignore own events
    if (crossTabEvent.sourceTabId === this.tabId) {
      return;
    }

    // Call handlers
    const handlers = this.handlers.get(crossTabEvent.type);
    if (handlers) {
      handlers.forEach((handler) => {
        try {
          handler(crossTabEvent);
        } catch (error) {
          console.error('[UICrossTabSync] Handler error:', error);
        }
      });
    }
  }

  /**
   * Fallback via localStorage for browsers without BroadcastChannel
   */
  private setupLocalStorageFallback(channelName: string): void {
    window.addEventListener('storage', (event) => {
      if (!event.key?.startsWith('zerochat-broadcast-')) return;

      try {
        const crossTabEvent = JSON.parse(event.newValue || '{}') as CrossTabEvent;
        this.handleMessage({ data: crossTabEvent } as MessageEvent);
      } catch (error) {
        console.error('[UICrossTabSync] Parse error:', error);
      }
    });
  }

  /**
   * Destroy the channel
   */
  destroy(): void {
    this.isDestroyed = true;
    this.handlers.clear();

    if (this.channel) {
      this.channel.close();
      this.channel = null;
    }
  }
}

// Singleton instance
let syncInstance: UICrossTabSync | null = null;

/**
 * Get singleton instance
 */
export function getCrossTabSync(): UICrossTabSync {
  if (!syncInstance) {
    syncInstance = new UICrossTabSync();
  }
  return syncInstance;
}

/**
 * Reset singleton (for testing)
 */
export function resetCrossTabSync(): void {
  if (syncInstance) {
    syncInstance.destroy();
    syncInstance = null;
  }
}

// ============================================================================
// React Hooks
// ============================================================================

/**
 * Hook to get cross-tab sync instance
 */
export function useCrossTabSync(): UICrossTabSync {
  const ref = useRef<UICrossTabSync | null>(null);

  if (!ref.current) {
    ref.current = new UICrossTabSync();
  }

  useEffect(() => {
    return () => {
      ref.current?.destroy();
      ref.current = null;
    };
  }, []);

  return ref.current;
}

/**
 * Hook to subscribe to specific cross-tab events
 */
export function useCrossTabEvent(
  type: CrossTabEventType,
  callback: (event: CrossTabEvent) => void
): void {
  const sync = useCrossTabSync();
  const callbackRef = useRef(callback);

  // Keep callback ref updated
  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    const handler: CrossTabEventHandler = (event) => callbackRef.current(event);
    return sync.subscribe(type, handler);
  }, [sync, type]);
}

/**
 * Hook to subscribe to all cross-tab events
 */
export function useCrossTabAll(callback: (event: CrossTabEvent) => void): void {
  const sync = useCrossTabSync();
  const callbackRef = useRef(callback);

  // Keep callback ref updated
  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    const handler: CrossTabEventHandler = (event) => callbackRef.current(event);
    return sync.subscribeAll(handler);
  }, [sync]);
}

/**
 * Hook for broadcasting events to other tabs
 */
export function useBroadcastAction() {
  const sync = useCrossTabSync();

  const broadcast = useCallback(
    <T extends CrossTabEventType>(
      type: T,
      payload?: Omit<Partial<CrossTabEvent>, 'type' | 'timestamp' | 'sourceTabId'>
    ) => {
      sync.broadcast(type, payload);
    },
    [sync]
  );

  // Convenience methods
  const broadcastLogout = useCallback(() => {
    broadcast('auth:logout');
  }, [broadcast]);

  const broadcastLogin = useCallback(
    (userId: string) => {
      broadcast('auth:login', { userId });
    },
    [broadcast]
  );

  const broadcastChatOpened = useCallback(
    (chatId: string) => {
      broadcast('chat:opened', { chatId });
    },
    [broadcast]
  );

  const broadcastChatClosed = useCallback(
    (chatId: string) => {
      broadcast('chat:closed', { chatId });
    },
    [broadcast]
  );

  const broadcastTypingStart = useCallback(
    (chatId: string, userId: string) => {
      broadcast('typing:start', { chatId, userId });
    },
    [broadcast]
  );

  const broadcastTypingStop = useCallback(
    (chatId: string, userId: string) => {
      broadcast('typing:stop', { chatId, userId });
    },
    [broadcast]
  );

  const broadcastThemeChanged = useCallback(
    (theme: ThemeChangedPayload['theme']) => {
      broadcast('theme:changed', { theme });
    },
    [broadcast]
  );

  const broadcastSettingsChanged = useCallback(
    (key: string, value: unknown) => {
      broadcast('settings:changed', { key, value });
    },
    [broadcast]
  );

  const broadcastSessionExpired = useCallback(() => {
    broadcast('auth:session-expired');
  }, [broadcast]);

  return {
    broadcast,
    broadcastLogout,
    broadcastLogin,
    broadcastChatOpened,
    broadcastChatClosed,
    broadcastTypingStart,
    broadcastTypingStop,
    broadcastThemeChanged,
    broadcastSettingsChanged,
    broadcastSessionExpired,
  };
}

/**
 * Hook for typing indicator sync
 */
export function useTypingSync(chatId: string, userId: string) {
  const { broadcastTypingStart, broadcastTypingStop } = useBroadcastAction();
  const [typingUsers, setTypingUsers] = useState<Set<string>>(new Set());
  const sync = useCrossTabSync();

  // Listen for typing from other tabs
  useEffect(() => {
    const unsubStart = sync.subscribe('typing:start', (event) => {
      const typingEvent = event as CrossTabEvent & TypingPayload;
      if (typingEvent.chatId === chatId) {
        setTypingUsers((prev) => new Set(prev).add(typingEvent.userId));
      }
    });

    const unsubStop = sync.subscribe('typing:stop', (event) => {
      const typingEvent = event as CrossTabEvent & TypingPayload;
      if (typingEvent.chatId === chatId) {
        setTypingUsers((prev) => {
          const next = new Set(prev);
          next.delete(typingEvent.userId);
          return next;
        });
      }
    });

    return () => {
      unsubStart();
      unsubStop();
    };
  }, [sync, chatId]);

  const startTyping = useCallback(() => {
    broadcastTypingStart(chatId, userId);
  }, [broadcastTypingStart, chatId, userId]);

  const stopTyping = useCallback(() => {
    broadcastTypingStop(chatId, userId);
  }, [broadcastTypingStop, chatId, userId]);

  return {
    typingUsers,
    startTyping,
    stopTyping,
  };
}
