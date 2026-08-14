import { X } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { Chat } from '@/types';

interface ForwardDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  messageData: {
    messageId: string;
    chatId: string;
    content: string;
    attachments?: any[];
    senderName: string;
  };
  availableChats: Chat[];
  onSend: (chat: Chat) => void;
}

export function ForwardDialog({
  open,
  onOpenChange,
  messageData,
  availableChats,
  onSend,
}: ForwardDialogProps) {
  const [searchQuery, setSearchQuery] = useState('');

  const filteredChats = availableChats.filter(chat =>
    chat.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    chat.participants.some(p => p.username.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  const handleSend = (chat: Chat) => {
    onSend(chat);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Переслать сообщение</DialogTitle>
        </DialogHeader>
        
        {/* Message preview */}
        <div className="p-3 rounded-lg bg-muted/50 border mb-3">
          <p className="text-xs text-muted-foreground mb-1">
            От: {messageData.senderName}
          </p>
          <p className="text-sm line-clamp-3">{messageData.content}</p>
          {messageData.attachments && messageData.attachments.length > 0 && (
            <p className="text-xs text-muted-foreground mt-1">
              {messageData.attachments.length} вложение
            </p>
          )}
        </div>

        {/* Search */}
        <input
          type="text"
          placeholder="Поиск чатов..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full p-2 rounded-md border mb-2 text-sm"
        />

        {/* Chat list */}
        <div className="max-h-64 overflow-y-auto">
          {filteredChats.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              Чаты не найдены
            </p>
          ) : (
            <div className="space-y-1">
              {filteredChats.map(chat => (
                <button
                  key={chat.id}
                  type="button"
                  onClick={() => handleSend(chat)}
                  className="w-full p-2 rounded-md hover:bg-accent flex items-center gap-2 text-left"
                >
                  <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center flex-shrink-0">
                    <span className="text-xs font-medium">
                      {chat.name?.charAt(0).toUpperCase() || '?'}
                    </span>
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{chat.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {chat.type === 'group' ? `${chat.participants.length} участников` : 'Личный чат'}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
