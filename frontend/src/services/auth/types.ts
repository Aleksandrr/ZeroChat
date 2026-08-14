/**
 * Auth Service Types
 * 
 * TypeScript interfaces and error classes for authentication module.
 * 
 * SECURITY: Refresh token is stored in httpOnly cookie (not accessible to JS).
 * Backend responses no longer include refreshToken in the body.
 * 
 * @module auth/types
 */

import type { Device,LoginCredentials, RegisterData, User } from '@/types';

// ==================== Response Types ====================

/**
 * Backend response for login/register operations
 * NOTE: refreshToken is sent via httpOnly cookie, not in response body
 */
export interface BackendAuthResponse {
  success: boolean;
  message?: string;
  user: User;
  data: {
    accessToken: string;
    expiresIn: number;
    deviceId?: string;
    deviceNeedsVerification?: boolean;
  };
}

/**
 * Backend response for token refresh
 */
export interface BackendRefreshResponse {
  success: boolean;
  data: {
    accessToken: string;
    expiresIn: number;
    tokenId: string;
  };
}

/**
 * Signal Protocol keys publish request
 */
export interface SignalKeysPublishRequest {
  userId: string;
  deviceId: number | null;
  registrationId: number;
  identityKey: string;
  preKeys: { id: number; publicKey: string }[];
  signedPreKey: { id: number; publicKey: string; signature: string };
  kyberPreKey: { id: number; publicKey: string; signature: string };
}

/**
 * Backend response for keys publication
 */
export interface BackendKeysPublishResponse {
  success: boolean;
  message?: string;
  storedPreKeys?: number;
  newDeviceId?: string;
  signalDeviceId?: number;
}

// ==================== Error Classes ====================

/**
 * Authentication error with code and optional HTTP status
 */
export class AuthError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode?: number
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

/**
 * Network connectivity error
 */
export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

// ==================== Re-exports ====================

export type { Device,LoginCredentials, RegisterData, User };