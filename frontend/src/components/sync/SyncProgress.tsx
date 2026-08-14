/**
 * SyncProgress
 * 
 * Shows sync progress on the new device (receiving history)
 * and on the donor device (sending history).
 */

import { 
  CheckCircle2, 
  Clock,
  Download,
  Loader2, 
  RefreshCw,
  Smartphone,
  Upload,
  Users,
  XCircle} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import type { SyncStatus } from '@/lib/sync';

interface SyncProgressProps {
  status: SyncStatus;
  onRetry?: () => void;
  onDismiss?: () => void;
  isDonor?: boolean; // true if this device is sending history
  donorDeviceName?: string;
}

export function SyncProgress({ 
  status, 
  onRetry,
  onDismiss,
  isDonor = false,
  donorDeviceName
}: SyncProgressProps) {
  const {
    isSyncing: _isSyncing,
    invitePhase,
    transferPhase,
    transferProgress,
    error,
    donorDeviceName: statusDonorName
  } = status;

  const displayDonorName = donorDeviceName || statusDonorName || 'Device';

  // Don't render if idle
  if (invitePhase === 'idle' && transferPhase === 'idle' && !error) {
    return null;
  }

  // Get status icon and text based on current state
  const getStatusContent = () => {
    // Invite phase states
    if (invitePhase === 'inviting') {
      return {
        icon: <Loader2 className="h-5 w-5 animate-spin text-primary" />,
        title: 'Searching for devices...',
        description: 'Looking for other devices to sync from',
        progress: undefined
      };
    }

    if (invitePhase === 'waiting') {
      return {
        icon: <Clock className="h-5 w-5 text-yellow-500" />,
        title: 'Waiting for approval...',
        description: 'Please approve the sync on one of your other devices',
        progress: undefined
      };
    }

    if (invitePhase === 'accepted') {
      return {
        icon: <Users className="h-5 w-5 text-green-500" />,
        title: `Connected to ${displayDonorName}`,
        description: 'Starting transfer...',
        progress: undefined
      };
    }

    if (invitePhase === 'no_devices') {
      return {
        icon: <XCircle className="h-5 w-5 text-red-500" />,
        title: 'No devices available',
        description: 'No other devices are online. Try again when another device is connected.',
        progress: undefined,
        showRetry: true
      };
    }

    if (invitePhase === 'timeout') {
      return {
        icon: <XCircle className="h-5 w-5 text-red-500" />,
        title: 'Request timed out',
        description: 'No device responded within 30 seconds. Please try again.',
        progress: undefined,
        showRetry: true
      };
    }

    if (invitePhase === 'rejected') {
      return {
        icon: <XCircle className="h-5 w-5 text-red-500" />,
        title: 'Request rejected',
        description: 'The sync request was rejected. Please try again.',
        progress: undefined,
        showRetry: true
      };
    }

    // Transfer phase states
    if (transferPhase === 'preparing') {
      return {
        icon: <Loader2 className="h-5 w-5 animate-spin text-primary" />,
        title: isDonor ? 'Preparing history...' : 'Preparing to receive...',
        description: isDonor 
          ? 'Collecting and encrypting your messages'
          : 'Getting ready to receive history',
        progress: undefined
      };
    }

    if (transferPhase === 'sending') {
      return {
        icon: <Upload className="h-5 w-5 text-primary" />,
        title: 'Sending history...',
        description: `Transferring to ${displayDonorName}`,
        progress: transferProgress
      };
    }

    if (transferPhase === 'receiving') {
      return {
        icon: <Download className="h-5 w-5 text-primary" />,
        title: 'Receiving history...',
        description: `Loading messages from ${displayDonorName}`,
        progress: transferProgress
      };
    }

    if (transferPhase === 'done') {
      return {
        icon: <CheckCircle2 className="h-5 w-5 text-green-500" />,
        title: 'Sync complete!',
        description: 'Your messages have been synchronized',
        progress: { current: 100, total: 100 }
      };
    }

    if (transferPhase === 'error' || error) {
      return {
        icon: <XCircle className="h-5 w-5 text-red-500" />,
        title: 'Sync failed',
        description: error || 'An error occurred during sync',
        progress: undefined,
        showRetry: true
      };
    }

    return null;
  };

  const content = getStatusContent();
  if (!content) return null;

  const progressPercent = content.progress
    ? Math.round((content.progress.current / content.progress.total) * 100)
    : 0;

  return (
    <Card className="w-full">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Smartphone className="h-4 w-4" />
          Device Sync
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-start gap-3">
          {content.icon}
          <div className="flex-1 min-w-0">
            <p className="font-medium text-sm">{content.title}</p>
            <p className="text-xs text-muted-foreground">{content.description}</p>
          </div>
        </div>

        {content.progress && (
          <div className="space-y-1">
            <Progress value={progressPercent} className="h-2" />
            <p className="text-xs text-muted-foreground text-right">
              {content.progress.current} / {content.progress.total} messages
            </p>
          </div>
        )}

        {content.showRetry && onRetry && (
          <Button
            variant="outline"
            size="sm"
            onClick={onRetry}
            className="w-full"
          >
            <RefreshCw className="h-4 w-4 mr-2" />
            Retry Sync
          </Button>
        )}

        {content.showRetry && onDismiss && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onDismiss}
            className="w-full"
          >
            Dismiss
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

export default SyncProgress;
