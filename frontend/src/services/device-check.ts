/**
 * Device Availability Check Module
 *
 * Provides functions to check if a Signal device ID is available on the server.
 * This module is separate from auth/api.ts to avoid circular dependencies
 * with signal/storage/identity.ts.
 *
 * @module device-check
 */

import { getAccessToken, getAuthHeader } from './auth/tokens';
import type { NetworkError } from './auth/types';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001/api';

/**
 * Check if a Signal device ID is available on the server
 * Returns true if the device ID is available (can be used), false if already taken
 */
export async function checkSignalDeviceId(signalDeviceId: number): Promise<boolean> {
  try {
    const authHeader = getAuthHeader();
    const response = await fetch(`${API_BASE_URL}/keys/check-signal-device-id`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authHeader ? { 'Authorization': authHeader } : {}),
      },
      body: JSON.stringify({ signalDeviceId }),
    });

    if (!response.ok) {
      // If request fails, assume device ID is available (conservative)
      return true;
    }

    const data = await response.json();
    return data.data?.isAvailable ?? true;
  } catch (error) {
    // On network error, assume device ID is available (conservative)
    console.warn('[DeviceCheck] Failed to check device ID availability:', error);
    return true;
  }
}
