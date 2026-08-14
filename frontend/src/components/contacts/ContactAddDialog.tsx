/**
 * ContactAddDialog Component
 *
 * Dialog for adding a new contact by searching users
 */

import { Loader2,Search, UserPlus } from 'lucide-react';
import type React from 'react';
import { useCallback,useState } from 'react';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useContacts } from '@/hooks/use-contacts';
import type { ContactRecord } from '@/lib/messages';
import type { UserProfile } from '@/types';
import { getAccessToken } from '@/services/auth/tokens';

interface ContactAddDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onContactAdded: (contact: ContactRecord) => void;
}

export const ContactAddDialog: React.FC<ContactAddDialogProps> = ({
  open,
  onOpenChange,
  onContactAdded,
}) => {
  const { addContact } = useContacts();
  
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<UserProfile[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isAdding, setIsAdding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * Search for users
   */
  const searchUsers = useCallback(async (query: string) => {
    if (query.length < 2) {
      setSearchResults([]);
      return;
    }

    setIsSearching(true);
    setError(null);
    try {
      const token = getAccessToken();
      if (!token) {
        throw new Error('Not authenticated');
      }
      
      const response = await fetch(
        `${import.meta.env.VITE_API_URL || 'http://localhost:3001/api'}/users/search?query=${encodeURIComponent(query)}&limit=20`,
        {
          credentials: 'include',
          headers: {
            'Authorization': `Bearer ${token}`,
          },
        }
      );

      if (!response.ok) {
        throw new Error('Failed to search users');
      }

      const data = await response.json();
      setSearchResults(data.data || []);
    } catch (err: unknown) {
      const error = err as Error;
      setError(error.message || 'Ошибка поиска');
      setSearchResults([]);
    } finally {
      setIsSearching(false);
    }
  }, []);

  /**
   * Handle search input change with debounce
   */
  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setSearchQuery(value);
    
    // Debounce search
    const timeoutId = setTimeout(async () => {
      await searchUsers(value);
    }, 300);
    
    return () => clearTimeout(timeoutId);
  };

  /**
   * Add a contact
   */
  const handleAddContact = async (userId: string) => {
    setIsAdding(userId);
    setError(null);
    try {
      const contact = await addContact(userId);
      onContactAdded(contact);
      handleClose();
    } catch (err: unknown) {
      const error = err as Error;
      setError(error.message || 'Ошибка добавления контакта');
    } finally {
      setIsAdding(null);
    }
  };

  /**
   * Close dialog and reset state
   */
  const handleClose = () => {
    onOpenChange(false);
    setSearchQuery('');
    setSearchResults([]);
    setError(null);
    setIsAdding(null);
  };

  /**
   * Get user initials for avatar
   */
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

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Добавить контакт</DialogTitle>
          <DialogDescription>
            Найдите пользователя по имени или логину и добавьте в контакты
          </DialogDescription>
        </DialogHeader>

        {/* Search Input */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Введите имя или логин (минимум 2 символа)"
            value={searchQuery}
            onChange={handleSearchChange}
            className="pl-9"
            disabled={isSearching}
          />
        </div>

        {/* Error Message */}
        {error && (
          <div className="text-sm text-destructive">{error}</div>
        )}

        {/* Search Results */}
        <ScrollArea className="h-64 border rounded-md">
          {isSearching ? (
            <div className="flex items-center justify-center h-full">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : searchResults.length === 0 && searchQuery.length >= 2 ? (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              Пользователи не найдены
            </div>
          ) : (
            <div className="p-2 space-y-1">
              {searchResults.map((user) => (
                <div
                  key={user.id}
                  className="flex items-center gap-3 p-2 rounded-lg hover:bg-accent/50 transition-colors"
                >
                  <Avatar className="h-10 w-10">
                    {user.avatar ? (
                      <AvatarImage src={user.avatar} alt={user.displayName || user.username} />
                    ) : null}
                    <AvatarFallback>{getInitials(user.displayName || user.username)}</AvatarFallback>
                  </Avatar>

                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">
                      {user.displayName || user.username}
                    </p>
                    <p className="text-sm text-muted-foreground truncate">
                      @{user.username}
                    </p>
                  </div>

                  <Button
                    size="sm"
                    onClick={() => handleAddContact(user.id)}
                    disabled={isAdding === user.id}
                  >
                    {isAdding === user.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <>
                        <UserPlus className="mr-2 h-4 w-4" />
                        Добавить
                      </>
                    )}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>
            Отмена
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

ContactAddDialog.displayName = 'ContactAddDialog';

export default ContactAddDialog;
