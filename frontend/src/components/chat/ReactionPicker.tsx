import { Smile } from 'lucide-react';
import { useState, useCallback } from 'react';
import * as Popover from '@radix-ui/react-popover';

import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { useChat } from '@/contexts';
import type { Message } from '@/types';

// Popular emojis for quick reactions (like Telegram)
export const QUICK_REACTIONS = [
  '👍', '❤️', '😂', '😮', '😢', '😡', 
  '🔥', '👏', '🎉', '🤔', '😍', '🙏',
  '💯', '✨', '💪', '🫠', '😭', '😘',
];

interface ReactionPickerProps {
  message: Message;
  children?: React.ReactNode;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'bottom' | 'left' | 'right';
}

export function ReactionPicker({
  message,
  children,
  align = 'center',
  side = 'top',
}: ReactionPickerProps) {
  const { user } = useAuth();
  const { reactToMessage } = useChat();
  
  // Get current user's reactions to this message
  const userReactions = new Set(
    (message.reactions || [])
      .filter(r => r.userId === user?.id)
      .map(r => r.emoji)
  );

  const handleReaction = useCallback(async (emoji: string) => {
    const isAdding = !userReactions.has(emoji);
    try {
      await reactToMessage(message.id, message.chatId, emoji, isAdding);
    } catch (error) {
      console.error('[ReactionPicker] Failed to react:', error);
    }
  }, [message.id, message.chatId, reactToMessage, userReactions]);

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        {children || (
          <button
            type="button"
            className={cn(
              'inline-flex items-center justify-center',
              'w-6 h-6 rounded-full',
              'hover:bg-muted/80 transition-colors',
              'text-muted-foreground hover:text-foreground'
            )}
            title="Реакции"
          >
            <Smile className="w-4 h-4" />
          </button>
        )}
      </Popover.Trigger>
      
      <Popover.Portal>
        <Popover.Content
          className={cn(
            'z-50 p-2 rounded-lg shadow-lg border bg-popover',
            'animate-in fade-in-0 zoom-in-95',
            'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
            'data-[side=bottom]:slide-in-from-top-2',
            'data-[side=top]:slide-in-from-bottom-2'
          )}
          align={align}
          side={side}
          sideOffset={5}
          collisionPadding={8}
        >
          <div className="flex flex-wrap gap-1 max-w-[280px]">
            {QUICK_REACTIONS.map((emoji) => {
              const isActive = userReactions.has(emoji);
              return (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => handleReaction(emoji)}
                  className={cn(
                    'inline-flex items-center justify-center',
                    'w-8 h-8 rounded-md text-lg',
                    'transition-all hover:scale-125',
                    isActive
                      ? 'bg-primary/20 ring-1 ring-primary'
                      : 'hover:bg-muted'
                  )}
                  title={isActive ? 'Убрать реакцию' : 'Добавить реакцию'}
                >
                  {emoji}
                </button>
              );
            })}
          </div>
          
          {/* Optional: Show current reaction counts */}
          <div className="mt-2 pt-2 border-t text-xs text-muted-foreground">
            {message.reactions && message.reactions.length > 0 ? (
              <div className="flex flex-wrap gap-1">
                {Array.from(
                  message.reactions.reduce((map, r) => {
                    const existing = map.get(r.emoji);
                    if (existing) {
                      map.set(r.emoji, existing + 1);
                    } else {
                      map.set(r.emoji, 1);
                    }
                    return map;
                  }, new Map<string, number>())
                ).map(([emoji, count]) => (
                  <span key={emoji} className="inline-flex items-center gap-0.5 px-1">
                    {emoji}
                    <span className="text-[10px]">{count}</span>
                  </span>
                ))}
              </div>
            ) : (
              <span className="text-center">Нет реакций</span>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
