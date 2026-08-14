// frontend/src/stores/draft-store.ts
import { create } from 'zustand';
import { createJSONStorage,persist } from 'zustand/middleware';

interface DraftState {
  drafts: Record<string, string>; // chatId -> message draft
  setDraft: (chatId: string, content: string) => void;
  getDraft: (chatId: string) => string;
  clearDraft: (chatId: string) => void;
}

export const useDraftStore = create<DraftState>()(
  persist(
    (set, get) => ({
      drafts: {},
      
      setDraft: (chatId, content) => set((state) => ({
        drafts: { ...state.drafts, [chatId]: content }
      })),
      
      getDraft: (chatId) => get().drafts[chatId] || '',
      
      clearDraft: (chatId) => set((state) => {
        const { [chatId]: _, ...rest } = state.drafts;
        return { drafts: rest };
      }),
    }),
    {
      name: 'zerochat-drafts',
      storage: createJSONStorage(() => localStorage),
    }
  )
);
