import { zodResolver } from '@hookform/resolvers/zod';
import { Check,Loader2, Search, Users, X } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useChat } from '@/contexts/ChatContext';
import { useIsMobile } from '@/hooks/use-mobile';
import { useSearchUsers } from '@/queries';
import { createGroup } from '@/services/chat';
import type { HistoryAccess,UserSearchResult } from '@/types';

interface GroupChatCreateDialogProps {
  onGroupCreated: (chatId: string) => void;
  children?: React.ReactNode;
}

const groupFormSchema = z.object({
  name: z.string().min(1, 'Название группы обязательно').max(100, 'Название слишком длинное'),
  requireApproval: z.boolean(),
  historyAccess: z.enum(['ALL', 'FROM_NOW', 'NONE']),
});

type GroupFormData = z.infer<typeof groupFormSchema>;

export function GroupChatCreateDialog({ onGroupCreated, children }: GroupChatCreateDialogProps) {
  const { loadChats } = useChat();
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<'setup' | 'participants'>('setup');
  const [isCreating, setIsCreating] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedParticipants, setSelectedParticipants] = useState<UserSearchResult[]>([]);

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    reset,
    formState: { errors },
  } = useForm<GroupFormData>({
    resolver: zodResolver(groupFormSchema),
    defaultValues: {
      name: '',
      requireApproval: false,
      historyAccess: 'ALL' as HistoryAccess,
    },
  });

  // Use TanStack Query for search
  const { data: searchResults = [], isLoading: searchLoading } = useSearchUsers(
    searchQuery && searchQuery.length >= 2 ? searchQuery : ''
  );

  const requireApproval = watch('requireApproval');
  const historyAccess = watch('historyAccess') as HistoryAccess;

  const handleAddParticipant = (user: UserSearchResult) => {
    if (!selectedParticipants.find(p => p.id === user.id)) {
      setSelectedParticipants([...selectedParticipants, user]);
    }
    setSearchQuery('');
  };

  const handleRemoveParticipant = (userId: string) => {
    setSelectedParticipants(selectedParticipants.filter(p => p.id !== userId));
  };

  const onSubmit = async (data: GroupFormData) => {
    if (selectedParticipants.length === 0) {
      return;
    }

    setIsCreating(true);
    try {
      const usernames = selectedParticipants.map(p => p.username);
      const result = await createGroup({
        name: data.name,
        participants: usernames,
        requireApproval: data.requireApproval,
        historyAccess: data.historyAccess,
      });

      setOpen(false);
      reset();
      setSelectedParticipants([]);
      setStep('setup');
      onGroupCreated(result.data.chatId);
      // Reload chats to update the sidebar
      await loadChats(true);
    } catch (error) {
      console.error('Failed to create group:', error);
    } finally {
      setIsCreating(false);
    }
  };

  const handleOpenChange = (isOpen: boolean) => {
    setOpen(isOpen);
    if (!isOpen) {
      reset();
      setSelectedParticipants([]);
      setStep('setup');
    }
  };

  const handleNext = () => {
    const name = watch('name');
    if (name && name.length > 0) {
      setStep('participants');
    }
  };

  const handleBack = () => {
    setStep('setup');
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        {children || (
          <Button variant="ghost" className="w-full justify-start">
            <Users className="w-4 h-4 mr-2" />
            Создать группу
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className={isMobile ? 'inset-0 max-w-none h-full rounded-none' : 'sm:max-w-lg'}>
        <DialogHeader>
          <DialogTitle>
            {step === 'setup' ? 'Создание группы' : 'Добавить участников'}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {step === 'setup' 
              ? 'Введите название группы и настройки' 
              : 'Выберите участников для группы'}
          </DialogDescription>
        </DialogHeader>

        {step === 'setup' ? (
          <form onSubmit={handleSubmit(handleNext)} className="space-y-4">
            {/* Название группы */}
            <div className="space-y-2">
              <Label htmlFor="name">Название группы</Label>
              <Input
                id="name"
                placeholder="Введите название группы"
                {...register('name')}
                className={errors.name ? 'border-destructive' : ''}
              />
              {errors.name && (
                <span className="text-xs text-destructive">{errors.name.message}</span>
              )}
            </div>

            {/* Настройки группы */}
            <div className="space-y-3">
              <Label>Настройки</Label>
              
              {/* Требовать одобрение */}
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="requireApproval"
                  checked={requireApproval}
                  onCheckedChange={(checked) => setValue('requireApproval', checked === true)}
                />
                <label
                  htmlFor="requireApproval"
                  className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                >
                  Требовать одобрение для вступления
                </label>
              </div>

              {/* Доступ к истории */}
              <div className="space-y-2">
                <Label className="text-sm">Доступ к истории</Label>
                <div className="flex gap-2">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      value="ALL"
                      checked={historyAccess === 'ALL'}
                      onChange={() => setValue('historyAccess', 'ALL')}
                      className="accent-primary"
                    />
                    <span className="text-sm">Вся</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      value="FROM_NOW"
                      checked={historyAccess === 'FROM_NOW'}
                      onChange={() => setValue('historyAccess', 'FROM_NOW')}
                      className="accent-primary"
                    />
                    <span className="text-sm">С момента вступления</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      value="NONE"
                      checked={historyAccess === 'NONE'}
                      onChange={() => setValue('historyAccess', 'NONE')}
                      className="accent-primary"
                    />
                    <span className="text-sm">Нет</span>
                  </label>
                </div>
              </div>
            </div>

            <Button type="submit" className="w-full">
              Далее
            </Button>
          </form>
        ) : (
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            {/* Выбранные участники */}
            {selectedParticipants.length > 0 && (
              <div className="space-y-2">
                <Label>Выбрано участников: {selectedParticipants.length}</Label>
                <div className="flex flex-wrap gap-2">
                  {selectedParticipants.map((participant) => (
                    <div
                      key={participant.id}
                      className="flex items-center gap-1 bg-muted rounded-full pr-2 pl-1 py-1"
                    >
                      <Avatar className="h-6 w-6">
                        <AvatarImage src={participant.avatar} alt={participant.username} />
                        <AvatarFallback className="text-xs">
                          {participant.username[0]?.toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <span className="text-sm">{participant.username}</span>
                      <button
                        type="button"
                        onClick={() => handleRemoveParticipant(participant.id)}
                        className="ml-1 hover:text-destructive"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Поиск участников */}
            <div className="space-y-2">
              <Label>Добавить участников</Label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Поиск по имени..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9"
                />
                {searchLoading && (
                  <div className="absolute right-3 top-1/2 -translate-y-1/2">
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  </div>
                )}
              </div>
            </div>

            {/* Результаты поиска */}
            {searchResults.length > 0 && (
              <ScrollArea className="h-48">
                <div className="space-y-2">
                   {searchResults
                     .filter(user => !selectedParticipants.find(p => p.id === user.id))
                     .map((user) => (
                       <div
                         key={user.id}
                         role="button"
                         tabIndex={0}
                         className="flex items-center gap-3 p-2 hover:bg-accent rounded-lg cursor-pointer transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2"
                         onClick={() => handleAddParticipant(user)}
                         onKeyDown={(e) => {
                           if (e.key === 'Enter' || e.key === ' ') {
                             e.preventDefault();
                             handleAddParticipant(user);
                           }
                         }}
                       >
                        <Avatar className="h-8 w-8">
                          <AvatarImage src={user.avatar} alt={user.username} />
                          <AvatarFallback>
                            {user.username[0]?.toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm truncate">{user.username}</p>
                          {user.displayName && (
                            <p className="text-xs text-muted-foreground truncate">
                              {user.displayName}
                            </p>
                          )}
                        </div>
                        <Check className="h-4 w-4 text-muted-foreground" />
                      </div>
                    ))}
                </div>
              </ScrollArea>
            )}

            {searchQuery && searchQuery.length >= 2 && searchResults.length === 0 && !searchLoading && (
              <p className="text-center text-muted-foreground py-2 text-sm">
                Пользователи не найдены
              </p>
            )}

            {!searchQuery || searchQuery.length < 2 ? (
              <p className="text-center text-muted-foreground py-2 text-sm">
                Введите минимум 2 символа для поиска
              </p>
            ) : null}

            {/* Кнопки */}
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={handleBack} className="flex-1">
                Назад
              </Button>
              <Button 
                type="submit" 
                className="flex-1"
                disabled={selectedParticipants.length === 0 || isCreating}
              >
                {isCreating ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Создание...
                  </>
                ) : (
                  'Создать группу'
                )}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
