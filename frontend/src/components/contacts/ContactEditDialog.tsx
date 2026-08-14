/**
 * ContactEditDialog Component
 *
 * Dialog for editing contact details (displayName, notes, favorite)
 */

import type React from 'react';
import { useEffect,useState } from 'react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useContacts } from '@/hooks/use-contacts';
import type { ContactRecord } from '@/lib/messages';

interface ContactEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contact: ContactRecord | null;
  onContactUpdated: () => void;
}

export const ContactEditDialog: React.FC<ContactEditDialogProps> = ({
  open,
  onOpenChange,
  contact,
  onContactUpdated,
}) => {
  const { updateContact } = useContacts();

  const [displayName, setDisplayName] = useState('');
  const [notes, setNotes] = useState('');
  const [isFavorite, setIsFavorite] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Initialize form when contact changes
   */
  useEffect(() => {
    if (contact) {
      setDisplayName(contact.displayName || '');
      setNotes(contact.notes || '');
      setIsFavorite(contact.isFavorite);
    }
  }, [contact]);

  /**
   * Save changes
   */
  const handleSave = async () => {
    if (!contact) return;

    setIsSaving(true);
    setError(null);
    try {
      await updateContact(contact.id, {
        displayName: displayName.trim() || undefined,
        notes: notes.trim() || undefined,
        isFavorite,
      });
      onContactUpdated();
      handleClose();
    } catch (err: unknown) {
      const error = err as Error;
      setError(error.message || 'Ошибка сохранения');
    } finally {
      setIsSaving(false);
    }
  };

  /**
   * Close dialog and reset state
   */
  const handleClose = () => {
    onOpenChange(false);
    setError(null);
  };

  if (!contact) return null;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Редактировать контакт</DialogTitle>
          <DialogDescription>
            Измените отображаемое имя, заметки или статус избранного
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Display Name */}
          <div className="space-y-2">
            <label htmlFor="displayName" className="text-sm font-medium">
              Отображаемое имя
            </label>
            <Input
              id="displayName"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Введите отображаемое имя"
            />
          </div>

          {/* Notes */}
          <div className="space-y-2">
            <label htmlFor="notes" className="text-sm font-medium">
              Заметки
            </label>
            <Textarea
              id="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Добавьте заметки о контакте (необязательно)"
              rows={3}
            />
          </div>

          {/* Favorite Checkbox */}
          <div className="flex items-center space-x-2">
            <Checkbox
              id="favorite"
              checked={isFavorite}
              onCheckedChange={(checked) => setIsFavorite(checked === true)}
            />
            <label htmlFor="favorite" className="text-sm font-medium cursor-pointer">
              Избранный контакт
            </label>
          </div>

          {/* Error */}
          {error && (
            <div className="text-sm text-destructive">{error}</div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={isSaving}>
            Отмена
          </Button>
          <Button onClick={handleSave} disabled={isSaving}>
            {isSaving ? 'Сохранение...' : 'Сохранить'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

ContactEditDialog.displayName = 'ContactEditDialog';

export default ContactEditDialog;
