import { Plus } from 'lucide-react';

import { NewChatDialog } from '@/components/chat/NewChatDialog';
import { Button } from '@/components/ui/button';
import { ChatList } from '@/components/sidebar/ChatList';

interface ChatListPageProps {
  onChatCreated?: (chatId: string) => void;
}

export function ChatListPage({ onChatCreated }: ChatListPageProps) {
  return (
    <div className="flex flex-col h-full">
      <div className="p-3">
        <NewChatDialog onChatCreated={onChatCreated || (() => {})}>
          <Button className="w-full rounded-xl" size="lg">
            <Plus className="w-5 h-5 mr-2" />
            Новый чат
          </Button>
        </NewChatDialog>
      </div>
      <ChatList />
    </div>
  );
}
