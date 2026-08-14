/**
 * ContactItem Component
 *
 * Displays a single contact in the contacts list
 */

import { Edit2, MessageSquare, MoreVertical,Star, Trash2 } from 'lucide-react';
import type React from 'react';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { ContactRecord } from '@/lib/messages';

interface ContactItemProps {
  contact: ContactRecord;
  onSelect: (userId: string) => void;
  onEdit: (userId: string) => void;
  onDelete: (userId: string) => void;
  onToggleFavorite: (userId: string) => void;
}

export const ContactItem: React.FC<ContactItemProps> = ({
  contact,
  onSelect,
  onEdit,
  onDelete,
  onToggleFavorite,
}) => {
  const getInitials = (name?: string | null) => {
    if (!name) return '';
    return name
      .trim()
      .split(' ')
      .map(part => part[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  };

  const displayName = contact.displayName || contact.username;

  return (
    <div className="flex items-center gap-3 p-3 rounded-lg hover:bg-accent/50 transition-colors group">
      {/* Avatar */}
      <Avatar 
        className="h-10 w-10 cursor-pointer"
        onClick={() => onSelect(contact.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelect(contact.id);
          }
        }}
        tabIndex={0}
        role="button"
        aria-label={`Открыть чат с ${displayName}`}
      >
        {contact.avatar ? (
          <AvatarImage src={contact.avatar} alt={displayName} />
        ) : null}
        <AvatarFallback>{getInitials(displayName)}</AvatarFallback>
      </Avatar>

      {/* Contact Info */}
      <div 
        className="flex-1 min-w-0 cursor-pointer"
        onClick={() => onSelect(contact.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelect(contact.id);
          }
        }}
        tabIndex={0}
        role="button"
        aria-label={`Открыть чат с ${displayName}`}
      >
        <div className="flex items-center gap-2">
          <p className="font-medium truncate">{displayName}</p>
          {contact.isFavorite && (
            <Star className="h-4 w-4 fill-yellow-400 text-yellow-400 flex-shrink-0" />
          )}
        </div>
        <p className="text-sm text-muted-foreground truncate">
          @{contact.username}
        </p>
      </div>

      {/* Actions Menu */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <MoreVertical className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => onSelect(contact.id)}>
            <MessageSquare className="mr-2 h-4 w-4" />
            <span>Открыть чат</span>
          </DropdownMenuItem>
          
          <DropdownMenuItem onClick={() => onToggleFavorite(contact.id)}>
            <Star className="mr-2 h-4 w-4" />
            <span>{contact.isFavorite ? 'Убрать из избранного' : 'Добавить в избранное'}</span>
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          <DropdownMenuItem onClick={() => onEdit(contact.id)}>
            <Edit2 className="mr-2 h-4 w-4" />
            <span>Редактировать</span>
          </DropdownMenuItem>

          <DropdownMenuItem 
            onClick={() => onDelete(contact.id)}
            className="text-destructive focus:text-destructive"
          >
            <Trash2 className="mr-2 h-4 w-4" />
            <span>Удалить</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};

ContactItem.displayName = 'ContactItem';

export default ContactItem;
