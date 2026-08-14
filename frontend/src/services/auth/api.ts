/**
 * Auth API Module
 * 
 * Provides API functions for authentication: login, register, logout, refresh.
 * Uses token management from tokens.ts and HMAC signing from hmac.ts.
 * Uses TokenRefreshManager for proactive refresh and 401 handling.
 * 
 * SECURITY: Refresh token is stored in httpOnly cookie (not accessible to JS).
 * All requests use credentials: 'include' to send cookies.
 * 
 * @module auth/api
 */

import { TokenRefreshManager } from './token-refresh';
import {
  clearTokens,
  getAccessToken,
  getAuthHeader,
  getDeviceId,
  setAccessToken,
} from './tokens';
import type {
  BackendAuthResponse,
  BackendKeysPublishResponse,
  BackendRefreshResponse,
  Device,
  LoginCredentials,
  RegisterData,
  SignalKeysPublishRequest,
} from './types';
import { AuthError, NetworkError } from './types';

// ==================== Configuration ====================

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001/api';

// ==================== Token Refresh Helper ====================

/**
 * Get refreshed token using TokenRefreshManager
 * Handles queue automatically to prevent race conditions
 */
async function getRefreshedToken(): Promise<string> {
  const manager = TokenRefreshManager.getInstance();
  const result = await manager.forceRefresh();
  
  if (result.success && result.accessToken) {
    return result.accessToken;
  }
  
  throw new AuthError('Сессия истекла. Войдите снова.', 'SESSION_EXPIRED', 401);
}

// ==================== Request Helper ====================

/**
 * Make authenticated API request with automatic token refresh
 */
