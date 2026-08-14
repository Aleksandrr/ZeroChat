/**
 * AuthContext - Authentication state management
 * Handles user login, registration, logout, and session management
 *
 * Note: Signal Protocol initialization is handled by SignalContext
 * via useEffect when user becomes authenticated.
 *
 * Cross-tab sync: Logout events are broadcast to other tabs via BroadcastChannel
 * Token Refresh: TokenRefreshManager handles proactive refresh and 401 recovery
 */

import type React from 'react';
import { createContext, useCallback, useContext, useEffect, useRef,useState } from 'react';

import { useBroadcastAction,useCrossTabEvent } from '@/lib/broadcast';
import * as signal from '@/lib/signal';
import {
  AuthError,
  getCurrentUser,
  hasAccessToken,
  login as authLogin,
  logout as authLogout,
  refreshTokens as authRefreshTokens,
  register as authRegister,
} from '@/services/auth';
import {
  startProactiveRefresh,
  stopProactiveRefresh,
  TokenRefreshManager,
} from '@/services/auth/token-refresh';
import type { LoginCredentials, RegisterData,User } from '@/types';

// ==================== Types ====================

export interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  deviceNeedsVerification: boolean;
  login: (credentials: LoginCredentials) => Promise<boolean>;
  register: (data: RegisterData) => Promise<void>;
  logout: () => Promise<void>;
  handleLogout: () => Promise<void>;
  handleFullLogout: () => Promise<void>;
  refreshSession: () => Promise<void>;
  setDeviceVerified: () => void;
  updateUser: (updates: Partial<User>) => void;
}

// ==================== Context ====================

const AuthContext = createContext<AuthContextType | null>(null);

// ==================== Provider ====================

