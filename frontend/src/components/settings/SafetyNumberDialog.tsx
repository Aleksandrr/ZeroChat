/**
 * SafetyNumberDialog — detailed safety number view for a single contact.
 *
 * Opened from SafetyNumbersPanel when the user taps a contact row. Shows:
 *   - The full 60-digit safety number (mono, wrap-all)
 *   - A QR-code placeholder (real QR pending a library choice)
 *   - Copy-to-clipboard button
 *   - "Подтвердить" button → marks the contact as verified (local TOFU state)
 *   - When status === 'changed' → warning block + "Подтвердить новый ключ"
 *     button (calls acceptChangedIdentity to re-seed the TOFU state)
 *
 * No mandatory verification — the dialog is purely informational.
 */

import {
  AlertTriangle,
  Check,
  Copy,
  RotateCw,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import { useEffect, useState } from 'react';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  acceptChangedIdentity,
  formatSafetyNumberFull,
  markContactVerified,
  type SafetyNumberStatus,
} from '@/lib/signal/safety-number';

export interface SafetyNumberEntry {
  userId: string;
  username: string;
  displayName?: string;
  avatar?: string;
  /** 60-digit displayable safety number, or undefined if not yet computable. */
  safetyNumber?: string;
  /** Current TOFU status for this contact. */
  status: SafetyNumberStatus;
  /** Base64 identity pubkey from the server (for acceptChangedIdentity). */
  identityPubBase64?: string;
}

interface SafetyNumberDialogProps {
  entry: SafetyNumberEntry;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called when the user marks the contact as verified / accepts a change. */
  onStatusChange?: (newStatus: SafetyNumberStatus) => void;
}

export function SafetyNumberDialog({
  entry,
  open,
  onOpenChange,
  onStatusChange,
}: SafetyNumberDialogProps) {
  const [copied, setCopied] = useState(false);
  const [currentStatus, setCurrentStatus] = useState<SafetyNumberStatus>(entry.status);

  // Sync local status when entry changes (e.g. dialog reopened for a different contact).
  useEffect(() => {
    setCurrentStatus(entry.status);
  }, [entry.userId, entry.status]);

  const handleCopy = async () => {
    if (!entry.safetyNumber) return;
    try {
      await navigator.clipboard.writeText(formatSafetyNumberFull(entry.safetyNumber));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API may be unavailable (insecure context). Best-effort.
    }
  };

  const handleMarkVerified = () => {
    markContactVerified(entry.userId);
    setCurrentStatus('verified');
    onStatusChange?.('verified');
  };

  const handleAcceptChangedKey = () => {
    if (!entry.identityPubBase64) return;
    const newStatus = acceptChangedIdentity(entry.userId, entry.identityPubBase64);
    setCurrentStatus(newStatus);
    onStatusChange?.(newStatus);
  };

  const isChanged = currentStatus === 'changed';
  const isVerified = currentStatus === 'verified';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Safety number</DialogTitle>
          <DialogDescription>
            Сравните этот код с собеседником другим каналом (лично, по телефону),
            чтобы убедиться, что переписка не перехвачена.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Contact header */}
          <div className="flex items-center gap-3">
            <Avatar className="h-12 w-12">
              <AvatarImage src={entry.avatar} alt={entry.username} />
              <AvatarFallback>{entry.username.charAt(0).toUpperCase()}</AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <p className="font-medium truncate">{entry.displayName || entry.username}</p>
              <p className="text-xs text-muted-foreground truncate">@{entry.username}</p>
            </div>
          </div>

          {entry.safetyNumber ? (
            <>
              {/* Full safety number */}
              <div className="bg-muted rounded-lg p-4 font-mono text-sm break-all text-center tracking-wide select-all">
                {formatSafetyNumberFull(entry.safetyNumber)}
              </div>

              {/* QR placeholder — replaced when a QR library is wired up */}
              <div className="bg-white border rounded-lg p-4 flex items-center justify-center h-32">
                <p className="text-xs text-muted-foreground text-center">
                  QR-код появится здесь
                  <br />
                  (пока копируйте код вручную)
                </p>
              </div>

              {/* Action buttons */}
              <div className="flex gap-2">
                <Button variant="outline" className="flex-1" onClick={handleCopy}>
                  {copied ? <Check className="h-4 w-4 mr-2" /> : <Copy className="h-4 w-4 mr-2" />}
                  {copied ? 'Скопировано' : 'Копировать'}
                </Button>
                {!isVerified && !isChanged && (
                  <Button className="flex-1" onClick={handleMarkVerified}>
                    <ShieldCheck className="h-4 w-4 mr-2" />
                    Подтвердить
                  </Button>
                )}
                {isChanged && (
                  <Button className="flex-1" onClick={handleAcceptChangedKey}>
                    <RotateCw className="h-4 w-4 mr-2" />
                    Подтвердить новый ключ
                  </Button>
                )}
              </div>

              {/* Verified badge */}
              {isVerified && (
                <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
                  <ShieldCheck className="h-4 w-4" />
                  Контакт подтверждён
                </div>
              )}

              {/* Identity-changed warning */}
              {isChanged && (
                <div className="flex items-start gap-2 text-sm text-yellow-700 dark:text-yellow-400 bg-yellow-50 dark:bg-yellow-950/30 p-2 rounded">
                  <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" />
                  <span>
                    Ключ собеседника изменился. Возможно, устройство сменилось или
                    переписка перехвачена. Сравните safety number другим каналом,
                    прежде чем доверять новому ключу.
                  </span>
                </div>
              )}
            </>
          ) : (
            <div className="text-center py-4 space-y-1">
              <AlertTriangle className="h-8 w-8 mx-auto text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                Нет сохранённого ключа для этого контакта.
              </p>
              <p className="text-xs text-muted-foreground">
                Откройте чат и отправьте/получите первое сообщение, чтобы ключ
                появился на сервере.
              </p>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
