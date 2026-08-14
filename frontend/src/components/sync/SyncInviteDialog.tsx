/**
 * SyncInviteDialog
 * 
 * Dialog shown on existing devices when a new device requests sync.
 * Allows user to accept or reject the sync request.
 */

import { Download, Loader2, Smartphone, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export interface SyncInviteData {
  invitingDeviceId: string;
  invitingDeviceName: string;
  timestamp: number;
}

interface SyncInviteDialogProps {
  open: boolean;
  invite: SyncInviteData | null;
  onAccept: () => void;
  onReject: () => void;
  onDismiss: () => void;
  isProcessing?: boolean;
}

export function SyncInviteDialog({
  open,
  invite,
  onAccept,
  onReject,
  onDismiss,
  isProcessing = false,
}: SyncInviteDialogProps) {
  if (!invite) return null;

  const deviceName = invite.invitingDeviceName || 'New Device';
  const timeAgo = getTimeAgo(invite.timestamp);

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onDismiss()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Smartphone className="h-5 w-5" />
            Sync Request
          </DialogTitle>
          <DialogDescription>
            A new device wants to sync your message history
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          <div className="flex items-center gap-3 p-3 bg-muted rounded-lg">
            <div className="flex-shrink-0 w-10 h-10 bg-primary/10 rounded-full flex items-center justify-center">
              <Smartphone className="h-5 w-5 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-medium truncate">{deviceName}</p>
              <p className="text-sm text-muted-foreground">
                Requested {timeAgo}
              </p>
            </div>
          </div>

          <p className="mt-4 text-sm text-muted-foreground">
            If you allow this, your message history will be securely transferred
            to the new device using end-to-end encryption.
          </p>
        </div>

        <DialogFooter className="flex-col sm:flex-row gap-2">
          <Button
            variant="ghost"
            onClick={onDismiss}
            disabled={isProcessing}
            className="sm:order-1"
          >
            Not Now
          </Button>
          <div className="flex gap-2 sm:order-2">
            <Button
              variant="outline"
              onClick={onReject}
              disabled={isProcessing}
            >
              <X className="h-4 w-4 mr-2" />
              Reject
            </Button>
            <Button
              onClick={onAccept}
              disabled={isProcessing}
            >
              {isProcessing ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Download className="h-4 w-4 mr-2" />
              )}
              Allow
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Get human-readable time ago string
 */
function getTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  
  if (seconds < 60) {
    return 'just now';
  }
  
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
  }
  
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} hour${hours > 1 ? 's' : ''} ago`;
  }
  
  const days = Math.floor(hours / 24);
  return `${days} day${days > 1 ? 's' : ''} ago`;
}

export default SyncInviteDialog;
