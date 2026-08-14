/**
 * SafetyNumbersPanel — list of private-chat contacts with their safety numbers.
 *
 * Mounted inside the SettingsDialog → "Безопасность" tab. For each 1:1 chat:
 *   - Fetches the remote user's identity pubkey from the server
 *     (`chatService.getRemoteIdentityKey`)
 *   - Computes the 60-digit safety number via `signal.generateSafetyNumber`
 *   - Derives the TOFU status via `recordIdentitySighting`
 *   - Renders a compact row with the short safety number + status icon
 *
 * Clicking a row opens `SafetyNumberDialog` with the full number + actions.
 *
 * No mandatory verification — TOFU by default. The panel is read-only from
 * the user's perspective: opening it never blocks messaging.
 */

import { ChevronRight, RefreshCw, Shield, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useAuth } from '@/contexts/AuthContext';
import { useChat } from '@/contexts/ChatContext';
import { useSignal } from '@/contexts/SignalContext';
import { base64ToUint8Array } from '@/lib/utils/buffer';
import * as signal from '@/lib/signal';
import {
  formatSafetyNumberShort,
  recordIdentitySighting,
  type SafetyNumberStatus,
} from '@/lib/signal/safety-number';
import { chatService } from '@/services/chat';

import { SafetyNumberDialog, type SafetyNumberEntry } from './SafetyNumberDialog';

interface PanelEntry extends SafetyNumberEntry {
  chatId: string;
}

