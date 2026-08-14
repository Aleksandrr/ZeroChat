import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogOverlay, AlertDialogPortal, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { useState } from 'react';

interface DeleteChatDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  chatId: string;
  isGroup: boolean;
  onDelete: (chatId: string, deleteMessages: boolean) => Promise<void>;
}

/**
 * DeleteChatDialog - модальное окно подтверждения удаления чата
 *
 * Используется в ChatHeader для удаления чата с подтверждением.
 * Централизует логику удаления и состояние загрузки.
 */
export function DeleteChatDialog({ open, onOpenChange, chatId, isGroup, onDelete }: DeleteChatDialogProps) {
  const [isDeleting, setIsDeleting] = useState(false);

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      await onDelete(chatId, true); // deleteMessages = true
      onOpenChange(false);
    } catch (error) {
      console.error('Delete chat failed:', error);
      // TODO: Show error toast
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogPortal>
        <AlertDialogOverlay />
        <AlertDialogContent>
          <AlertDialogTitle>Удалить чат?</AlertDialogTitle>
          <AlertDialogDescription>
            {isGroup ? (
              <>Это действие необратимо. Группа будет удалена у всех участников.</>
            ) : (
              <>Это действие необратимо. Вся история сообщений и вложения будут удалены у всех участников.</>
            )}
          </AlertDialogDescription>
          <div className="flex justify-end gap-2 mt-4">
            <AlertDialogCancel disabled={isDeleting}>Отмена</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} disabled={isDeleting}>
              {isDeleting ? 'Удаление...' : 'Удалить'}
            </AlertDialogAction>
          </div>
        </AlertDialogContent>
      </AlertDialogPortal>
    </AlertDialog>
  );
}
