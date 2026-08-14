import { useNavigate } from '@tanstack/react-router';
import { Plus, Star } from 'lucide-react';

import { NewChatDialog } from '@/components/chat/NewChatDialog';
import { Button } from '@/components/ui/button';
import type { Chat, User } from '@/types';

import { ChatList } from './ChatList';
import { UserMenu } from './UserMenu';

interface SidebarProps {
  user: User | null;
  chats: Chat[];
  selectedChatId: string | undefined;
  onLogout: () => void;
  onOpenSettings: () => void;
  onOpenContacts?: () => void;
  onOpenFavorites?: () => void;
  onChatCreated?: (chatId: string) => void;
}

export function Sidebar({
  user,
  chats,
  selectedChatId: _selectedChatId,
  onLogout,
  onOpenSettings,
  onOpenContacts,
  onOpenFavorites,
  onChatCreated,
}: SidebarProps) {
  const navigate = useNavigate();

  return (
    <div className="flex flex-col h-full">
      {/* Меню пользователя */}
      <div className="p-3">
        <UserMenu
          user={user}
          onLogout={onLogout}
          onOpenSettings={onOpenSettings}
          onOpenContacts={onOpenContacts}
          onOpenFavorites={onOpenFavorites}
        />
      </div>


       <div className="flex-1 min-w-0 overflow-hidden">
         <ChatList />
       </div>

      {/* Кнопка нового чата */}
      <div className="p-3">
        <NewChatDialog
          onChatCreated={(chatId) => {
            const chat = chats.find((c) => c.id === chatId);
            if (chat) {
              void navigate({ to: '/chat/$chatId', params: { chatId: chat.id } });
            } else if (onChatCreated) {
              onChatCreated(chatId);
            }
          }}
        >
          <Button className="w-full rounded-xl" size="lg">
            <Plus className="w-5 h-5 mr-2" />
            Новый чат
          </Button>
        </NewChatDialog>
      </div>
    </div>
  );
}