async function request<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${API_BASE_URL}${endpoint}`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options.headers as Record<string, string>) || {}),
  };

  const token = getAccessToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  try {
    console.log('[request] Making request to:', endpoint);
    const response = await fetch(url, {
      ...options,
      headers,
      credentials: 'include',
    });

    console.log('[request] Response status:', response.status, 'for endpoint:', endpoint);

    // Handle 401 - try to refresh token once (with queue to prevent race condition)
    // Refresh token is sent via httpOnly cookie automatically
    if (response.status === 401) {
      console.log('[request] Got 401, attempting token refresh...');
      try {
        const newToken = await getRefreshedToken();
        console.log('[request] Token refresh succeeded, retrying request...');
        headers['Authorization'] = `Bearer ${newToken}`;
        const retryResponse = await fetch(url, {
          ...options,
          headers,
          credentials: 'include',
        });

        console.log('[request] Retry response status:', retryResponse.status);

        if (!retryResponse.ok) {
          throw handleError(retryResponse);
        }

        return retryResponse.json();
      } catch (refreshError) {
        console.error('[request] Token refresh failed:', refreshError);
        clearTokens();
        throw new AuthError('\u0421\u0435\u0441\u0441\u0438\u044f \u0438\u0441\u0442\u0435\u043a\u043b\u0430. \u0412\u043e\u0439\u0434\u0438\u0442\u0435 \u0441\u043d\u043e\u0432\u0430.', 'SESSION_EXPIRED', 401);
      }
    }

    if (!response.ok) {
      throw handleError(response);
    }

    const text = await response.text();
    return text ? JSON.parse(text) : ({} as T);
  } catch (error) {
    if (error instanceof AuthError) throw error;
    if (error instanceof TypeError && error.message.includes('fetch')) {
      throw new NetworkError('\u041e\u0448\u0438\u0431\u043a\u0430 \u0441\u0435\u0442\u0438. \u041f\u0440\u043e\u0432\u0435\u0440\u044c\u0442\u0435 \u0441\u043e\u0435\u0434\u0438\u043d\u0435\u043d\u0438\u0435.');
    }
    throw error;
  }
}

/**
 * Handle HTTP error response
 */
async function handleError(response: Response): Promise<AuthError> {
  const statusCode = response.status;
  let message = '\u041f\u0440\u043e\u0438\u0437\u043e\u0448\u043b\u0430 \u043e\u0448\u0438\u0431\u043a\u0430';
  let code = 'UNKNOWN_ERROR';

  try {
    const errorData = await response.json();
    message = errorData.message || message;
    code = errorData.code || code;

    if (errorData.errors && Array.isArray(errorData.errors) && errorData.errors.length > 0) {
      message = `${message}: ${errorData.errors.join('; ')}`;
    }
  } catch {
    const errorMessages: Record<number, { message: string; code: string }> = {
      400: { message: '\u041d\u0435\u0432\u0435\u0440\u043d\u044b\u0439 \u0437\u0430\u043f\u0440\u043e\u0441. \u041f\u0440\u043e\u0432\u0435\u0440\u044c\u0442\u0435 \u0432\u0432\u043e\u0434.', code: 'BAD_REQUEST' },
      401: { message: '\u041d\u0435\u0432\u0435\u0440\u043d\u044b\u0435 \u0443\u0447\u0451\u0442\u043d\u044b\u0435 \u0434\u0430\u043d\u043d\u044b\u0435. \u041f\u043e\u043f\u0440\u043e\u0431\u0443\u0439\u0442\u0435 \u0441\u043d\u043e\u0432\u0430.', code: 'UNAUTHORIZED' },
      403: { message: '\u0414\u043e\u0441\u0442\u0443\u043f \u0437\u0430\u043f\u0440\u0435\u0449\u0451\u043d.', code: 'FORBIDDEN' },
      404: { message: '\u0420\u0435\u0441\u0443\u0440\u0441 \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d.', code: 'NOT_FOUND' },
      409: { message: '\u041f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u044c \u0443\u0436\u0435 \u0441\u0443\u0449\u0435\u0441\u0442\u0432\u0443\u0435\u0442.', code: 'CONFLICT' },
      422: { message: '\u041e\u0448\u0438\u0431\u043a\u0430 \u0432\u0430\u043b\u0438\u0434\u0430\u0446\u0438\u0438.', code: 'VALIDATION_ERROR' },
      429: { message: '\u0421\u043b\u0438\u0448\u043a\u043e\u043c \u043c\u043d\u043e\u0433\u043e \u0437\u0430\u043f\u0440\u043e\u0441\u043e\u0432. \u041f\u043e\u043f\u0440\u043e\u0431\u0443\u0439\u0442\u0435 \u043f\u043e\u0437\u0436\u0435.', code: 'RATE_LIMIT' },
      500: { message: '\u041e\u0448\u0438\u0431\u043a\u0430 \u0441\u0435\u0440\u0432\u0435\u0440\u0430. \u041f\u043e\u043f\u0440\u043e\u0431\u0443\u0439\u0442\u0435 \u043f\u043e\u0437\u0436\u0435.', code: 'INTERNAL_ERROR' },
    };

    const mapped = errorMessages[statusCode];
    if (mapped) {
      message = mapped.message;
      code = mapped.code;
    }
  }

  return new AuthError(message, code, statusCode);
}

// ==================== Auth API ====================

/**
 * Login user with credentials
 * NOTE: Uses direct fetch instead of request() to avoid auto-refresh on 401.
 * Login failures (wrong password) return 401, which should NOT trigger token refresh.
 */
export async function login(credentials: LoginCredentials): Promise<BackendAuthResponse> {
  const existingDeviceId = getDeviceId();

  const requestBody = existingDeviceId
    ? { ...credentials, deviceId: existingDeviceId }
    : credentials;

  // Direct fetch to avoid auto-refresh on 401 (wrong password should show actual error)
  const url = `${API_BASE_URL}/auth/login`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
    credentials: 'include',
  });

  if (!response.ok) {
    throw await handleError(response);
  }

  const data = await response.json() as BackendAuthResponse;

  // Save access token (refresh token is in httpOnly cookie)
  if (data.data?.accessToken) {
    setAccessToken(data.data.accessToken, data.data.deviceId);
  }

  return data;
}

/**
 * Get existing Signal deviceId from IndexedDB
 * Used to check if we have existing Signal keys before login
 */
export async function getExistingSignalDeviceId(): Promise<number | null> {
  try {
    const { getExistingDeviceId } = await import('@/lib/signal/storage');
    return await getExistingDeviceId();
  } catch {
    return null;
  }
}

/**
 * Register new user
 * NOTE: Uses direct fetch instead of request() to avoid auto-refresh on 401/400.
 * Registration failures should show actual error, not "session expired".
 */
export async function register(data: RegisterData): Promise<BackendAuthResponse> {
  const url = `${API_BASE_URL}/auth/register`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data),
    credentials: 'include',
  });

  if (!response.ok) {
    throw await handleError(response);
  }

  const result = await response.json() as BackendAuthResponse;

  // Save access token (refresh token is in httpOnly cookie)
  if (result.data?.accessToken) {
    setAccessToken(result.data.accessToken, result.data.deviceId);
  }

  return result;
}

/**
 * Logout user
 */
export async function logout(): Promise<void> {
  try {
    await request('/auth/logout', {
      method: 'POST',
      body: JSON.stringify({}),
    });
  } catch (error) {
    console.warn('[Auth] Logout request failed:', error);
  } finally {
    clearTokens();
  }
}

/**
 * Refresh access token
 * NOTE: This function uses direct fetch instead of request() to avoid infinite recursion.
 * If refresh fails with 401, we should NOT try to refresh again.
 * 
 * SECURITY: Refresh token is sent via httpOnly cookie automatically (credentials: 'include').
 * No need to read or send refresh token from JavaScript.
 */
export async function refreshTokens(): Promise<{ accessToken: string }> {
  // Direct fetch to avoid recursion with request()
  // Refresh token is sent via httpOnly cookie automatically
  const url = `${API_BASE_URL}/auth/refresh`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
    credentials: 'include',
  });

  if (!response.ok) {
    throw new AuthError('Token refresh failed', 'REFRESH_FAILED', response.status);
  }

  const data = await response.json() as BackendRefreshResponse & {
    data?: {
      accessToken: string;
      expiresIn: number;
      tokenId: string;
    };
  };

  if (!data.data?.accessToken) {
    throw new AuthError('Invalid refresh response', 'INVALID_REFRESH_RESPONSE');
  }

  // Save new access token (refresh token is handled via httpOnly cookie)
  setAccessToken(data.data.accessToken);

  return { accessToken: data.data.accessToken };
}

/**
 * Get current user profile
 */
export async function getCurrentUser() {
  const response = await request<{ success: boolean; user: { id: string; username: string } }>('/auth/me');

  if (!response.success || !response.user) {
    throw new AuthError('Failed to get user profile', 'GET_USER_FAILED');
  }

  return response.user;
}

// Device availability check is now in src/services/device-check.ts
// Import from there to avoid circular dependencies with signal/storage

/**
 * Publish Signal Protocol keys to server
 *
 * SECURITY (P0-1): Replaced client-side HMAC signing with JWT-only
 * authentication. Previously this request carried an `X-Signature`
 * header derived from `VITE_HMAC_SECRET`, which was embedded in the
 * JS bundle and trivially recoverable from DevTools — allowing anyone
 * to forge publication requests on behalf of any user. The JWT in
 * `Authorization: Bearer` is now the sole authentication factor; any
 * additional HMAC the backend needs is derived server-side.
 */
export async function publishSignalKeys(keys: SignalKeysPublishRequest): Promise<BackendKeysPublishResponse> {
  // Build the payload inline (was previously `buildKeyPublicationPayload`
  // from hmac.ts — that helper was removed together with the master secret).
  const payload = JSON.stringify({
    deviceId: keys.deviceId,
    registrationId: keys.registrationId,
    identityKeyPub: keys.identityKey,
    signedPreKey: {
      id: keys.signedPreKey.id,
      pub: keys.signedPreKey.publicKey,
      sig: keys.signedPreKey.signature,
    },
    ecOneTimePreKeys: keys.preKeys.map(pk => ({
      id: pk.id,
      pub: pk.publicKey,
    })),
    pqLastResortPreKey: {
      id: keys.kyberPreKey.id,
      pub: keys.kyberPreKey.publicKey,
      sig: keys.kyberPreKey.signature,
    },
  });
  const authHeader = getAuthHeader();

  const response = await fetch(`${API_BASE_URL}/keys/pqxdh/publish`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authHeader ? { 'Authorization': authHeader } : {}),
    },
    body: payload,
  });

  if (!response.ok) {
    throw await handleError(response);
  }

  return response.json();
}

// ==================== Device Management ====================

/**
 * Unregister current device
 */
export async function unregisterDevice(): Promise<void> {
  const authHeader = getAuthHeader();
  const deviceId = getDeviceId();

  const response = await fetch(`${API_BASE_URL}/auth/unregister`, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      ...(authHeader ? { 'Authorization': authHeader } : {}),
    },
    body: JSON.stringify({ deviceId }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.message || 'Failed to unregister device');
  }
}

/**
 * Get all user devices
 */
export async function getDevices(): Promise<Device[]> {
  const authHeader = getAuthHeader();

  const response = await fetch(`${API_BASE_URL}/users/me/devices`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(authHeader ? { 'Authorization': authHeader } : {}),
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.message || 'Failed to get devices');
  }

  const data = await response.json();
  if (Array.isArray(data)) return data;
  return (data as { data?: Device[]; devices?: Device[] }).data || (data as { devices?: Device[] }).devices || [];
}

/**
 * Delete specific device
 */
export async function deleteDevice(deviceId: string): Promise<void> {
  const authHeader = getAuthHeader();

  const response = await fetch(`${API_BASE_URL}/users/me/devices/${deviceId}`, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      ...(authHeader ? { 'Authorization': authHeader } : {}),
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.message || 'Failed to delete device');
  }
}

/**
 * Refresh device token - get a new JWT with a different deviceId
 */
export async function refreshDeviceToken(newDeviceId: string): Promise<{
  accessToken: string;
  deviceId: string;
}> {
  const response = await request<{
    success: boolean;
    accessToken: string;
    deviceId: string;
    message?: string;
  }>('/auth/refresh-device', {
    method: 'POST',
    body: JSON.stringify({ newDeviceId }),
  });

  if (!response.success) {
    throw new AuthError(response.message || 'Failed to refresh device token', 'REFRESH_DEVICE_FAILED');
  }

  // Save access token (refresh token is in httpOnly cookie)
  setAccessToken(response.accessToken, response.deviceId);

  return {
    accessToken: response.accessToken,
    deviceId: response.deviceId,
  };
}

// ==================== Prekey Manager (U10 / U11) ====================

/**
 * Fetch the server-side one-time prekey counts for a user.
 *
 * Returns `{ ecPreKeyCount, pqPreKeyCount }` — both are the number
 * of UNCONSUMED one-time prekeys the server is holding for this user
 * (across all their devices). Used by `usePrekeyManager` (U10) to
 * decide whether the pool has dropped below the 25% replenishment
 * threshold.
 *
 * Endpoint: `GET /keys/pqxdh/status/:userId` (JWT-only auth).
 */
export async function fetchPreKeyStatus(
  userId: string,
): Promise<{ ecPreKeyCount: number; pqPreKeyCount: number }> {
  const authHeader = getAuthHeader();
  const response = await fetch(`${API_BASE_URL}/keys/pqxdh/status/${encodeURIComponent(userId)}`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(authHeader ? { 'Authorization': authHeader } : {}),
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch prekey status: ${response.status}`);
  }

  const json = (await response.json()) as {
    success?: boolean;
    data?: { ecPreKeyCount?: number; pqPreKeyCount?: number };
  };
  return {
    ecPreKeyCount: json.data?.ecPreKeyCount ?? 0,
    pqPreKeyCount: json.data?.pqPreKeyCount ?? 0,
  };
}

