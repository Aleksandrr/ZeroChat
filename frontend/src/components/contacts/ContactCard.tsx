/**
 * ContactCard Component
 *
 * Modal card displaying contact information and chat media statistics
 * Shows avatar, username, display name, media breakdown, and actions
 */

import type React from 'react';
import { useCallback, useEffect, useState } from 'react';

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
import { useContacts } from '@/hooks/use-contacts';
import { useChat } from '@/contexts';
import { getContact, getChatMessages, type StoredMessage } from '@/lib/messages';
import { contactsService } from '@/services/contacts';
import { ContactEditDialog } from '@/components/contacts/ContactEditDialog';
import { MediaListDialog } from './MediaListDialog';
import type { ContactRecord } from '@/lib/messages/db';
import type { UserProfile } from '@/types';
import {
  Image as ImageIcon,
  Video,
  Music,
  File,
  Edit2,
  Trash2,
  UserPlus,
  Loader2,
  MessageCircle,
} from 'lucide-react';

interface ContactCardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string; // The other participant's user ID
  chatId?: string | null;
  onOpenChat?: (chatId: string) => void;
}

interface MediaStats {
  images: number;
  videos: number;
  audio: number;
  files: number;
  total: number;
}

// Helper function to get initials
function getInitials(name?: string | null): string {
  if (!name) return '';
  return name
    .trim()
    .split(' ')
    .map(part => part[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

export const ContactCard: React.FC<ContactCardProps> = ({
  open,
  onOpenChange,
  userId,
  chatId,
  onOpenChat,
}) => {
  const { deleteContact, addContact } = useContacts();
  const { chats, selectChat, openVirtualChat } = useChat();

  const [contact, setContact] = useState<ContactRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [mediaStats, setMediaStats] = useState<MediaStats>({
    images: 0,
    videos: 0,
    audio: 0,
    files: 0,
    total: 0,
  });
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [mediaTypeFilter, setMediaTypeFilter] = useState<'image' | 'video' | 'audio' | 'file' | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [loadingProfile, setLoadingProfile] = useState(false);
  const [isAddingContact, setIsAddingContact] = useState(false);

  /**
   * Load contact data from IndexedDB
   */
  const loadContact = useCallback(async () => {
    try {
      const contactData = await getContact(userId);
      setContact(contactData);
    } catch (error) {
      console.error('[ContactCard] Failed to load contact:', error);
    } finally {
      setLoading(false);
    }
  }, [userId, getContact]);

  /**
   * Count media attachments in chat messages
   */
  const countMediaStats = useCallback((messages: StoredMessage[]): MediaStats => {
    const stats: MediaStats = {
      images: 0,
      videos: 0,
      audio: 0,
      files: 0,
      total: 0,
    };

    for (const message of messages) {
      if (message.attachments && message.attachments.length > 0) {
        for (const attachment of message.attachments) {
          stats.total++;
          switch (attachment.type.toLowerCase()) {
            case 'image':
              stats.images++;
              break;
            case 'video':
              stats.videos++;
              break;
            case 'audio':
              stats.audio++;
              break;
            case 'file':
              stats.files++;
              break;
          }
        }
      }
    }

    return stats;
  }, []);

   /**
    * Load messages and calculate media statistics
    */
   const loadMediaStats = useCallback(async () => {
     if (!chatId) {
       // No chatId provided (e.g., opened from group chat without private chat), reset stats
       setMediaStats({ images: 0, videos: 0, audio: 0, files: 0, total: 0 });
       return;
     }
     try {
       const messages = await getChatMessages(chatId);
       const stats = countMediaStats(messages);
       setMediaStats(stats);
     } catch (error) {
       console.error('[ContactCard] Failed to load media stats:', error);
     }
   }, [chatId, countMediaStats]);

   /**
    * Load data when dialog opens
    */
   useEffect(() => {
     if (open) {
       setLoading(true);
       setUserProfile(null);
       void Promise.all([loadContact(), loadMediaStats()]);
     }
   }, [open, loadContact, loadMediaStats]);

   /**
    * Load user profile from server when contact is not found
    */
   useEffect(() => {
     if (open && !contact) {
       const fetchUserProfile = async () => {
         setLoadingProfile(true);
         try {
           const profile = await contactsService.getUserProfile(userId);
           setUserProfile(profile);
         } catch (error) {
           console.error('[ContactCard] Failed to load user profile:', error);
           setUserProfile(null);
         } finally {
           setLoadingProfile(false);
         }
       };
       void fetchUserProfile();
     }
   }, [open, contact, userId]);

   /**
    * Handle contact deletion
    */
   const handleDeleteContact = async () => {
     if (!contact || !confirm('Удалить этот контакт из адресной книги?')) return;

     try {
       await deleteContact(contact.id);
       setContact(null);
       onOpenChange(false);
     } catch (error) {
       console.error('[ContactCard] Failed to delete contact:', error);
       alert('Не удалось удалить контакт');
     }
   };

   /**
    * Handle adding a new contact
    */
   const handleAddContact = async () => {
     if (!userProfile) return;
     if (!confirm(`Добавить ${userProfile.displayName || userProfile.username} в контакты?`)) return;
     setIsAddingContact(true);
     try {
       const newContact = await addContact(userProfile.id);
       setContact(newContact);
       setUserProfile(null);
     } catch (error) {
       console.error('[ContactCard] Failed to add contact:', error);
       alert('Не удалось добавить контакт');
     } finally {
       setIsAddingContact(false);
     }
   };

   /**
    * Handle contact update (after edit dialog closes)
    */
 const handleContactUpdated = () => {
   void loadContact();
   setEditDialogOpen(false);
 };

 /**
  * Handle writing to this contact - open existing chat or create virtual chat
  */
 const handleWriteMessage = useCallback(() => {
   // Check if real chat already exists with this user
   const existingChat = chats.find(chat =>
     chat.type === 'private' &&
     chat.participants.some(p => p.id === userId)
   );

   if (existingChat) {
     // Open existing chat directly (navigation will trigger auto-select)
     onOpenChat?.(existingChat.id);
   } else {
     // Open virtual chat - real chat will be created when first message is sent
     openVirtualChat({
       id: userId,
       username: contact?.username || userProfile?.username || '',
       displayName: contact?.displayName || userProfile?.displayName,
       avatar: contact?.avatar || userProfile?.avatar,
     });
     onOpenChat?.(`virtual-${userId}`);
   }
   onOpenChange(false);
 }, [chats, userId, contact, userProfile, selectChat, openVirtualChat, onOpenChange, onOpenChat]);

  /**
   * Get display name (fallback to username if no displayName)
   */
  const displayName = contact?.displayName || contact?.username || 'Неизвестный';

  /**
   * Get initials for avatar fallback
   */
  const initials = getInitials(displayName);

  /**
   * Media type items for rendering
   */
  const mediaTypes = [
    { type: 'image' as const, label: 'Фото', icon: ImageIcon, count: mediaStats.images },
    { type: 'video' as const, label: 'Видео', icon: Video, count: mediaStats.videos },
    { type: 'audio' as const, label: 'Аудио', icon: Music, count: mediaStats.audio },
    { type: 'file' as const, label: 'Файлы', icon: File, count: mediaStats.files },
  ];

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Информация о контакте</DialogTitle>
            <DialogDescription>
              Просмотр информации и медиа в чате
            </DialogDescription>
          </DialogHeader>

           {loading ? (
             <div className="flex items-center justify-center py-8">
               <div className="text-sm text-muted-foreground">Загрузка...</div>
             </div>
           ) : contact || userProfile ? (
             <>
               {/* User Info Section */}
               {(contact || userProfile) && (
                 <div className="flex items-start gap-4 py-4">
                   <Avatar className="h-16 w-16">
                     {(contact?.avatar || userProfile?.avatar) ? (
                       <AvatarImage src={contact?.avatar || userProfile?.avatar} alt={contact?.displayName || contact?.username || userProfile?.displayName || userProfile?.username} />
                     ) : null}
                     <AvatarFallback>
                       {getInitials(contact?.displayName || contact?.username || userProfile?.displayName || userProfile?.username)}
                     </AvatarFallback>
                   </Avatar>
                   <div className="flex-1 min-w-0">
                     <h3 className="font-semibold text-lg truncate">
                       {contact?.displayName || contact?.username || userProfile?.displayName || userProfile?.username}
                     </h3>
                     <p className="text-sm text-muted-foreground">@{contact?.username || userProfile?.username}</p>
                   </div>
                 </div>
               )}

               {/* Media Statistics Section (always shown if chat has messages) */}
               <div className="py-4">
                 <h4 className="text-sm font-medium mb-3">Медиа в чате</h4>
                 <div className="grid grid-cols-2 gap-3">
                   {mediaTypes.map(({ type, label, icon: Icon, count }) => (
                     <Button
                       key={type}
                       variant="outline"
                       className="h-auto py-3 px-4 flex items-center justify-between gap-3"
                       onClick={() => setMediaTypeFilter(type)}
                       disabled={count === 0}
                     >
                       <div className="flex items-center gap-3">
                         <Icon className="h-5 w-5 text-muted-foreground" />
                         <span className="text-sm">{label}</span>
                       </div>
                       <span className="text-sm font-medium">{count}</span>
                     </Button>
                   ))}
                 </div>
               </div>

                {/* Actions Section */}
                <div className="flex flex-col gap-2 pt-2">
                  <Button
                    variant="default"
                    className="w-full"
                    onClick={handleWriteMessage}
                  >
                    <MessageCircle className="h-4 w-4 mr-2" />
                    Написать
                  </Button>
                  
                  {contact ? (
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        className="flex-1"
                        onClick={() => setEditDialogOpen(true)}
                      >
                        <Edit2 className="h-4 w-4 mr-2" />
                        Переименовать
                      </Button>
                      <Button
                        variant="destructive"
                        onClick={handleDeleteContact}
                      >
                        <Trash2 className="h-4 w-4 mr-2" />
                        Удалить
                      </Button>
                    </div>
                  ) : userProfile ? (
                    <Button
                      variant="default"
                      className="w-full"
                      onClick={handleAddContact}
                      disabled={isAddingContact}
                    >
                      {isAddingContact ? (
                        <Loader2 className="h-4 w-4 animate-spin mr-2" />
                      ) : (
                        <UserPlus className="h-4 w-4 mr-2" />
                      )}
                      Добавить в контакты
                    </Button>
                  ) : null}
                </div>
             </>
           ) : loadingProfile ? (
             <div className="flex items-center justify-center py-8">
               <div className="text-sm text-muted-foreground">Загрузка профиля...</div>
             </div>
           ) : (
             <div className="py-8 text-center text-muted-foreground">
               <p>Не удалось загрузить информацию о пользователе</p>
             </div>
           )}
        </DialogContent>
      </Dialog>

      {/* Edit Contact Dialog */}
      <ContactEditDialog
        open={editDialogOpen}
        onOpenChange={(open) => !open && setEditDialogOpen(false)}
        contact={contact}
        onContactUpdated={handleContactUpdated}
      />

      {/* Media List Dialog */}
      <MediaListDialog
        open={mediaTypeFilter !== null}
        onOpenChange={(open) => {
          if (!open) setMediaTypeFilter(null);
        }}
        chatId={chatId}
        mediaType={mediaTypeFilter}
      />
    </>
  );
};

ContactCard.displayName = 'ContactCard';

export default ContactCard;
