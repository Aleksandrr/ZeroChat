/**
 * Token Management Module
 * 
 * Handles storage, retrieval, and validation of authentication tokens.
 * Uses localStorage for access token persistence across sessions.
 * 
 * SECURITY: Refresh token is stored in httpOnly cookie (not accessible to JS).
 * This module only manages access tokens.
 * 
 * @module auth/tokens
 */

// ==================== Storage Keys ====================

const STORAGE_KEYS = {
  ACCESS_TOKEN: 'access-token',
  DEVICE_ID: 'device-id',
} as const;

// ==================== Token State ====================

/**
 * In-memory token cache for fast access
 */
let accessTokenCache: string | null = null;
let deviceIdCache: string | null = null;

// ==================== Public API ====================

/**
 * Load tokens from localStorage into memory cache
 */
export function loadTokensFromStorage(): void {
  try {
    accessTokenCache = localStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN);
    deviceIdCache = localStorage.getItem(STORAGE_KEYS.DEVICE_ID);
    console.log('[tokens] Loaded from localStorage - accessToken:', accessTokenCache ? 'present' : 'null', 'deviceId:', deviceIdCache ? 'present' : 'null');
  } catch (error) {
    console.error('[tokens] Failed to load from localStorage:', error);
    clearTokens();
  }
}

/**
 * Get current access token
 * Falls back to localStorage if cache is empty
 */
export function getAccessToken(): string | null {
  if (!accessTokenCache) {
    const stored = localStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN);
    if (stored) {
      accessTokenCache = stored;
      console.log('[tokens] getAccessToken: loaded from localStorage');
    } else {
      console.log('[tokens] getAccessToken: no token in localStorage');
    }
  } else {
    console.log('[tokens] getAccessToken: using cached token');
  }
  return accessTokenCache;
}

/**
 * Get current device ID
 */
export function getDeviceId(): string | null {
  if (!deviceIdCache) {
    deviceIdCache = localStorage.getItem(STORAGE_KEYS.DEVICE_ID);
  }
  return deviceIdCache;
}

/**
 * Store access token and optional device ID
 * NOTE: Refresh token is handled via httpOnly cookie - not stored here
 */
export function setAccessToken(accessToken: string, deviceId?: string): void {
  accessTokenCache = accessToken;

  localStorage.setItem(STORAGE_KEYS.ACCESS_TOKEN, accessToken);
  
  // Clear auth header cache when token changes
  clearAuthHeaderCache();

  if (deviceId) {
    deviceIdCache = deviceId;
    localStorage.setItem(STORAGE_KEYS.DEVICE_ID, deviceId);
  }
}

/**
 * Clear access token from memory and storage
 * NOTE: Device ID is preserved to maintain device identity across sessions.
 * This prevents creation of duplicate devices when user re-authenticates.
 */
export function clearTokens(): void {
  accessTokenCache = null;
  // NOTE: deviceIdCache is preserved - device identity must persist across sessions
  // deviceIdCache = null;

  localStorage.removeItem(STORAGE_KEYS.ACCESS_TOKEN);
  // NOTE: Device ID is NOT removed - it must persist across sessions on the same device
  // localStorage.removeItem(STORAGE_KEYS.DEVICE_ID);
}

/**
 * Clear all tokens including device ID.
 * Use this when user explicitly signs out from this device.
 */
export function clearAllIncludingDevice(): void {
  accessTokenCache = null;
  deviceIdCache = null;

  localStorage.removeItem(STORAGE_KEYS.ACCESS_TOKEN);
  localStorage.removeItem(STORAGE_KEYS.DEVICE_ID);
}

/**
 * Check if user has valid access token
 */
export function hasAccessToken(): boolean {
  return !!getAccessToken();
}

/**
 * Get Authorization header value
 */
let cachedAuthHeader: string | null | undefined = undefined;
let cachedAuthHeaderToken: string | null = null;

export function getAuthHeader(): string | null {
  const token = getAccessToken();
  
  // Return cached value if token hasn't changed
  if (token === cachedAuthHeaderToken && cachedAuthHeader !== undefined) {
    return cachedAuthHeader;
  }
  
  // Update cache
  cachedAuthHeaderToken = token;
  cachedAuthHeader = token ? `Bearer ${token}` : null;
  
  return cachedAuthHeader;
}

/**
 * Clear auth header cache (call when token changes)
 */
export function clearAuthHeaderCache(): void {
  cachedAuthHeader = undefined;
  cachedAuthHeaderToken = null;
}

/**
 * Parse JWT payload without validation
 * Returns null if token is invalid
 */
export function parseJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    
    const payloadPart = parts[1];
    if (!payloadPart) return null;
    
    const payload = atob(payloadPart);
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

/**
 * Check if token is expired (with 30s buffer)
 */
export function isTokenExpired(token: string): boolean {
  const payload = parseJwtPayload(token);
  const exp = payload?.['exp'];
  if (!payload || typeof exp !== 'number') return true;
  
  // 30 second buffer before actual expiration
  const bufferMs = 30 * 1000;
  return Date.now() >= (exp * 1000) - bufferMs;
}

// Initialize on module load
loadTokensFromStorage();