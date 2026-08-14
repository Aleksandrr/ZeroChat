// frontend/src/stores/ui-store.ts
import { create } from 'zustand';
import { createJSONStorage,persist } from 'zustand/middleware';

import type { ThemeMode,UserSettings } from '@/types';

interface UIState {
  // Theme
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
  
  // User Settings (full settings object)
  settings: UserSettings;
  updateSettings: (settings: UserSettings) => void;
  
  // Sidebar
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  
  // Settings Dialog
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  
  // Contacts Modal
  contactsOpen: boolean;
  setContactsOpen: (open: boolean) => void;
  
  // Mobile
  isMobile: boolean;
  setIsMobile: (isMobile: boolean) => void;
}

const defaultSettings: UserSettings = {
  theme: 'system',
  notifications: true,
  sound: true,
  showOnlineStatus: true,
  readReceipts: true,
  autoSaveMedia: true,
};

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      theme: 'system',
      settings: defaultSettings,
      sidebarOpen: true,
      settingsOpen: false,
      contactsOpen: false,
      isMobile: false,
      
      setTheme: (theme) => set((state) => ({ 
        theme,
        settings: { ...state.settings, theme }
      })),
      
      updateSettings: (settings) => set({ 
        settings,
        theme: settings.theme 
      }),
      
      setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
      toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
      setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
      setContactsOpen: (contactsOpen) => set({ contactsOpen }),
      setIsMobile: (isMobile) => set({ isMobile }),
    }),
    {
      name: 'zerochat-ui',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ 
        theme: state.theme, 
        sidebarOpen: state.sidebarOpen,
        settings: state.settings,
      }),
    }
  )
);
