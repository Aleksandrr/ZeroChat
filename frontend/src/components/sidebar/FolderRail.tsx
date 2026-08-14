/**
 * FolderRail - Vertical folder navigation panel (desktop Telegram style).
 *
 * Rendered as a narrow (~64px) column to the left of the main Sidebar on
 * desktop breakpoints only. Mobile uses a separate tabs UI (owned by
 * another agent) and does NOT mount FolderRail.
 *
 * Contents (top-to-bottom):
 *   1. "Все чаты" — `selectedFolderId = null`
 *   2. Divider
 *   3. List of folders from IndexedDB (first letter of name on a colored
 *      disc; active folder highlighted with a ring)
 *   4. Spacer
 *   5. "+" button — opens FolderManagementDialog
 *
 * Folder list reloading strategy (we do NOT touch `useChatWebSocket.ts`):
 *   - On mount: initial load via `getAllFolders()`.
 *   - Listen for `zerochat:folders-updated` custom window event
 *     (future-proof — currently no producer dispatches it, but the
 *     useChatWebSocket folder handlers may add this dispatch later).
 *   - Listen for `zerochat:sync-complete` (fired after multi-device sync;
 *     folder records are part of the synced state).
 *   - Poll `getAllFolders()` every 5 seconds as a robust fallback. The
 *     poll is shallow (only fetches the FOLDERS store, not messages) so
 *     it's cheap; it diff-compares the result by id+updatedAt and only
 *     triggers a re-render when something actually changed.
 *   - Reload when FolderManagementDialog closes (in case folders were
 *     created / renamed / deleted inside the dialog).
 *
 * Right-click on a folder button opens `FolderContextMenu` for rename /
 * delete actions.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { MessageCircle, Plus } from 'lucide-react';

import { FolderManagementDialog } from '@/components/settings/FolderManagementDialog';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { getAllFolders, type StoredFolder } from '@/lib/messages/db';
import { cn } from '@/lib/utils';
import { useFolderStore } from '@/stores/folder-store';

import { FolderContextMenu } from './FolderContextMenu';

const POLL_INTERVAL_MS = 5000;

interface ContextMenuState {
  folder: StoredFolder;
  x: number;
  y: number;
}

export function FolderRail() {
  const [folders, setFolders] = useState<StoredFolder[]>([]);
  const [manageOpen, setManageOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const selectedFolderId = useFolderStore((s) => s.selectedFolderId);
  const selectFolder = useFolderStore((s) => s.selectFolder);

  const load = useCallback(async () => {
    try {
      const list = await getAllFolders();
      // Sort by `order` ascending; getAllFolders already sorts, but be
      // defensive in case the underlying store ordering changes.
      list.sort((a, b) => a.order - b.order);
      setFolders(list);
    } catch (e) {
      console.error('[FolderRail] load failed:', e);
    }
  }, []);

  // Initial load + event subscriptions
  useEffect(() => {
    let cancelled = false;

    const safeLoad = () => {
      if (cancelled) return;
      void load();
    };

    void load();

    window.addEventListener('zerochat:folders-updated', safeLoad);
    window.addEventListener('zerochat:sync-complete', safeLoad);

    return () => {
      cancelled = true;
      window.removeEventListener('zerochat:folders-updated', safeLoad);
      window.removeEventListener('zerochat:sync-complete', safeLoad);
    };
  }, [load]);

  // Polling fallback — `useChatWebSocket.ts` may or may not dispatch the
  // custom event; polling guarantees we always reflect IndexedDB state.
  useEffect(() => {
    let cancelled = false;
    let lastSignature = '';

    const tick = async () => {
      if (cancelled) return;
      try {
        const list = await getAllFolders();
        list.sort((a, b) => a.order - b.order);
        // Build a signature so we only setState when something actually
        // changed — avoids re-rendering every 5s for no reason.
        const signature = list
          .map((f) => `${f.id}:${f.updatedAt ?? 0}`)
          .join('|');
        if (signature !== lastSignature) {
          lastSignature = signature;
          if (!cancelled) setFolders(list);
        }
      } catch (e) {
        console.error('[FolderRail] poll failed:', e);
      }
    };

    const id = window.setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  // Reload when the management dialog closes (folders may have been
  // created / renamed / deleted while it was open).
  useEffect(() => {
    if (!manageOpen) void load();
  }, [manageOpen, load]);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, folder: StoredFolder) => {
      e.preventDefault();
      setContextMenu({ folder, x: e.clientX, y: e.clientY });
    },
    []
  );

  // Memoize folder buttons so we don't re-render them on every poll tick
  // when the signature is unchanged.
  const folderButtons = useMemo(
    () =>
      folders.map((folder) => {
        const isActive = selectedFolderId === folder.id;
        const initial = folder.name.charAt(0).toUpperCase() || '?';
        // Inline style for the tinted background — `folder.color` is a
        // runtime value from IndexedDB, so we can't use a Tailwind class.
        const bgStyle = folder.color
          ? { backgroundColor: `${folder.color}30` }
          : undefined;
        return (
          <Tooltip key={folder.id}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => selectFolder(folder.id)}
                onContextMenu={(e) => handleContextMenu(e, folder)}
                aria-label={folder.name}
                aria-pressed={isActive}
                className={cn(
                  'w-12 h-12 rounded-full flex items-center justify-center transition-colors text-sm font-medium',
                  isActive
                    ? 'ring-2 ring-primary ring-offset-2 ring-offset-background text-foreground'
                    : 'hover:bg-accent text-foreground'
                )}
                style={bgStyle}
              >
                {initial}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">{folder.name}</TooltipContent>
          </Tooltip>
        );
      }),
    [folders, selectedFolderId, selectFolder, handleContextMenu]
  );

  return (
    <TooltipProvider delayDuration={300}>
      <div
        className="flex flex-col items-center gap-2 py-3 w-16 shrink-0 border-r bg-background/50"
        role="navigation"
        aria-label="Папки"
      >
        {/* All Chats — sets selectedFolderId to null */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => selectFolder(null)}
              aria-label="Все чаты"
              aria-pressed={selectedFolderId === null}
              className={cn(
                'w-12 h-12 rounded-full flex items-center justify-center transition-colors',
                selectedFolderId === null
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted hover:bg-accent text-foreground'
              )}
            >
              <MessageCircle className="h-5 w-5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">Все чаты</TooltipContent>
        </Tooltip>

        <div className="w-8 h-px bg-border my-1" />

        {/* Folders */}
        {folderButtons}

        <div className="flex-1" />

        {/* Add / manage folders */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => setManageOpen(true)}
              aria-label="Управление папками"
              className="w-12 h-12 rounded-full flex items-center justify-center bg-muted hover:bg-accent transition-colors text-foreground"
            >
              <Plus className="h-5 w-5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">Управление папками</TooltipContent>
        </Tooltip>
      </div>

      {contextMenu && (
        <FolderContextMenu
          folder={contextMenu.folder}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          onDeleted={() => {
            // Drop the deleted folder from local state immediately so
            // the UI feels responsive; the next poll will confirm.
            setFolders((prev) =>
              prev.filter((f) => f.id !== contextMenu.folder.id)
            );
            // If the deleted folder was selected, fall back to "All Chats".
            if (selectedFolderId === contextMenu.folder.id) {
              selectFolder(null);
            }
            // Reload from IndexedDB to pick up any cascade deletes.
            void load();
          }}
          onRename={() => {
            // Open the management dialog so the user can edit the folder
            // there. The dialog manages its own edit-mode state.
            setManageOpen(true);
          }}
        />
      )}

      <FolderManagementDialog open={manageOpen} onOpenChange={setManageOpen} />
    </TooltipProvider>
  );
}
