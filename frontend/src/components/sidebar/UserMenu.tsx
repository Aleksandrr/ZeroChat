import {
  LogOut,
  Settings,
  Star,
  User,
  Users} from 'lucide-react';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import type { User as UserType } from '@/types';
import { ProfileModal } from './ProfileModal';
import { useState } from 'react';

interface UserMenuProps {
  user: UserType | null;
  onLogout: () => void;
  onOpenSettings: () => void;
  onOpenContacts?: () => void;
  onOpenFavorites?: () => void;
}

export function UserMenu({
  user,
  onLogout,
  onOpenSettings,
  onOpenContacts,
  onOpenFavorites
}: UserMenuProps) {
  const [isProfileModalOpen, setIsProfileModalOpen] = useState(false);

  // Show loading state when user is null
  if (!user) {
    return (
      <div className="flex items-center gap-3 px-3 py-2">
        <Skeleton className="h-9 w-9 rounded-full" />
        <div className="flex-1">
          <Skeleton className="h-4 w-24 mb-1" />
          <Skeleton className="h-3 w-16" />
        </div>
      </div>
    );
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="w-full flex items-center gap-3 px-3 py-2 h-auto rounded-xl hover:bg-muted/50 transition-colors"
          >
            <Avatar className="h-9 w-9">
              {user.avatar ? (
                <AvatarImage src={user.avatar} alt={user.username} />
              ) : (
                <AvatarFallback className="bg-primary/10">
                  <span className="text-sm font-medium text-primary">
                    {user.username.charAt(0).toUpperCase()}
                  </span>
                </AvatarFallback>
              )}
            </Avatar>
            <div className="flex-1 text-left">
              <span className="text-sm font-medium block truncate">
                {user.username}
              </span>
              <span className="text-xs text-muted-foreground block truncate">
                {user.status === 'online' ? 'онлайн' : 'офлайн'}
              </span>
            </div>
          </Button>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuLabel>Аккаунт</DropdownMenuLabel>
          <DropdownMenuSeparator />

          <DropdownMenuItem onClick={() => setIsProfileModalOpen(true)}>
            <User className="w-4 h-4 mr-2" />
            Профиль
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onOpenContacts?.()}>
            <Users className="w-4 h-4 mr-2" />
            Контакты
          </DropdownMenuItem>
          {onOpenFavorites && (
            <DropdownMenuItem onClick={onOpenFavorites}>
              <Star className="w-4 h-4 mr-2" />
              Избранное
            </DropdownMenuItem>
          )}

          <DropdownMenuSeparator />

          <DropdownMenuItem onClick={onOpenSettings}>
            <Settings className="w-4 h-4 mr-2" />
            Настройки
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          <DropdownMenuItem
            onClick={onLogout}
            className="text-destructive focus:text-destructive"
          >
            <LogOut className="w-4 h-4 mr-2" />
            Выйти
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ProfileModal
        open={isProfileModalOpen}
        onOpenChange={setIsProfileModalOpen}
      />
    </>
  );
}