/**
 * Upload a batch of freshly-generated one-time EC + PQ prekeys to the
 * server (U10 — prekey replenishment). The server stores them in the
 * `OneTimePreKey` / `PqOneTimePreKey` tables and serves one per
 * bundle fetch until they're consumed.
 *
 * Endpoint: `POST /keys/pqxdh/one-time` (JWT-only auth).
 *
 * NOTE: The backend route still demands `X-Timestamp` / `X-Signature`
 * HMAC headers (see `back/src/routes/keys.ts`). The frontend removed
 * client-side HMAC in P0-1 (it was trivially recoverable from the JS
 * bundle), so this request will currently return 401 until the
 * backend is patched to accept JWT-only auth for this route. The
 * `usePrekeyManager` hook calls this best-effort and logs failures
 * without blocking — local prekeys are still generated + persisted,
 * so once the backend HMAC check is relaxed the upload will "just
 * work" without further frontend changes.
 */
export async function publishOneTimePreKeys(params: {
  deviceId: string;
  ecOneTimePreKeys?: Array<{ id: number; pub: string }>;
  pqOneTimePreKeys?: Array<{ id: number; pub: string; sig: string }>;
}): Promise<void> {
  const authHeader = getAuthHeader();
  const response = await fetch(`${API_BASE_URL}/keys/pqxdh/one-time`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authHeader ? { 'Authorization': authHeader } : {}),
    },
    body: JSON.stringify({
      deviceId: params.deviceId,
      ecOneTimePreKeys: params.ecOneTimePreKeys,
      pqOneTimePreKeys: params.pqOneTimePreKeys,
    }),
  });

  if (!response.ok) {
    // Surface the status code so the caller can decide whether to log
    // silently (401 from the HMAC mismatch above) or escalate.
    const text = await response.text().catch(() => '');
    throw new Error(`publishOneTimePreKeys failed: ${response.status} ${text}`);
  }
}

