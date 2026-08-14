/**
 * Connection Store - Zustand store for WebSocket connection state
 * 
 * Can be shared across tabs when using Shared Worker mode.
 * Provides a centralized state management for connection status.
 */

import { create } from 'zustand';

// ==================== Types ====================

export interface ConnectionState {
  isConnected: boolean;
  isConnecting: boolean;
  lastConnected: Date | null;
  lastError: string | null;
  reconnectAttempts: number;
  tabId: string | null;
  deviceId: string | null;
}

export interface ConnectionActions {
  setConnected: (connected: boolean) => void;
  setConnecting: (connecting: boolean) => void;
  setError: (error: string | null) => void;
  setTabId: (tabId: string) => void;
  setDeviceId: (deviceId: string) => void;
  incrementReconnectAttempts: () => void;
  resetReconnectAttempts: () => void;
  reset: () => void;
}

export type ConnectionStore = ConnectionState & ConnectionActions;

// ==================== Initial State ====================

const initialState: ConnectionState = {
  isConnected: false,
  isConnecting: false,
  lastConnected: null,
  lastError: null,
  reconnectAttempts: 0,
  tabId: null,
  deviceId: null,
};

// ==================== Store ====================

export const useConnectionStore = create<ConnectionStore>((set) => ({
  ...initialState,

  setConnected: (isConnected) =>
    set({
      isConnected,
      lastConnected: isConnected ? new Date() : null,
      isConnecting: false,
    }),

  setConnecting: (isConnecting) =>
    set({ isConnecting }),

  setError: (lastError) =>
    set({ lastError, isConnecting: false }),

  setTabId: (tabId) =>
    set({ tabId }),

  setDeviceId: (deviceId) =>
    set({ deviceId }),

  incrementReconnectAttempts: () =>
    set((state) => ({ reconnectAttempts: state.reconnectAttempts + 1 })),

  resetReconnectAttempts: () =>
    set({ reconnectAttempts: 0 }),

  reset: () =>
    set(initialState),
}));

// ==================== Selectors ====================

export const selectIsConnected = (state: ConnectionStore) => state.isConnected;
export const selectIsConnecting = (state: ConnectionStore) => state.isConnecting;
export const selectLastError = (state: ConnectionStore) => state.lastError;
export const selectTabId = (state: ConnectionStore) => state.tabId;
export const selectDeviceId = (state: ConnectionStore) => state.deviceId;
export const selectReconnectAttempts = (state: ConnectionStore) => state.reconnectAttempts;
