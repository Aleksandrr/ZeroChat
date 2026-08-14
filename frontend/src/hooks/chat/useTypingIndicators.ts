/**
 * useTypingIndicators - Hook for managing typing indicators
 * Extracted from ChatContext.tsx
 */
import { useCallback, useEffect,useState } from 'react';

import type { TypingIndicatorPayload,TypingUser } from '@/types/chat';

const TYPING_TIMEOUT_MS = 5000;
const CLEANUP_INTERVAL_MS = 1000;

export function useTypingIndicators() {
  const [typingUsers, setTypingUsers] = useState<Record<string, TypingUser[]>>({});

  // Get typing users for a specific chat
  const getTypingUsers = useCallback((chatId: string): TypingUser[] => {
    return typingUsers[chatId] || [];
  }, [typingUsers]);

  // Handle incoming typing indicator
  const handleTypingIndicator = useCallback((data: TypingIndicatorPayload) => {
    const { chatId, userId, isTyping } = data;
    if (!chatId || !userId) return;

    setTypingUsers(prev => {
      const current = prev[chatId] || [];

      if (isTyping) {
        const existing = current.find(u => u.userId === userId);
        if (existing) {
          return {
            ...prev,
            [chatId]: current.map(u =>
              u.userId === userId ? { ...u, isTyping: true, timestamp: Date.now() } : u
            ),
          };
        }
        return {
          ...prev,
          [chatId]: [...current, { userId, isTyping: true, timestamp: Date.now() }],
        };
      } else {
        const filtered = current.filter(u => u.userId !== userId);
        if (filtered.length === 0) {
          const { [chatId]: _, ...rest } = prev;
          return rest;
        }
        return {
          ...prev,
          [chatId]: filtered,
        };
      }
    });
  }, []);

  // Auto-clear typing indicators after timeout
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setTypingUsers(prev => {
        let changed = false;
        const next = { ...prev };

        for (const chatId of Object.keys(next)) {
          const users = next[chatId];
          if (!users) continue;

          const active = users.filter(u => now - u.timestamp < TYPING_TIMEOUT_MS);
          if (active.length !== users.length) {
            if (active.length === 0) {
              delete next[chatId];
            } else {
              next[chatId] = active;
            }
            changed = true;
          }
        }

        return changed ? next : prev;
      });
    }, CLEANUP_INTERVAL_MS);

    return () => clearInterval(interval);
  }, []);

  return {
    typingUsers,
    getTypingUsers,
    handleTypingIndicator,
  };
}
