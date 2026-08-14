/**
 * useSync Hook
 * 
 * Custom hook for managing P2P synchronization between devices.
 * Integrates with WebSocketContext and P2PSyncManager.
 * 
 * Features:
 * - Request sync from other devices
 * - Handle incoming sync requests
 * - Apply received history
 * - Track sync status
 * 
 * @see docs/signal/sesame.md - Sesame protocol specification
 */

import { useCallback, useEffect, useRef,useState } from 'react';

import { useWebSocketContext } from '@/contexts/WebSocketContext';
import type { SyncStatus } from '@/lib/sync';
import type {
  VectorClock,
  WSDeviceOnlinePayload,
  WSSyncHistoryPayload,
  WSSyncRequestPayload,
} from '@/types/websocket';

// ==================== Types ====================

export interface UseSyncOptions {
  autoRequestOnDeviceOnline?: boolean;
  autoRequestOnConnect?: boolean;
}

export interface UseSyncReturn {
  // Status
  isSyncing: boolean;
  lastSyncAt: number | null;
  error: string | null;
  vectorClock: VectorClock;
  
  // Actions
  requestSync: () => Promise<void>;
  clearError: () => void;
  
  // Event handlers (for manual handling)
  onSyncRequest: (callback: (data: WSSyncRequestPayload) => void) => () => void;
  onSyncHistory: (callback: (data: WSSyncHistoryPayload) => void) => () => void;
  onDeviceOnline: (callback: (data: WSDeviceOnlinePayload) => void) => () => void;
}

// ==================== Hook ====================

export function useSync(options: UseSyncOptions = {}): UseSyncReturn {
  const {
    autoRequestOnDeviceOnline = false,
    autoRequestOnConnect = false,
  } = options;

  const {
    isConnected,
    p2pSyncManager,
    syncStatus,
    requestSync: wsRequestSync,
    onSyncRequest: wsOnSyncRequest,
    onSyncHistory: wsOnSyncHistory,
    onDeviceOnline: wsOnDeviceOnline,
  } = useWebSocketContext();

  const [error, setError] = useState<string | null>(null);
  const unsubsRef = useRef<(() => void)[]>([]);

  // Clear error
  const clearError = useCallback(() => {
    setError(null);
  }, []);

  // Request sync
  const requestSync = useCallback(async () => {
    if (!p2pSyncManager) {
      return;
    }

    try {
      setError(null);
      await wsRequestSync();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to request sync';
      setError(message);
      console.error('[useSync] Failed to request sync:', err);
    }
  }, [p2pSyncManager, wsRequestSync]);

  // Auto-request sync on connect
  useEffect(() => {
    if (autoRequestOnConnect && isConnected && p2pSyncManager) {
      // Only request if we have no vector clock (new device)
      const vc = p2pSyncManager.getVectorClock();
      const hasHistory = Object.keys(vc).length > 0;
      
      if (!hasHistory) {
        requestSync();
      }
    }
  }, [autoRequestOnConnect, isConnected, p2pSyncManager, requestSync]);

  // Auto-request sync when another device comes online
  useEffect(() => {
    if (!autoRequestOnDeviceOnline || !p2pSyncManager) return;

    const unsub = wsOnDeviceOnline((data: WSDeviceOnlinePayload) => {
      // Request history from the newly online device
      // Only if this device has no history
      const vc = p2pSyncManager.getVectorClock();
      const hasHistory = Object.keys(vc).length > 0;
      
      if (!hasHistory) {
        requestSync();
      }
    });

    unsubsRef.current.push(unsub);
    return () => { unsub(); };
  }, [autoRequestOnDeviceOnline, p2pSyncManager, wsOnDeviceOnline, requestSync]);

  // Handle incoming sync requests (active device)
  useEffect(() => {
    if (!p2pSyncManager) return;

    const unsub = wsOnSyncRequest(async (data: WSSyncRequestPayload) => {
      try {
        // Prepare and send history
        const historyPayload = await p2pSyncManager.prepareHistory(data.requestingDeviceId);
        
        // Send via WebSocket - we need to send it explicitly
        await p2pSyncManager.sendHistory(historyPayload);
      } catch (err) {
        console.error('[useSync] Failed to prepare history:', err);
      }
    });

    unsubsRef.current.push(unsub);
    return () => { unsub(); };
  }, [p2pSyncManager, wsOnSyncRequest]);

  // Handle incoming sync history (new device)
  useEffect(() => {
    if (!p2pSyncManager) return;

    const unsub = wsOnSyncHistory(async (data: WSSyncHistoryPayload) => {
      try {
        await p2pSyncManager.applyHistory(data);
      } catch (err) {
        console.error('[useSync] Failed to apply history:', err);
        setError(err instanceof Error ? err.message : 'Failed to apply history');
      }
    });

    unsubsRef.current.push(unsub);
    return () => { unsub(); };
  }, [p2pSyncManager, wsOnSyncHistory]);

  // Cleanup
  useEffect(() => {
    return () => {
      unsubsRef.current.forEach(unsub => unsub());
      unsubsRef.current = [];
    };
  }, []);

  // Get vector clock from manager
  const vectorClock = p2pSyncManager?.getVectorClock() ?? {};

  return {
    // Status
    isSyncing: syncStatus.isSyncing,
    lastSyncAt: syncStatus.lastSyncAt,
    error: error ?? syncStatus.error,
    vectorClock,
    
    // Actions
    requestSync,
    clearError,
    
    // Event handlers
    onSyncRequest: wsOnSyncRequest,
    onSyncHistory: wsOnSyncHistory,
    onDeviceOnline: wsOnDeviceOnline,
  };
}

export default useSync;
