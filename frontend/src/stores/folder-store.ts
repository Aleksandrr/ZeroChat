/**
 * folder-store - Zustand store for the currently selected chat folder.
 *
 * The selected folder ID is used by ChatList to filter chats and by
 * FolderRail to highlight the active folder button.
 *
 * `null` means "All Chats" (no filter). Any other string is a folder ID
 * from IndexedDB (StoredFolder.id).
 *
 * Persisted to localStorage so the user's last folder choice survives
 * page reloads — matches desktop Telegram behavior.
 */
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

interface FolderState {
  /** Currently selected folder ID. `null` = "All Chats". */
  selectedFolderId: string | null;
  selectFolder: (folderId: string | null) => void;
}

export const useFolderStore = create<FolderState>()(
  persist(
    (set) => ({
      selectedFolderId: null,
      selectFolder: (folderId) => set({ selectedFolderId: folderId }),
    }),
    {
      name: 'zerochat-folder-selection',
      storage: createJSONStorage(() => localStorage),
    }
  )
);
