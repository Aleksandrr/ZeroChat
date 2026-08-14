import { useTheme as useNextTheme } from 'next-themes'
import { useEffect, useState } from 'react'

import { useBroadcastAction,useCrossTabEvent } from '@/lib/broadcast'
import { useUIStore } from '@/stores'

export type ThemeMode = 'light' | 'dark' | 'system'
export type ThemeIcon = 'light' | 'dark' | 'system' | 'sun' | 'moon'

export function useTheme() {
  const { theme: nextTheme, setTheme: setNextTheme, resolvedTheme, systemTheme } = useNextTheme()
  const zustandTheme = useUIStore((state) => state.theme)
  const setZustandTheme = useUIStore((state) => state.setTheme)
  const [mounted, setMounted] = useState(false)

  // Cross-tab sync for theme
  const { broadcastThemeChanged } = useBroadcastAction()

  // Listen for theme changes from other tabs
  useCrossTabEvent('theme:changed', (event) => {
    const newTheme = (event as any).theme as ThemeMode
    if (newTheme && mounted) {
      setZustandTheme(newTheme)
      setNextTheme(newTheme)
    }
  })

  // Sync Zustand with next-themes on mount
  useEffect(() => {
    setMounted(true)

    // Sync from Zustand to next-themes on mount
    if (zustandTheme && zustandTheme !== nextTheme) {
      setNextTheme(zustandTheme)
    }
  }, [])

  // Cycle through themes: light -> dark -> system -> light
  const cycleTheme = () => {
    const themes: ThemeMode[] = ['light', 'dark', 'system']
    const currentTheme = (zustandTheme || 'system') as ThemeMode
    const currentIndex = themes.indexOf(currentTheme)
    const nextIndex = (currentIndex + 1) % themes.length
    const newTheme = themes[nextIndex]

    // Update both stores (themes[nextIndex] is always defined due to modulo)
    if (newTheme) {
      setZustandTheme(newTheme)
      setNextTheme(newTheme)

      // Broadcast to other tabs
      broadcastThemeChanged(newTheme)
    }
  }

  // Set specific theme - syncs both Zustand and next-themes
  const setSpecificTheme = (newTheme: ThemeMode) => {
    setZustandTheme(newTheme)
    setNextTheme(newTheme)

    // Broadcast to other tabs
    broadcastThemeChanged(newTheme)
  }

  // Get current effective theme (resolves system theme)
  const getEffectiveTheme = (): 'light' | 'dark' => {
    const currentTheme = zustandTheme || 'system'
    if (currentTheme === 'system') {
      return (resolvedTheme || systemTheme || 'light') as 'light' | 'dark'
    }
    return currentTheme as 'light' | 'dark'
  }

  // Check if current theme is dark
  const isDark = getEffectiveTheme() === 'dark'

  // Get theme description for display
  const getThemeDescription = () => {
    const currentTheme = (zustandTheme || 'system') as ThemeMode
    const labels = {
      light: 'Светлая тема',
      dark: 'Тёмная тема',
      system: 'Системная тема'
    }

    if (currentTheme === 'system') {
      const effectiveTheme = getEffectiveTheme()
      return `${labels.system} (${effectiveTheme === 'dark' ? 'тёмная' : 'светлая'})`
    }
    return labels[currentTheme]
  }

  // Get theme icon name
  const getThemeIcon = () => {
    const currentTheme = (zustandTheme || 'system') as ThemeMode
    if (currentTheme === 'system') {
      return getEffectiveTheme() === 'dark' ? 'moon' : 'sun'
    }
    return currentTheme
  }

  return {
    theme: zustandTheme as ThemeMode,
    setTheme: setSpecificTheme,
    resolvedTheme,
    systemTheme,
    mounted,
    cycleTheme,
    isDark,
    getEffectiveTheme,
    getThemeDescription,
    getThemeIcon: getThemeIcon as () => ThemeIcon,
  }
}
