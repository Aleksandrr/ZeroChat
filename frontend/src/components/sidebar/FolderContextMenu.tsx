/**
 * FolderContextMenu - Lightweight right-click context menu for a folder
 * button in FolderRail.
 *
 * Provides two actions:
 * - "Переименовать" (Rename) — opens the FolderManagementDialog in edit
 *   mode. Currently a TODO stub: the dialog only supports edit mode via
 *   its own internal state, so the right-click menu forwards to the
 *   full management dialog.
 * - "Удалить" (Delete) — calls `deleteFolderFromDb` to remove the folder
 *   locally; the parent (`FolderRail`) is responsible for any server
 *   sync via `useChat().deleteFolder` if needed.
 *
 * Closes on outside-click, Escape, or after an action is performed.
 * Position is clamped to the viewport.
 */
import { useEffect, useRef } from 'react';
import { Pencil, Trash2 } from 'lucide-react';

import type { StoredFolder } from '@/lib/messages/db';
import { deleteFolderFromDb } from '@/lib/messages/db';

interface FolderContextMenuProps {
  folder: StoredFolder;
  x: number;
  y: number;
  onClose: () => void;
  onDeleted: () => void;
  onRename?: (folder: StoredFolder) => void;
}

export function FolderContextMenu({
  folder,
  x,
  y,
  onClose,
  onDeleted,
  onRename,
}: FolderContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside-click or Escape
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [onClose]);

  const handleRename = () => {
    if (onRename) onRename(folder);
    onClose();
  };

  const handleDelete = async () => {
    // NOTE: uses native confirm() for simplicity. If a project-wide
    // AlertDialog-based confirm pattern exists, swap this out.
    const ok = window.confirm(
      `Удалить папку "${folder.name}"? Чаты не будут удалены.`
    );
    if (!ok) {
      onClose();
      return;
    }
    try {
      await deleteFolderFromDb(folder.id);
      onDeleted();
    } catch (e) {
      console.error('[FolderContextMenu] delete failed:', e);
    }
    onClose();
  };

  // Clamp to viewport so the menu never overflows the right/bottom edge.
  const MENU_WIDTH = 200;
  const MENU_HEIGHT = 100;
  const left = Math.min(x, window.innerWidth - MENU_WIDTH);
  const top = Math.min(y, window.innerHeight - MENU_HEIGHT);

  return (
    <div
      ref={ref}
      className="fixed z-50 min-w-[160px] py-1 bg-popover border rounded-md shadow-md text-popover-foreground"
      style={{ left, top }}
      role="menu"
    >
      <button
        type="button"
        onClick={handleRename}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent text-left"
        role="menuitem"
      >
        <Pencil className="h-4 w-4" />
        <span>Переименовать</span>
      </button>
      <button
        type="button"
        onClick={() => void handleDelete()}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent text-left text-destructive"
        role="menuitem"
      >
        <Trash2 className="h-4 w-4" />
        <span>Удалить</span>
      </button>
    </div>
  );
}
