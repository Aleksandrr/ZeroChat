/**
 * ContactsModal Component
 *
 * Modal dialog for contacts management
 * Can be opened from anywhere in the application
 */

import type React from 'react';
import { useCallback, useState } from 'react';

import { ContactAddDialog } from '@/components/contacts/ContactAddDialog';
import { ContactEditDialog } from '@/components/contacts/ContactEditDialog';
import { ContactList } from '@/components/contacts/ContactList';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useContacts } from '@/hooks/use-contacts';
import { useChat } from '@/contexts';
import type { ContactRecord } from '@/lib/messages';

interface ContactsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenChat: (chatId: string) => void;
}

export const ContactsModal: React.FC<ContactsModalProps> = ({
  open,
  onOpenChange,
  onOpenChat,
}) => {
   const { contacts, loading, loadContacts, toggleFavorite } = useContacts();
   const { loadChats, openVirtualChat, chats, selectChat } = useChat();
   const [addDialogOpen, setAddDialogOpen] = useState(false);
   const [editContact, setEditContact] = useState<ContactRecord | null>(null);

   /**
    * Handle contact selection - open existing chat or virtual chat with this contact
    */
   const handleSelectContact = useCallback((userId: string) => {
     // Find contact in contacts list
     const contact = contacts.find(c => c.id === userId);
     if (contact) {
       // Check if real chat already exists with this contact
       const existingChat = chats.find(chat =>
         chat.type === 'private' &&
         chat.participants.some(p => p.id === userId)
       );
       
       if (existingChat) {
         // Open existing chat directly (navigation will trigger auto-select)
         onOpenChat(existingChat.id);
       } else {
         // Open virtual chat (real chat will be created when first message is sent)
         openVirtualChat({
           id: contact.id,
           username: contact.username,
           displayName: contact.displayName,
           avatar: contact.avatar,
         });
         // Notify parent to navigate to the virtual chat
         onOpenChat(`virtual-${contact.id}`);
       }
     }
     // Close the modal after opening chat
     onOpenChange(false);
   }, [contacts, chats, openVirtualChat, selectChat, onOpenChat, onOpenChange]);

  /**
   * Handle contact added
   */
  const handleContactAdded = useCallback((_contact: ContactRecord) => {
    setAddDialogOpen(false);
    // Reload contacts to show the new one in the list
    void loadContacts();
  }, [loadContacts]);

  /**
   * Handle contact updated
   */
  const handleContactUpdated = useCallback(() => {
    setEditContact(null);
    // Reload contacts to ensure UI reflects the updated data
    void loadContacts();
  }, [loadContacts]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Контакты</DialogTitle>
          <DialogDescription>
            Управление вашими контактами и адресной книгой
          </DialogDescription>
        </DialogHeader>

        {/* Contact List */}
        <ContactList
          contacts={contacts}
          loading={loading}
          toggleFavorite={toggleFavorite}
          onSelectContact={handleSelectContact}
          onAddContact={() => setAddDialogOpen(true)}
          onEditContact={(userId) => {
            const contact = contacts.find(c => c.id === userId);
            if (contact) setEditContact(contact);
          }}
          onDeleteContact={async (_userId) => {
             // Delete handled in hook, but we can add confirmation here if needed
          }}
        />

        {/* Add Contact Dialog */}
        <ContactAddDialog
          open={addDialogOpen}
          onOpenChange={setAddDialogOpen}
          onContactAdded={handleContactAdded}
        />

        {/* Edit Contact Dialog */}
        <ContactEditDialog
          open={!!editContact}
          onOpenChange={(open) => !open && setEditContact(null)}
          contact={editContact}
          onContactUpdated={handleContactUpdated}
        />
      </DialogContent>
    </Dialog>
  );
};

ContactsModal.displayName = 'ContactsModal';

export default ContactsModal;
