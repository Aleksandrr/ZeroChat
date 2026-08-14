/**
 * Device Service Types
 * 
 * Types for device management API.
 * Matches backend response structure from backend/src/routes/devices.ts
 */

/**
 * Device data from API response
 */
export interface Device {
  id: string;
  device_uuid: string;
  name: string;
  type: string;
  fingerprint: string | null;
  last_seen_at: string | null;
  verified_at: string | null;
  is_current: boolean;
  created_at: string;
}

/**
 * Response from GET /api/devices
 */
export interface DevicesResponse {
  success: boolean;
  devices: Device[];
  current_device_id: string;
}

/**
 * Response from DELETE /api/devices/:id
 */
export interface DeleteDeviceResponse {
  success: boolean;
  message: string;
}

/**
 * Request for PATCH /api/devices/:id
 */
export interface UpdateDeviceNameRequest {
  name: string;
}

/**
 * Response from PATCH /api/devices/:id
 */
export interface UpdateDeviceResponse {
  success: boolean;
  device: Device;
}

/**
 * Verification code response
 * In decentralized flow, code is generated on client device, so backend returns success without code
 */
export interface VerificationCodeResponse {
  success: boolean;
  code?: string;  // Optional: not returned in decentralized flow
  expires_at?: string;  // Optional: not returned in decentralized flow
  retryAfter?: number;  // секунд до следующей попытки (при 429)
  message?: string;  // Optional message (e.g., "Verification command sent to your other device")
}

/**
 * Verify device response
 */
export interface VerifyDeviceResponse {
  success: boolean;
  verified: boolean;
  device: {
    id: string;
    device_uuid: string;
    verified_at: string | null;
  };
  message?: string;
  attemptsRemaining?: number;
  lockedUntil?: number;  // секунд до разблокировки
}

/**
 * Pending verification
 */
export interface PendingVerification {
  id: string;
  device_id: string;
  device_name: string;
  device_type: string;
  fingerprint: string | null;
  last_seen_at: string | null;
  created_at: string;
  expires_at: string;
}

/**
 * Pending verifications response
 */
export interface PendingVerificationsResponse {
  success: boolean;
  devices: PendingVerification[];
}

/**
 * Device error types
 */
export class DeviceError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode?: number
  ) {
    super(message);
    this.name = 'DeviceError';
  }
}
