/**
 * DeviceItem Component
 * 
 * Displays a single device card with:
 * - Device icon based on type
 * - Device name
 * - Current device badge
 * - Verified/Not verified status
 * - Last activity timestamp
 * - Remove button (non-current devices only)
 * 
 * @module components/devices/DeviceItem
 */

import { AlertTriangle, Check, Globe, Monitor, Pencil,Smartphone, Trash2 } from 'lucide-react';
import * as React from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { Device } from '@/services/devices';

// ==================== Types ====================

export interface DeviceItemProps {
  device: Device;
  onRemove?: (deviceId: string) => Promise<void>;
  onRename?: (deviceId: string, newName: string) => Promise<void>;
  isLoading?: boolean;
  isRemoving?: boolean;
}

// ==================== Helper Functions ====================

/**
 * Get device icon based on type
 */
function getDeviceIcon(type: string): React.ReactNode {
  switch (type.toLowerCase()) {
    case 'mobile':
    case 'phone':
    case 'ios':
    case 'android':
      return <Smartphone className="w-5 h-5" />;
    case 'desktop':
    case 'windows':
    case 'macos':
    case 'linux':
      return <Monitor className="w-5 h-5" />;
    case 'web':
    case 'browser':
      return <Globe className="w-5 h-5" />;
    default:
      return <Monitor className="w-5 h-5" />;
  }
}

/**
 * Format last seen timestamp
 */
function formatLastSeen(dateStr: string | null): string {
  if (!dateStr) return 'unknown';
  
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min. ago`;
  if (hours < 24) return `${hours} hr. ago`;
  if (days < 7) return `${days} days ago`;
  return date.toLocaleDateString();
}

/**
 * Get relative time for verified status
 */
function formatVerifiedAt(dateStr: string | null): string | null {
  if (!dateStr) return null;
  
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const days = Math.floor(diff / 86400000);

  if (days < 1) return 'today';
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
  return date.toLocaleDateString();
}

// ==================== Component ====================

export function DeviceItem({
  device,
  onRemove,
  onRename,
  isLoading = false,
  isRemoving = false,
}: DeviceItemProps) {
  const [showConfirm, setShowConfirm] = React.useState(false);
  const [isEditing, setIsEditing] = React.useState(false);
  const [editName, setEditName] = React.useState(device.name);
  const [isSaving, setIsSaving] = React.useState(false);
  
  const isCurrentDevice = device.is_current;
  const isVerified = device.verified_at !== null;
  const verifiedText = formatVerifiedAt(device.verified_at);

  const handleRemoveClick = () => {
    setShowConfirm(true);
  };

  const handleConfirmRemove = async () => {
    if (onRemove && !isRemoving) {
      await onRemove(device.id);
      setShowConfirm(false);
    }
  };

  const handleCancelRemove = () => {
    setShowConfirm(false);
  };

  const handleEditClick = () => {
    setIsEditing(true);
    setEditName(device.name);
  };

  const handleSaveName = async () => {
    if (onRename && editName.trim() && editName !== device.name) {
      setIsSaving(true);
      try {
        await onRename(device.id, editName.trim());
        setIsEditing(false);
      } catch (error) {
        console.error('Failed to rename device:', error);
        setEditName(device.name); // Reset on error
      } finally {
        setIsSaving(false);
      }
    } else {
      setIsEditing(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      void handleSaveName();
    } else if (e.key === 'Escape') {
      setIsEditing(false);
      setEditName(device.name);
    }
  };

  // Determine styling based on current device status
  const containerClass = isCurrentDevice
    ? 'border-primary bg-primary/10'
    : 'border-border hover:bg-muted/50';

  const iconBgClass = isCurrentDevice
    ? 'bg-primary/20'
    : 'bg-muted';

  const iconTextClass = isCurrentDevice
    ? 'text-primary'
    : 'text-muted-foreground';

  return (
    <div
      className={`flex items-center gap-3 p-3 rounded-md border transition-colors ${containerClass}`}
    >
      {/* Device Icon */}
      <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${iconBgClass}`}>
        <span className={iconTextClass}>
          {getDeviceIcon(device.type)}
        </span>
      </div>

      {/* Device Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          {isEditing ? (
            <Input
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onBlur={handleSaveName}
              onKeyDown={handleKeyDown}
              disabled={isSaving}
              className="h-7 w-auto min-w-[120px] max-w-[200px] text-sm"
            />
          ) : (
            <h4 className="text-sm font-medium truncate">{device.name}</h4>
          )}
          
          {isCurrentDevice && (
            <Badge variant="secondary" className="text-xs bg-primary/20 text-primary shrink-0">
              Current
            </Badge>
          )}
          
          {isVerified ? (
            <Badge variant="secondary" className="text-xs bg-green-500/20 text-green-600 dark:text-green-400 shrink-0">
              <Check className="w-3 h-3 mr-1" />
              Verified
            </Badge>
          ) : (
            <Badge variant="secondary" className="text-xs bg-yellow-500/20 text-yellow-600 dark:text-yellow-400 shrink-0">
              <AlertTriangle className="w-3 h-3 mr-1" />
              Not verified
            </Badge>
          )}
        </div>
        
        <p className="text-xs text-muted-foreground truncate mt-0.5">
          Last active: {formatLastSeen(device.last_seen_at)}
          {verifiedText && isVerified && (
            <span className="ml-2 opacity-70">
              (verified {verifiedText})
            </span>
          )}
        </p>
      </div>

      {/* Actions */}
      {!isCurrentDevice && (
        <div className="shrink-0">
          {showConfirm ? (
            <div className="flex items-center gap-2">
              <Button
                variant="destructive"
                size="sm"
                onClick={handleConfirmRemove}
                disabled={isRemoving || isLoading}
              >
                {isRemoving ? 'Removing...' : 'Remove'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleCancelRemove}
                disabled={isRemoving || isLoading}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-1">
              {onRename && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleEditClick}
                  disabled={isLoading}
                  className="h-8 w-8 p-0"
                >
                  <Pencil className="w-4 h-4" />
                </Button>
              )}
              {onRemove && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleRemoveClick}
                  disabled={isLoading}
                  className="text-destructive hover:text-destructive hover:bg-destructive/10 h-8 w-8 p-0"
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default DeviceItem;