/**
 * ContactList Component
 *
 * Displays a scrollable list of contacts with search
 */

import { Search, UserPlus } from 'lucide-react';
import type React from 'react';
import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { ContactRecord } from '@/lib/messages';

import { ContactItem } from './ContactItem';

interface ContactListProps {
  contacts: ContactRecord[];
  loading: boolean;
  toggleFavorite: (userId: string) => Promise<void>;
  onSelectContact: (userId: string) => void;
  onAddContact: () => void;
  onEditContact: (userId: string) => void;
  onDeleteContact: (userId: string) => void;
}

export const ContactList: React.FC<ContactListProps> = ({
  contacts,
  loading,
  toggleFavorite,
  onSelectContact,
  onAddContact,
  onEditContact,
  onDeleteContact,
}) => {
  const [searchQuery, setSearchQuery] = useState('');

  // Group contacts: favorites first, then others
  const groupedContacts = useMemo(() => {
    const favorites = contacts.filter(c => c.isFavorite);
    const others = contacts.filter(c => !c.isFavorite);
    return { favorites, others };
  }, [contacts]);

  const renderContact = (contact: ContactRecord) => (
    <ContactItem
      key={contact.id}
      contact={contact}
      onSelect={onSelectContact}
      onEdit={onEditContact}
      onDelete={onDeleteContact}
      onToggleFavorite={toggleFavorite}
    />
  );

  return (
    <div className="flex flex-col h-full">
      {/* Header with Search and Add */}
      <div className="p-4 border-b space-y-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Поиск контактов..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>
        <Button onClick={onAddContact} className="w-full">
          <UserPlus className="mr-2 h-4 w-4" />
          Добавить контакт
        </Button>
      </div>

      {/* Contacts List */}
      <ScrollArea className="flex-1">
        {loading ? (
          <div className="p-4 text-center text-muted-foreground">
            Загрузка...
          </div>
        ) : contacts.length === 0 ? (
          <div className="p-4 text-center text-muted-foreground">
            {searchQuery ? 'Контакты не найдены' : 'Контактов пока нет'}
          </div>
        ) : (
          <div className="p-2 space-y-1">
            {/* Favorites Section */}
            {groupedContacts.favorites.length > 0 && (
              <div className="mb-3">
                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-2 mb-1">
                  Избранные
                </h3>
                {groupedContacts.favorites.map(renderContact)}
              </div>
            )}

            {/* All Contacts Section */}
            {groupedContacts.others.length > 0 && (
              <div>
                {groupedContacts.favorites.length > 0 && (
                  <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-2 mb-1">
                    Все контакты
                  </h3>
                )}
                {groupedContacts.others.map(renderContact)}
              </div>
            )}
          </div>
        )}
      </ScrollArea>
    </div>
  );
};

ContactList.displayName = 'ContactList';

export default ContactList;
