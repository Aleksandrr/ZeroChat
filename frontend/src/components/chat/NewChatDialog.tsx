import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2, Search, Users } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useChat } from '@/contexts';
import { type UserSearchInput,userSearchSchema } from '@/lib/validation';
import { useSearchUsers } from '@/queries';
import type { UserSearchResult } from '@/types';

import { GroupChatCreateDialog } from './GroupChatCreateDialog';

interface NewChatDialogProps {
  onChatCreated: (chatId: string) => void;
  children?: React.ReactNode;
}

export function NewChatDialog({ onChatCreated, children }: NewChatDialogProps) {
  const { openVirtualChat, chats, selectChat } = useChat();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState<string | null>(null);

  // Form setup with React Hook Form
  const {
    register,
    watch,
    reset,
    formState: { errors },
  } = useForm<UserSearchInput>({
    resolver: zodResolver(userSearchSchema),
    defaultValues: {
      query: '',
    },
  });

  const searchQuery = watch('query');

  // Use TanStack Query for search - only search when query has at least 2 chars
  const { data: searchResults = [], isLoading: searchLoading } = useSearchUsers(
    searchQuery && searchQuery.length >= 2 ? searchQuery : ''
  );

    // Create or open chat with user
    const handleCreateChat = (user: UserSearchResult) => {
      setOpen(false);
      reset({ query: '' });
      
      const existingChat = chats.find(chat =>
        chat.type === 'private' &&
        chat.participants.some(p => p.id === user.id)
      );
      
      if (existingChat) {
        onChatCreated(existingChat.id);
      } else {
        openVirtualChat({
          id: user.id,
          username: user.username,
          displayName: user.displayName,
          avatar: user.avatar,
        });
        const virtualChatId = `virtual-${user.id}`;
        onChatCreated(virtualChatId);
      }
    };

  const handleOpenChange = (isOpen: boolean) => {
    setOpen(isOpen);
    if (!isOpen) {
      reset({ query: '' });
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogTrigger asChild>
          {children || (
            <Button>
              <Search className="w-4 h-4 mr-2" />
              Новый чат
            </Button>
          )}
        </DialogTrigger>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Новый чат</DialogTitle>
            <DialogDescription className="sr-only">
              Найдите пользователя для начала переписки
            </DialogDescription>
          </DialogHeader>

          {/* Кнопка создания группы */}
          <GroupChatCreateDialog
            onGroupCreated={(chatId) => {
              setOpen(false);
              reset({ query: '' });
              onChatCreated(chatId);
            }}
          >
            <Button variant="outline" className="w-full justify-start mb-3">
              <Users className="w-4 h-4 mr-2" />
              Создать группу
            </Button>
          </GroupChatCreateDialog>

          <div className="relative my-3">
            <div className="absolute inset-0 border-t" />
          </div>

          {/* Поиск */}
        <div className="relative">
          <Input
            {...register('query')}
            placeholder="Поиск по имени..."
            className={`pr-10 ${errors.query ? 'border-destructive focus-visible:ring-destructive' : ''}`}
          />
          {searchLoading && (
            <div className="absolute right-3 top-1/2 -translate-y-1/2">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          )}
        </div>
        {errors.query && (
          <span className="text-xs text-destructive">{errors.query.message}</span>
        )}

        {/* Результаты поиска */}
        <div className="max-h-64 overflow-y-auto space-y-2">
          {searchResults.length === 0 && searchQuery && searchQuery.length >= 2 && !searchLoading && (
            <p className="text-center text-muted-foreground py-4">
              Пользователи не найдены
            </p>
          )}

          {searchResults.map((user) => (
            <div
              key={user.id}
              role="button"
              tabIndex={0}
              className="flex items-center gap-3 p-3 hover:bg-accent rounded-lg cursor-pointer transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2"
              onClick={() => void handleCreateChat(user)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  void handleCreateChat(user);
                }
              }}
            >
              <Avatar className="h-10 w-10">
                <AvatarImage src={user.avatar} alt={user.username} />
                <AvatarFallback>
                  {user.username[0]?.toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <div className="flex-1 min-w-0">
                <p className="font-medium truncate">{user.username}</p>
                {user.displayName && (
                  <p className="text-sm text-muted-foreground truncate">
                    {user.displayName}
                  </p>
                )}
              </div>
              {creating === user.id ? (
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
              ) : (
                <Button variant="secondary" size="sm">
                  Написать
                </Button>
              )}
            </div>
          ))}
        </div>

        {/* Пустой стейт */}
        {(!searchQuery || searchQuery.length < 2) && (
          <p className="text-center text-muted-foreground py-4 text-sm">
            Введите минимум 2 символа для поиска
          </p>
        )}
      </DialogContent>
    </Dialog>
    </>
  );
}
