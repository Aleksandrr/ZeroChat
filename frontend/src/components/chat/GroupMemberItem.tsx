import { ArrowUpDown,Crown, MoreVertical, Shield, UserMinus } from 'lucide-react';
import { useState } from 'react';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { GroupParticipant, UserRole } from '@/types';

interface GroupMemberItemProps {
  participant: GroupParticipant;
  isCurrentUser: boolean;
  isAdmin: boolean;
  canManage: boolean;
  onRoleChange: (role: UserRole) => void;
  onRemove: () => void;
  onOpenContactCard?: (userId: string) => void;
}

const roleLabels: Record<UserRole, string> = {
  OWNER: 'Владелец',
  ADMIN: 'Админ',
  MODERATOR: 'Модератор',
  MEMBER: 'Участник',
};

const roleIcons: Record<UserRole, React.ReactNode> = {
  OWNER: <Crown className="h-3 w-3 text-yellow-500" />,
  ADMIN: <Shield className="h-3 w-3 text-purple-500" />,
  MODERATOR: <Shield className="h-3 w-3 text-blue-500" />,
  MEMBER: null,
};

export function GroupMemberItem({
  participant,
  isCurrentUser,
  isAdmin: _isAdmin,
  canManage,
  onRoleChange,
  onRemove,
  onOpenContactCard,
}: GroupMemberItemProps) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  const formatJoinedDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('ru-RU', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  };

  const getStatusText = () => {
    if (participant.status === 'online') return 'онлайн';
    if (participant.lastSeen) {
      const date = new Date(participant.lastSeen);
      const now = new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMs / 3600000);
      const diffDays = Math.floor(diffMs / 86400000);

      if (diffMins < 1) return 'был(а) в сети только что';
      if (diffMins < 60) return `был(а) ${diffMins} мин. назад`;
      if (diffHours < 24) return `был(а) ${diffHours} ч. назад`;
      if (diffDays < 7) return `был(а) ${diffDays} дн. назад`;
      return `был(а) ${formatJoinedDate(participant.lastSeen)}`;
    }
    return 'офлайн';
  };

  const displayName = participant.displayName || participant.username;

  return (
    <div
      className={`flex items-center gap-3 p-2 rounded-lg hover:bg-muted/50 transition-colors ${
        isCurrentUser ? 'bg-muted/30' : ''
      }`}
    >
      <div className="relative">
        <button
          type="button"
          onClick={() => onOpenContactCard?.(participant.userId)}
          className={cn(
            "h-9 w-9 rounded-full overflow-hidden p-0 border-0 bg-transparent cursor-pointer",
            onOpenContactCard && "hover:ring-2 hover:ring-primary/50 transition-all"
          )}
          title={`Открыть профиль ${displayName}`}
        >
          <Avatar className="h-full w-full">
            <AvatarImage src={participant.avatar} alt={participant.username} />
            <AvatarFallback>
              {participant.username.charAt(0).toUpperCase()}
            </AvatarFallback>
          </Avatar>
        </button>
        {participant.status === 'online' && (
          <span className="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full bg-green-500 border-2 border-background" />
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onOpenContactCard?.(participant.userId)}
            className={cn(
              "font-medium text-sm truncate text-left",
              onOpenContactCard && "cursor-pointer hover:underline"
            )}
            title={`Открыть профиль ${displayName}`}
          >
            {displayName}
          </button>
          {roleIcons[participant.role]}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground truncate">
            @{participant.username}
          </span>
          {participant.status !== 'online' && (
            <span className="text-xs text-muted-foreground">
              • {getStatusText()}
            </span>
          )}
        </div>
      </div>

      {/* Бейдж роли */}
      {participant.role !== 'MEMBER' && (
        <span className="text-xs text-muted-foreground shrink-0">
          {roleLabels[participant.role]}
        </span>
      )}

      {/* Меню действий */}
      {(canManage || isCurrentUser) && (
        <DropdownMenu open={isMenuOpen} onOpenChange={setIsMenuOpen}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <MoreVertical className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {canManage && !isCurrentUser && (
              <>
                {participant.role !== 'ADMIN' && (
                  <DropdownMenuItem onClick={() => onRoleChange('ADMIN')}>
                    <Shield className="h-4 w-4 mr-2" />
                    Назначить админом
                  </DropdownMenuItem>
                )}
                {participant.role !== 'MODERATOR' && (
                  <DropdownMenuItem onClick={() => onRoleChange('MODERATOR')}>
                    <Shield className="h-4 w-4 mr-2" />
                    Назначить модератором
                  </DropdownMenuItem>
                )}
                {participant.role !== 'MEMBER' && (
                  <DropdownMenuItem onClick={() => onRoleChange('MEMBER')}>
                    <ArrowUpDown className="h-4 w-4 mr-2" />
                    Понизить до участника
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={onRemove}
                  className="text-destructive focus:text-destructive"
                >
                  <UserMinus className="h-4 w-4 mr-2" />
                  Удалить из группы
                </DropdownMenuItem>
              </>
            )}
            {isCurrentUser && (
              <DropdownMenuItem className="text-muted-foreground">
                Это вы
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
