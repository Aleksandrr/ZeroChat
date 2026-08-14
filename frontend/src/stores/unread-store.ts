// frontend/src/stores/unread-store.ts
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

/**
 * UnreadStore - Zustand store for managing unread message counts
 * 
 * Extracted from ChatContext to avoid unnecessary re-renders
 * when the entire chats array is recreated on each incoming message.
 * 
 * This store only tracks unread counts as a simple Record<chatId, count>,
 * allowing ChatList to subscribe to specific counts without re-rendering
 * the entire chat list when other chat properties change.
 */

interface UnreadState {
  // Record of chatId -> unread count
  unreadCounts: Record<string, number>;
  
  // Set unread count for a specific chat
  setUnreadCount: (chatId: string, count: number) => void;
  
  // Reset unread count to 0 for a specific chat
  resetUnreadCount: (chatId: string) => void;
  
  // Get unread count for a specific chat
  getUnreadCount: (chatId: string) => number;
  
  // Set all unread counts at once (for initial load)
  setAllUnreadCounts: (counts: Record<string, number>) => void;
  
  // Clear all unread counts (for logout)
  clear: () => void;
}

export const useUnreadStore = create<UnreadState>()((set, get) => ({
  unreadCounts: {},
  
  setUnreadCount: (chatId: string, count: number) => {console.log("[unread-store] setUnreadCount: chatId=", chatId, "count=", count);
    set((state) => ({
      unreadCounts: {
        ...state.unreadCounts,
        [chatId]: count,
      },
    }));
  },
  
  resetUnreadCount: (chatId: string) => {
    set((state) => ({
      unreadCounts: {
        ...state.unreadCounts,
        [chatId]: 0,
      },
    }));
  },
  
  getUnreadCount: (chatId: string) => {
    return get().unreadCounts[chatId] ?? 0;
  },
  
  setAllUnreadCounts: (counts: Record<string, number>) => {
    set({ unreadCounts: counts });
  },
  
  clear: () => {
    set({ unreadCounts: {} });
  },
}));

// Selector for a specific chat's unread count
// Use this in components to avoid re-rendering when other counts change
export const useUnreadCount = (chatId: string): number => {
  return useUnreadStore((state) => state.unreadCounts[chatId] ?? 0);
};

// Selector for multiple chat IDs at once
// Useful for ChatList to get all counts it needs to render
// Use useShallow to prevent infinite loop in Zustand v5
export const useUnreadCounts = (chatIds: string[]): Record<string, number> => {
  return useUnreadStore(
    useShallow((state) => {
      const result: Record<string, number> = {};
      for (const chatId of chatIds) {
        if (state.unreadCounts[chatId] !== undefined) {
          result[chatId] = state.unreadCounts[chatId];
        }
      }
      return result;
    })
  );
};