/**
 * Publish a freshly-rotated signed prekey to the server (U11).
 *
 * There is no dedicated `/keys/pqxdh/signed-prekey` endpoint, so we
 * reuse the full `publishSignalKeys` call (which updates the SPK
 * AND re-publishes the identity + one-time prekeys). The caller is
 * expected to pass the existing identity + the new SPK. The
 * `ecOneTimePreKeys` / `pqOneTimePreKeys` arrays can be left empty —
 * the backend will then DELETE existing one-time prekeys (since the
 * publish route wipes them) — but `usePrekeyManager` always uploads
 * a fresh batch of one-time prekeys alongside the rotated SPK so the
 * server-side pool is replenished atomically with the SPK rotation.
 */
export async function publishSignedPreKeyRotation(params: {
  userId: string;
  /** Signal protocol deviceId (numeric, 1-127). NOT the session deviceId. */
  deviceId: number | null;
  registrationId: number;
  identityKey: string;
  signedPreKey: { id: number; publicKey: string; signature: string };
  kyberPreKey: { id: number; publicKey: string; signature: string };
  ecOneTimePreKeys?: Array<{ id: number; publicKey: string }>;
  pqOneTimePreKeys?: Array<{ id: number; publicKey: string; signature: string }>;
}): Promise<void> {
  await publishSignalKeys({
    userId: params.userId,
    deviceId: params.deviceId,
    registrationId: params.registrationId,
    identityKey: params.identityKey,
    preKeys: params.ecOneTimePreKeys ?? [],
    signedPreKey: params.signedPreKey,
    kyberPreKey: params.kyberPreKey,
  });
}