export function AuthProvider({ 
  children,
  onLogout,
}: { 
  children: React.ReactNode;
  onLogout?: () => void;
}) {
  const [user, setUser] = useState<User | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState(() => hasAccessToken());
  const [isLoading, setIsLoading] = useState(false);
  const [deviceNeedsVerification, setDeviceNeedsVerification] = useState(false);

  // RACE CONDITION FIX: Track mounted state to prevent setState on unmounted component
  const mountedRef = useRef(true);

  // Cross-tab sync hooks
  const { broadcastLogout, broadcastSessionExpired } = useBroadcastAction();

  // ==================== TokenRefreshManager Setup ====================

  // Initialize TokenRefreshManager with handlers
  useEffect(() => {
    const manager = TokenRefreshManager.getInstance();

    manager.setHandlers({
      onTokenRefreshed: (_newToken) => {
        // Token is already saved by TokenRefreshManager
        // WebSocket reconnection is handled by WebSocketContext via broadcast
      },
      onRefreshFailed: (error) => {
        console.error('[AuthContext] Proactive refresh failed:', error);
        // If refresh failed, user needs to re-login
        if (mountedRef.current) {
          setUser(null);
          setIsAuthenticated(false);
          broadcastSessionExpired();
          onLogout?.();
        }
      },
      onRedirectToLogin: () => {
        if (mountedRef.current) {
          setUser(null);
          setIsAuthenticated(false);
          broadcastSessionExpired();
          onLogout?.();
        }
      },
    });

    return () => {
      // Cleanup handlers on unmount
      manager.setHandlers({});
    };
  }, [onLogout, broadcastSessionExpired]);

  // Start proactive refresh when authenticated
  useEffect(() => {
    if (isAuthenticated) {
      startProactiveRefresh({
        refreshBufferSeconds: 60,  // Refresh 1 minute before expiry
        checkIntervalMs: 30000,    // Check every 30 seconds
      });
    } else {
      stopProactiveRefresh();
    }

    return () => {
      stopProactiveRefresh();
    };
  }, [isAuthenticated]);

  // Retry helper for network errors
  const retryWithBackoff = async <T,>(
    operation: () => Promise<T>,
    maxRetries = 3,
    baseDelay = 1000
  ): Promise<T> => {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error: unknown) {
        // Convert to Error if needed
        const err = error instanceof Error ? error : new Error(String(error));
        lastError = err;

        // Don't retry on auth errors (401, 403)
        if (err instanceof AuthError && (err.statusCode === 401 || err.statusCode === 403)) {
          throw err;
        }

        // Don't retry if component is unmounted
        if (!mountedRef.current) {
          throw err;
        }

        // Only retry on network errors (no status code or 5xx)
        const statusCode = 'statusCode' in err ? (err as { statusCode?: number }).statusCode : undefined;
        const isNetworkError = !statusCode || statusCode >= 500;
        if (!isNetworkError || attempt === maxRetries - 1) {
          throw err;
        }

        // Exponential backoff
        const delay = baseDelay * Math.pow(2, attempt);
        console.warn(`[AuthContext] Retry ${attempt + 1}/${maxRetries} after ${delay}ms due to:`, err.message);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  };

  // Load user profile when authenticated (page reload scenario)
  useEffect(() => {
    mountedRef.current = true;
    
    const loadUser = async () => {
      if (isAuthenticated && !user) {
        setIsLoading(true);
        try {
          const userData = await retryWithBackoff(() => getCurrentUser(), 3);
          if (!mountedRef.current) return;
          setUser(userData);

          // Check if device needs verification
          const { getDevices } = await import('@/services/devices/api');
          const devicesResponse = await retryWithBackoff(() => getDevices(), 3);
          const deviceId = localStorage.getItem('device-id');
          const currentDevice = devicesResponse.devices.find(d => d.device_uuid === deviceId);
          
          if (currentDevice && !currentDevice.verified_at) {
            setDeviceNeedsVerification(true);
          }
        } catch (error) {
          console.error('[AuthContext] Failed to load user after retries:', error);
          // Check if component is still mounted before updating state
          if (!mountedRef.current) return;
          // Bugfix: Handle network errors properly (Bug #4)
          // Only logout on 401 Unauthorized, not on network errors
          if (error instanceof AuthError && error.statusCode === 401) {
            setIsAuthenticated(false);
          } else if (!hasAccessToken()) {
            // No token - definitely not authenticated
            setIsAuthenticated(false);
          }
          // Network error with valid token: keep isAuthenticated, user can retry manually
        } finally {
          if (mountedRef.current) {
            setIsLoading(false);
          }
        }
      }
    };
    
     void loadUser();
    
    return () => {
      mountedRef.current = false;
    };
  }, [isAuthenticated, user]);

  // Cross-tab logout sync: Listen for logout from other tabs
  useCrossTabEvent('auth:logout', () => {
    if (mountedRef.current) {
      setUser(null);
      setIsAuthenticated(false);
      onLogout?.();
    }
  });

  // Cross-tab session-expired sync
  useCrossTabEvent('auth:session-expired', () => {
    if (mountedRef.current) {
      setUser(null);
      setIsAuthenticated(false);
      onLogout?.();
    }
  });

  // Cross-tab token-refreshed sync - token updated in another tab
  useCrossTabEvent('auth:token-refreshed', (_event) => {
    // Token is already saved by TokenRefreshManager in the other tab
    // No action needed - tokens are shared via localStorage
  });

  // Cross-tab refresh-failed sync - need to logout
  useCrossTabEvent('auth:refresh-failed', () => {
    if (mountedRef.current) {
      setUser(null);
      setIsAuthenticated(false);
      onLogout?.();
    }
  });

  // Reset isLoading and deviceNeedsVerification when authentication becomes false
  useEffect(() => {
    if (!isAuthenticated) {
      setIsLoading(false);
      setDeviceNeedsVerification(false);
    }
  }, [isAuthenticated]);

  // Login - Signal initialization handled by SignalContext
  const login = useCallback(async (credentials: LoginCredentials): Promise<boolean> => {
    try {
      const response = await authLogin(credentials);
      // Сбрасываем время последнего refresh при логине
      TokenRefreshManager.getInstance().resetLastRefreshTime();
      setUser(response.user);
      setIsAuthenticated(true);
      
      // Проверяем, нужно ли верифицировать устройство
      const needsVerification = response.data?.deviceNeedsVerification ?? false;
      setDeviceNeedsVerification(needsVerification);
      
      return needsVerification;
    } catch (error) {
      console.error('[AuthContext] Login failed:', error);
      throw error;
    }
  }, []);

  // Register - Signal initialization handled by SignalContext
  const register = useCallback(async (data: RegisterData) => {
    try {
      // Full logout if there's an existing user
      if (isAuthenticated && user) {
        await signal.fullLogout();
      }
      
      const response = await authRegister(data);
      // Сбрасываем время последнего refresh при регистрации
      TokenRefreshManager.getInstance().resetLastRefreshTime();
      setUser(response.user);
      setIsAuthenticated(true);
      
      // Устанавливаем векторные часы для новой учётки, чтобы не запускать синхронизацию
      const deviceUuid = localStorage.getItem('device-id');
      if (deviceUuid) {
        localStorage.setItem('p2p_vector_clock', JSON.stringify({
          [deviceUuid]: 1
        }));
      }
    } catch (error) {
      console.error('[AuthContext] Registration failed:', error);
      throw error;
    }
  }, [isAuthenticated, user]);

  // Logout (UI logout - keeps keys for re-login)
  const logout = useCallback(async () => {
    try {
      await authLogout();
    } catch (error) {
      console.warn('[AuthContext] Logout API call failed:', error);
    } finally {
      setUser(null);
      setIsAuthenticated(false);

      // Clear device cache
      const { chatService } = await import('@/services/chat');
      chatService.clearDeviceCache();

      try {
        const { destroySignalClient, uiLogout } = await import('@/lib/signal');
        destroySignalClient(null);
        await uiLogout();
      } catch (signalError) {
        console.warn('[AuthContext] Signal cleanup failed:', signalError);
      }

      // Broadcast logout to other tabs
      broadcastLogout();

      onLogout?.();
    }
  }, [onLogout, broadcastLogout]);

  // Handle Logout (alias for UI logout - preserves cryptographic state)
  const handleLogout = useCallback(async () => {
    const { destroySignalClient, uiLogout } = await import('@/lib/signal');
    destroySignalClient(null);
    await uiLogout();

    try {
      await authLogout();
    } catch (error) {
      console.warn('[AuthContext] Logout API call failed:', error);
    }

    setUser(null);
    setIsAuthenticated(false);

    // Clear device cache
    const { chatService } = await import('@/services/chat');
    chatService.clearDeviceCache();

    // Broadcast logout to other tabs
    broadcastLogout();

    onLogout?.();
  }, [onLogout, broadcastLogout]);

  // Handle Full Logout (complete deregistration - clears all cryptographic state)
  const handleFullLogout = useCallback(async () => {
    const { destroySignalClient, fullLogout } = await import('@/lib/signal');
    const { clearAllIncludingDevice } = await import('@/services/auth/tokens');

    destroySignalClient(null);
    await fullLogout();

    try {
      await authLogout();
    } catch (error) {
      console.warn('[AuthContext] Logout API call failed:', error);
    }

    // Clear device ID for full logout - user is deregistering this device
    clearAllIncludingDevice();

    setUser(null);
    setIsAuthenticated(false);

    // Broadcast logout to other tabs
    broadcastLogout();

    onLogout?.();
  }, [onLogout]);

  // Refresh session
  const refreshSession = useCallback(async (): Promise<void> => {
    try {
      await authRefreshTokens();
    } catch (error) {
      console.error('[AuthContext] Failed to refresh session:', error);
      setIsAuthenticated(false);
      throw error;
    }
  }, []);

  // Mark device as verified
  const setDeviceVerified = useCallback(() => {
    setDeviceNeedsVerification(false);
  }, []);

  // Update current user's profile data
  const updateUser = useCallback((updates: Partial<User>) => {
    setUser(current => current ? { ...current, ...updates } : null);
  }, []);

  const value: AuthContextType = {
    user,
    isAuthenticated,
    isLoading,
    deviceNeedsVerification,
    login,
    register,
    logout,
    handleLogout,
    handleFullLogout,
    refreshSession,
    setDeviceVerified,
    updateUser,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

// ==================== Hook ====================

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}
