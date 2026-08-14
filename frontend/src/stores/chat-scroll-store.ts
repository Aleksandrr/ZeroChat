import { create } from 'zustand';

/**
 * State for chat scroll positions
 */
interface ChatScrollState {
  // Map of chatId -> scroll position (scrollTop)
  scrollPositions: Record<string, number>;
  
  // Map of chatId -> last read message timestamp
  lastReadTimestamps: Record<string, number>;
  
  // Set of chats that have been viewed at least once
  viewedChats: Set<string>;
  
  // Actions
  setScrollPosition: (chatId: string, position: number) => void;
  getScrollPosition: (chatId: string) => number;
  
  setLastReadTimestamp: (chatId: string, timestamp: number) => void;
  getLastReadTimestamp: (chatId: string) => number | null;
  
  markChatViewed: (chatId: string) => void;
  hasChatBeenViewed: (chatId: string) => boolean;
  
  clearChatState: (chatId: string) => void;
}

export const useChatScrollStore = create<ChatScrollState>((set, get) => ({
  scrollPositions: {},
  lastReadTimestamps: {},
  viewedChats: new Set<string>(),
  
  setScrollPosition: (chatId: string, position: number) => {
    set((state) => ({
      scrollPositions: {
        ...state.scrollPositions,
        [chatId]: position,
      },
    }));
  },
  
  getScrollPosition: (chatId: string) => {
    return get().scrollPositions[chatId] || 0;
  },
  
  setLastReadTimestamp: (chatId: string, timestamp: number) => {
    set((state) => ({
      lastReadTimestamps: {
        ...state.lastReadTimestamps,
        [chatId]: timestamp,
      },
    }));
  },
  
  getLastReadTimestamp: (chatId: string) => {
    return get().lastReadTimestamps[chatId] || null;
  },
  
  markChatViewed: (chatId: string) => {
    set((state) => {
      const newViewedChats = new Set(state.viewedChats);
      newViewedChats.add(chatId);
      return { viewedChats: newViewedChats };
    });
  },
  
  hasChatBeenViewed: (chatId: string) => {
    return get().viewedChats.has(chatId);
  },
  
  clearChatState: (chatId: string) => {
    set((state) => {
      const { [chatId]: scrollPos, ...restPositions } = state.scrollPositions;
      const { [chatId]: lastRead, ...restTimestamps } = state.lastReadTimestamps;
      const newViewedChats = new Set(state.viewedChats);
      newViewedChats.delete(chatId);
      
      return {
        scrollPositions: restPositions,
        lastReadTimestamps: restTimestamps,
        viewedChats: newViewedChats,
      };
    });
  },
}));
