/**
 * Auth Service Module
 * 
 * Provides authentication functionality: login, register, logout, token management.
 * Split into focused submodules for maintainability.
 * 
 * SECURITY: Refresh token is stored in httpOnly cookie (not accessible to JS).
 * This module only exports access token management functions.
 * 
 * @module auth
 */

// Types
export type {
  BackendAuthResponse,
  BackendKeysPublishResponse,
  BackendRefreshResponse,
  Device,
  LoginCredentials,
  RegisterData,
  SignalKeysPublishRequest,
} from './types';
export { AuthError, NetworkError } from './types';

// Token Management (access token only - refresh token is in httpOnly cookie)
export {
  clearAllIncludingDevice,
  clearTokens,
  getAccessToken,
  getAuthHeader,
  getDeviceId,
  hasAccessToken,
  isTokenExpired,
  parseJwtPayload,
  setAccessToken,
} from './tokens';

// Token Refresh Manager
export type {
  RefreshResult,
  TokenRefreshHandlers,
  TokenRefreshManagerConfig,
} from './token-refresh';
export {
  getTokenRefreshManager,
  startProactiveRefresh,
  stopProactiveRefresh,
  TokenRefreshManager,
} from './token-refresh';

// HMAC Signing
export {
  createHmacSignature,
  generateHmac,
  signKeyPublication,
  verifyHmac,
} from './hmac';

// Device Check (separate module to avoid circular dependencies)
export { checkSignalDeviceId } from '../device-check';

// API Functions
export {
  deleteDevice,
  fetchPreKeyStatus,
  getCurrentUser,
  getDevices,
  login,
  logout,
  publishOneTimePreKeys,
  publishSignalKeys,
  publishSignedPreKeyRotation,
  refreshDeviceToken,
  refreshTokens,
  register,
  unregisterDevice,
} from './api';