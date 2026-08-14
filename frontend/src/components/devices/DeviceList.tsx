/**
 * DeviceList Component
 * 
 * Displays a list of user devices with:
 * - Loading state
 * - Empty state
 * - Device items with actions
 * - Security warning message
 * 
 * @module components/devices/DeviceList
 */

import { AlertTriangle, RefreshCw,Smartphone } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import type { Device } from '@/services/devices';

import { DeviceItem } from './DeviceItem';

// ==================== Types ====================

export interface DeviceListProps {
  devices: Device[];
  currentDeviceId: string;
  onRemoveDevice: (deviceId: string) => Promise<void>;
  onRenameDevice?: (deviceId: string, newName: string) => Promise<void>;
  onRefresh?: () => Promise<void>;
  isLoading?: boolean;
}

// ==================== Component ====================

export function DeviceList({
  devices,
  currentDeviceId: _currentDeviceId,
  onRemoveDevice,
  onRenameDevice,
  onRefresh,
  isLoading = false,
}: DeviceListProps) {
  const [removingDeviceId, setRemovingDeviceId] = React.useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = React.useState(false);

  const handleRemove = async (deviceId: string) => {
    setRemovingDeviceId(deviceId);
    try {
      await onRemoveDevice(deviceId);
    } finally {
      setRemovingDeviceId(null);
    }
  };

  const handleRefresh = async () => {
    if (onRefresh) {
      setIsRefreshing(true);
      try {
        await onRefresh();
      } finally {
        setIsRefreshing(false);
      }
    }
  };

  const isAnyLoading = isLoading || isRefreshing;

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Your Devices</h3>
        {onRefresh && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={isAnyLoading}
            className="gap-1"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        )}
      </div>

      {/* Loading State */}
      {isLoading && devices.length === 0 && (
        <div className="flex items-center justify-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
        </div>
      )}

      {/* Empty State */}
      {!isLoading && devices.length === 0 && (
        <div className="text-center py-8 text-muted-foreground">
          <Smartphone className="w-12 h-12 mx-auto mb-2 opacity-50" />
          <p>No connected devices</p>
        </div>
      )}

      {/* Device List */}
      {devices.length > 0 && (
        <div className="space-y-2">
          {devices.map((device) => (
            <DeviceItem
              key={device.id}
              device={device}
              onRemove={handleRemove}
              onRename={onRenameDevice}
              isLoading={isAnyLoading}
              isRemoving={removingDeviceId === device.id}
            />
          ))}
        </div>
      )}

      {/* Security Warning */}
      <div className="mt-4 p-3 rounded-md border border-yellow-500/30 bg-yellow-500/10">
        <div className="flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-yellow-600 dark:text-yellow-400 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-yellow-800 dark:text-yellow-200">
              Security Notice
            </p>
            <p className="text-xs text-yellow-700 dark:text-yellow-300 mt-1">
              Removing a device will sign out from it and you will lose access to messages on that device.
              This action cannot be undone.
            </p>
          </div>
        </div>
      </div>

      {/* Device Count */}
      {devices.length > 0 && (
        <p className="text-xs text-muted-foreground text-center">
          {devices.length} {devices.length === 1 ? 'device' : 'devices'} connected
        </p>
      )}
    </div>
  );
}

export default DeviceList;