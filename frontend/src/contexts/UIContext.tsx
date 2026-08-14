/**
 * UIContext - UI state management
 * Thin wrapper around Zustand store for backward compatibility
 * All state is managed in @/stores/ui-store
 */

import type React from 'react';
import { createContext } from 'react';

import { useUIStore } from '@/stores';
import type { ThemeMode,UserSettings } from '@/types';

// ==================== Types ====================

export interface UIContextType {
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
  settings: UserSettings;
  updateSettings: (settings: UserSettings) => void;
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  contactsOpen: boolean;
  setContactsOpen: (open: boolean) => void;
}

// ==================== Context ====================

const _UIContext = createContext<UIContextType | null>(null);

// ==================== Provider ====================

export function UIProvider({ children }: { children: React.ReactNode }) {
  // All state is managed by Zustand - provider just wraps children
  return <>{children}</>;
}

// ==================== Hook ====================

export function useUI(): UIContextType {
  // Use Zustand selectors for performance
  const theme = useUIStore((state) => state.theme);
  const setTheme = useUIStore((state) => state.setTheme);
  const settings = useUIStore((state) => state.settings);
  const updateSettings = useUIStore((state) => state.updateSettings);
  const sidebarOpen = useUIStore((state) => state.sidebarOpen);
  const setSidebarOpen = useUIStore((state) => state.setSidebarOpen);
  const settingsOpen = useUIStore((state) => state.settingsOpen);
  const setSettingsOpen = useUIStore((state) => state.setSettingsOpen);
  const contactsOpen = useUIStore((state) => state.contactsOpen);
  const setContactsOpen = useUIStore((state) => state.setContactsOpen);
  
  return { 
    theme, 
    setTheme, 
    settings, 
    updateSettings, 
    sidebarOpen, 
    setSidebarOpen, 
    settingsOpen, 
    setSettingsOpen,
    contactsOpen,
    setContactsOpen 
  };
}
