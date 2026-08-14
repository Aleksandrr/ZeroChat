/**
 * Device Service Module
 * 
 * Provides device management functionality:
 * - List all user devices
 * - Remove device (sign out)
 * - Update device name
 * - Generate verification code
 * - Verify device
 * - Get pending verifications
 * 
 * @module devices
 */

// Types
export type {
  DeleteDeviceResponse,
  Device,
  DevicesResponse,
  PendingVerification,
  PendingVerificationsResponse,
  UpdateDeviceNameRequest,
  UpdateDeviceResponse,
  VerificationCodeResponse,
  VerifyDeviceResponse,
} from './types';
export { DeviceError } from './types';

// API Functions
export {
  generateVerificationCode,
  getDevices,
  getPendingVerifications,
  removeDevice,
  updateDeviceName,
  verifyDevice,
} from './api';
