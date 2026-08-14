/**
 * Feature Flag and Hook for Shared Worker WebSocket
 * 
 * Provides a gradual rollout mechanism for Shared Worker WebSocket.
 * Falls back to direct WebSocket if SharedWorker is not available.
 */

import { useCallback,useEffect, useRef, useState } from 'react';

import type { EventCallback } from './event-emitter';
import type { WorkerWebSocketClient } from './worker-client';
import { type ConnectionState,createWorkerClient } from './worker-client';

// ==================== Feature Flag ====================

/**
 * Global flag to enable Shared Worker mode
 * Set to true when ready for production use
 */
export const USE_SHARED_WORKER = true; // Enabled: Shared Worker WebSocket is now active

/**
 * Check if Shared Worker should be used
 * Returns false if SharedWorker API is not available
 */
export function shouldUseSharedWorker(): boolean {
  // Check if SharedWorker is available in the browser
  if (typeof SharedWorker === 'undefined') {
    return false;
  }
  
  return USE_SHARED_WORKER;
}

// ==================== Types ====================

export interface UseSharedWorkerResult {
  client: WorkerWebSocketClient | null;
  isConnected: boolean;
  isConnecting: boolean;
  state: ConnectionState;
  connect: (url: string, token: string) => void;
  disconnect: () => void;
  subscribe: (eventTypes: string[]) => () => void;
}

// ==================== Singleton Client ====================

let clientInstance: WorkerWebSocketClient | null = null;

function getOrCreateClient(): WorkerWebSocketClient {
  if (!clientInstance) {
    clientInstance = createWorkerClient();
  }
  return clientInstance;
}

// ==================== Hook ====================

/**
 * Hook for using Shared Worker WebSocket
 * 
 * Provides a singleton client instance shared across all hook usages.
 * Automatically manages connection state subscriptions.
 */
export function useSharedWorker(): UseSharedWorkerResult {
  const [state, setState] = useState<ConnectionState>({
    isConnected: false,
    isConnecting: false,
    lastError: null,
    reconnectAttempts: 0,
    deviceId: null,
  });
  
  const clientRef = useRef<WorkerWebSocketClient | null>(null);

  // Initialize client on mount
  useEffect(() => {
    if (!shouldUseSharedWorker()) {
      return;
    }

    const client = getOrCreateClient();
    clientRef.current = client;

    // Subscribe to state changes
    const unsubscribe = client.subscribeToState(setState);

    return () => {
      // Don't destroy client on unmount - it's a singleton
      // Other components might still be using it
      unsubscribe();
    };
  }, []);

  const connect = useCallback((url: string, token: string) => {
    if (clientRef.current) {
      clientRef.current.connect(url, token);
    }
  }, []);

  const disconnect = useCallback(() => {
    if (clientRef.current) {
      clientRef.current.disconnect();
    }
  }, []);

  const subscribe = useCallback((eventTypes: string[]) => {
    if (clientRef.current) {
      return clientRef.current.subscribe(eventTypes);
    }
    return () => {};
  }, []);

  return {
    client: clientRef.current,
    isConnected: state.isConnected,
    isConnecting: state.isConnecting,
    state,
    connect,
    disconnect,
    subscribe,
  };
}

// ==================== Event Subscription Hook ====================

/**
 * Hook for subscribing to specific WebSocket events
 * 
 * @param eventType - Event type to subscribe to
 * @param callback - Callback function
 */
export function useWorkerEvent<T = unknown>(
  eventType: string,
  callback: (data: T) => void
): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (!shouldUseSharedWorker() || !clientInstance) {
      return;
    }

    const handler = (data: unknown) => {
      callbackRef.current(data as T);
    };

    const unsubscribe = clientInstance.on(eventType, handler as EventCallback);
    return unsubscribe;
  }, [eventType]);
}

// ==================== Cleanup ====================

/**
 * Destroy the singleton client instance
 * Call this when the entire app is unmounting (e.g., during tests)
 */
export function destroySharedWorkerClient(): void {
  if (clientInstance) {
    clientInstance.destroy();
    clientInstance = null;
  }
}