export function SafetyNumbersPanel() {
  const { chats } = useChat();
  const { user } = useAuth();
  const signalCtx = useSignal();
  const [entries, setEntries] = useState<PanelEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<PanelEntry | null>(null);

  const currentUserId = user?.id ?? '';

  const buildEntries = useCallback(async (): Promise<PanelEntry[]> => {
    if (!currentUserId) return [];
    if (!signalCtx.isInitialized) return [];

    const privateChats = chats.filter(
      (c) => c.type === 'private' && !c.isVirtual && c.participants.length >= 1,
    );

    const results = await Promise.all(
      privateChats.map(async (chat): Promise<PanelEntry | null> => {
        const other = chat.participants.find((p) => p.id !== currentUserId);
        if (!other) return null;

        try {
          const identityPubBase64 = await chatService.getRemoteIdentityKey(other.id);
          if (!identityPubBase64) {
            return {
              chatId: chat.id,
              userId: other.id,
              username: other.username,
              displayName: other.displayName,
              avatar: other.avatar,
              safetyNumber: undefined,
              status: 'unknown' as SafetyNumberStatus,
              identityPubBase64: undefined,
            };
          }

          let identityKeyBytes: Uint8Array;
          try {
            identityKeyBytes = base64ToUint8Array(identityPubBase64);
          } catch {
            return {
              chatId: chat.id,
              userId: other.id,
              username: other.username,
              displayName: other.displayName,
              avatar: other.avatar,
              safetyNumber: undefined,
              status: 'unknown' as SafetyNumberStatus,
              identityPubBase64,
            };
          }

          let safetyNumber: string | undefined;
          try {
            safetyNumber = await signal.generateSafetyNumber(undefined, other.id, identityKeyBytes);
          } catch (e) {
            console.error('[SafetyNumbersPanel] generateSafetyNumber failed for', other.id, e);
          }

          // Update TOFU state (records the sighting on first contact, returns
          // 'verified' | 'unverified' | 'changed'). We deliberately call this
          // even if generateSafetyNumber failed — we still want to record the
          // identity sighting so a future change can be detected.
          const status = recordIdentitySighting(other.id, identityPubBase64);

          return {
            chatId: chat.id,
            userId: other.id,
            username: other.username,
            displayName: other.displayName,
            avatar: other.avatar,
            safetyNumber,
            status,
            identityPubBase64,
          };
        } catch (e) {
          console.error('[SafetyNumbersPanel] failed for', other.id, e);
          return null;
        }
      }),
    );

    return results.filter((r): r is PanelEntry => r !== null);
  }, [chats, currentUserId, signalCtx.isInitialized]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const built = await buildEntries();
      if (!cancelled) {
        setEntries(built);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [buildEntries]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const built = await buildEntries();
      setEntries(built);
    } finally {
      setRefreshing(false);
    }
  }, [buildEntries]);

  const handleStatusChange = useCallback(
    (userId: string, newStatus: SafetyNumberStatus) => {
      setEntries((prev) =>
        prev.map((e) => (e.userId === userId ? { ...e, status: newStatus } : e)),
      );
      setSelected((prev) => (prev && prev.userId === userId ? { ...prev, status: newStatus } : prev));
    },
    [],
  );

  // ---- Render states --------------------------------------------------------

  if (!signalCtx.isInitialized) {
    return (
      <div className="py-8 text-center text-muted-foreground">
        <Shield className="h-10 w-10 mx-auto mb-2 opacity-50" />
        <p>Signal Protocol ещё не инициализирован</p>
        <p className="text-xs mt-1">
          Откройте чат или подождите несколько секунд — ключи загружаются автоматически.
        </p>
      </div>
    );
  }

  if (loading) {
    return <div className="py-8 text-center text-muted-foreground">Загрузка...</div>;
  }

  if (entries.length === 0) {
    return (
      <div className="py-8 text-center text-muted-foreground">
        <Shield className="h-10 w-10 mx-auto mb-2 opacity-50" />
        <p>Нет контактов для верификации</p>
        <p className="text-xs mt-1">
          Начните чат с кем-нибудь, чтобы увидеть safety number.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-1">
        <p className="text-xs text-muted-foreground mb-2">
          Safety number — уникальный код для каждого контакта. Сравните его с
          собеседником другим каналом (лично, по телефону), чтобы убедиться, что
          переписка не перехвачена.
        </p>

        <div className="flex items-center justify-between mb-1">
          <span className="text-xs text-muted-foreground">
            {entries.length}{' '}
            {entries.length === 1 ? 'контакт' : entries.length < 5 ? 'контакта' : 'контактов'}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleRefresh}
            disabled={refreshing}
            className="h-7 px-2 text-xs"
          >
            <RefreshCw className={`h-3 w-3 mr-1 ${refreshing ? 'animate-spin' : ''}`} />
            Обновить
          </Button>
        </div>

        <ScrollArea className="h-[300px] rounded-md border">
          <div className="divide-y">
            {entries.map((entry) => (
              <button
                key={entry.userId}
                onClick={() => setSelected(entry)}
                className="w-full flex items-center gap-3 p-3 hover:bg-accent transition-colors text-left"
              >
                <Avatar className="h-9 w-9 shrink-0">
                  <AvatarImage src={entry.avatar} alt={entry.username} />
                  <AvatarFallback>
                    {entry.username.charAt(0).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">
                    {entry.displayName || entry.username}
                  </p>
                  <p className="text-xs text-muted-foreground truncate font-mono">
                    {entry.safetyNumber
                      ? formatSafetyNumberShort(entry.safetyNumber)
                      : 'Нет ключа — откройте чат'}
                  </p>
                </div>
                {entry.status === 'verified' && (
                  <ShieldCheck className="h-4 w-4 text-green-500 shrink-0" />
                )}
                {entry.status === 'changed' && (
                  <ShieldAlert className="h-4 w-4 text-yellow-500 shrink-0" />
                )}
                {(entry.status === 'unverified' || entry.status === 'unknown') && (
                  <Shield className="h-4 w-4 text-muted-foreground shrink-0" />
                )}
                <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
              </button>
            ))}
          </div>
        </ScrollArea>
      </div>

      {selected && (
        <SafetyNumberDialog
          entry={selected}
          open={!!selected}
          onOpenChange={(open) => !open && setSelected(null)}
          onStatusChange={(newStatus) => handleStatusChange(selected.userId, newStatus)}
        />
      )}
    </>
  );
}
