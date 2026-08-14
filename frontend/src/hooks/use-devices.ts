/**
 * useDevices Hook
 * 
 * Custom hook for device management:
 * - Loading devices
 * - Removing devices
 * - Renaming devices
 * - Auto-refresh capability
 * 
 * @module hooks/use-devices
 */

import { useCallback, useEffect,useState } from 'react';

import {
  type Device,
  DeviceError,
  type DevicesResponse,
  generateVerificationCode,
  getDevices,
  getPendingVerifications,
  type PendingVerificationsResponse,
  removeDevice,
  updateDeviceName,
  type VerificationCodeResponse,
  verifyDevice,
  type VerifyDeviceResponse,
} from '@/services/devices';

// ==================== Types ====================

export interface UseDevicesOptions {
  autoLoad?: boolean;
}

export interface UseDevicesReturn {
  devices: Device[];
  currentDeviceId: string | null;
  isLoading: boolean;
  error: string | null;
  loadDevices: () => Promise<void>;
  removeDeviceById: (deviceId: string) => Promise<void>;
  renameDevice: (deviceId: string, newName: string) => Promise<void>;
  generateVerificationCode: (deviceId: string) => Promise<VerificationCodeResponse>;
  verifyDevice: (deviceId: string, code: string) => Promise<VerifyDeviceResponse>;
  getPendingVerifications: () => Promise<PendingVerificationsResponse>;
  refresh: () => Promise<void>;
  clearError: () => void;
}

// ==================== Hook ====================

export function useDevices(options: UseDevicesOptions = {}): UseDevicesReturn {
  const { autoLoad = true } = options;

  const [devices, setDevices] = useState<Device[]>([]);
  const [currentDeviceId, setCurrentDeviceId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadDevices = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const response: DevicesResponse = await getDevices();
      setDevices(response.devices);
      setCurrentDeviceId(response.current_device_id);
    } catch (err) {
      if (err instanceof DeviceError) {
        setError(err.message);
      } else {
        setError('Failed to load devices');
      }
      console.error('[useDevices] Failed to load devices:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const removeDeviceById = useCallback(async (deviceId: string) => {
    setError(null);

    // Optimistic update with rollback: save previous state
    const previousDevices = devices;
    
    // Update local state immediately (optimistic)
    setDevices((prev) => prev.filter((d) => d.id !== deviceId));

    try {
      await removeDevice(deviceId);
    } catch (err) {
      // Rollback on error: restore previous state
      setDevices(previousDevices);
      
      if (err instanceof DeviceError) {
        setError(err.message);
      } else {
        setError('Failed to remove device');
      }
      console.error('[useDevices] Failed to remove device:', err);
      throw err;
    }
  }, [devices]);

  const renameDevice = useCallback(async (deviceId: string, newName: string) => {
    setError(null);

    try {
      const response = await updateDeviceName(deviceId, newName);
      // Update local state immediately
      setDevices((prev) =>
        prev.map((d) =>
          d.id === deviceId
            ? { ...d, name: response.device.name }
            : d
        )
      );
    } catch (err) {
      if (err instanceof DeviceError) {
        setError(err.message);
      } else {
        setError('Failed to rename device');
      }
      console.error('[useDevices] Failed to rename device:', err);
      throw err;
    }
  }, []);

  const handleGenerateVerificationCode = useCallback(async (deviceId: string): Promise<VerificationCodeResponse> => {
    setError(null);

    try {
      const response = await generateVerificationCode(deviceId);
      return response;
    } catch (err) {
      if (err instanceof DeviceError) {
        setError(err.message);
      } else {
        setError('Failed to generate verification code');
      }
      console.error('[useDevices] Failed to generate verification code:', err);
      throw err;
    }
  }, []);

  const handleVerifyDevice = useCallback(async (deviceId: string, code: string): Promise<VerifyDeviceResponse> => {
    setError(null);

    try {
      const response = await verifyDevice(deviceId, code);
      
      // If verification was successful, refresh the devices list
      if (response.verified) {
        await loadDevices();
      }
      
      return response;
    } catch (err) {
      if (err instanceof DeviceError) {
        setError(err.message);
      } else {
        setError('Failed to verify device');
      }
      console.error('[useDevices] Failed to verify device:', err);
      throw err;
    }
  }, [loadDevices]);

  const handleGetPendingVerifications = useCallback(async (): Promise<PendingVerificationsResponse> => {
    setError(null);

    try {
      const response = await getPendingVerifications();
      return response;
    } catch (err) {
      if (err instanceof DeviceError) {
        setError(err.message);
      } else {
        setError('Failed to get pending verifications');
      }
      console.error('[useDevices] Failed to get pending verifications:', err);
      throw err;
    }
  }, []);

  const refresh = useCallback(async () => {
    await loadDevices();
  }, [loadDevices]);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  // Auto-load on mount
  useEffect(() => {
    if (autoLoad) {
      loadDevices();
    }
  }, [autoLoad, loadDevices]);

  return {
    devices,
    currentDeviceId,
    isLoading,
    error,
    loadDevices,
    removeDeviceById,
    renameDevice,
    generateVerificationCode: handleGenerateVerificationCode,
    verifyDevice: handleVerifyDevice,
    getPendingVerifications: handleGetPendingVerifications,
    refresh,
    clearError,
  };
}

export default useDevices;