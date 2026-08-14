/**
 * GroupEditDialog — modern messenger-style dialog for editing a group's
 * name, avatar URL, and description. Mirrors the UX patterns from
 * Signal (compact centered dialog), WhatsApp (inline avatar + name +
 * description with character counters), and Telegram (clean footer with
 * Cancel/Save).
 *
 * Dispatches `chat.update` via the command bus. The receiver side
 * (`useChatWebSocket` `case 'chat.update'`) already handles the
 * broadcast event — this component only needs to fire the command and
 * apply an optimistic update to local state.
 *
 * Mobile-aware: on phones it goes fullscreen (`inset-0`), on desktop
 * it's a centered modal (`sm:max-w-md`).
 */

import { Camera, Check, Loader2, ImageOff } from 'lucide-react';
import { useEffect, useState } from 'react';

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
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useChat } from '@/contexts/ChatContext';
import { useWebSocketContext } from '@/contexts/WebSocketContext';
import { useIsMobile } from '@/hooks/use-mobile';
import { toast } from '@/components/ui/toast';
import type { GroupInfo } from '@/types';

interface GroupEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  chatId: string;
  groupInfo: GroupInfo;
  onSaved?: () => void;
}

const NAME_MAX = 100;
const DESCRIPTION_MAX = 500;

export function GroupEditDialog({
  open,
  onOpenChange,
  chatId,
  groupInfo,
  onSaved,
}: GroupEditDialogProps) {
  const isMobile = useIsMobile();
  const { commandBus } = useWebSocketContext();
  const { updateChat } = useChat();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sync local state from groupInfo every time the dialog opens.
  useEffect(() => {
    if (open) {
      setName(groupInfo.name || '');
      setDescription(groupInfo.description || '');
      setAvatarUrl(groupInfo.avatar || '');
      setError(null);
    }
  }, [open, groupInfo]);

  const trimmedName = name.trim();
  const trimmedDescription = description.trim();
  const trimmedAvatar = avatarUrl.trim();

  const nameChanged = trimmedName !== (groupInfo.name || '');
  const descriptionChanged = trimmedDescription !== (groupInfo.description || '');
  const avatarChanged = trimmedAvatar !== (groupInfo.avatar || '');

  const hasChanges = nameChanged || descriptionChanged || avatarChanged;
  const canSave = hasChanges && trimmedName.length > 0 && !isSaving;

  const handleSave = async () => {
    if (!commandBus) {
      setError('Нет подключения к серверу. Попробуйте позже.');
      return;
    }
    if (!trimmedName) {
      setError('Название группы не может быть пустым.');
      return;
    }

    setIsSaving(true);
    setError(null);
    try {
      const updates: Record<string, string> = {};
      if (nameChanged) updates.name = trimmedName;
      if (descriptionChanged) updates.description = trimmedDescription;
      if (avatarChanged) updates.avatar = trimmedAvatar; // empty string clears avatar

      if (Object.keys(updates).length > 0) {
        await commandBus.sendCommand(
          'chat.update',
          { chatId, updates },
          { encrypt: false },
        );

        // Optimistic update of the sidebar Chat list (name/avatar only —
        // description lives in ChatMetadata and is updated separately by
        // the chat.update event handler in useChatWebSocket).
        updateChat(chatId, {
          ...(nameChanged && { name: trimmedName }),
          ...(avatarChanged && { avatar: trimmedAvatar || undefined }),
        });
      }

      toast.success('Группа обновлена');
      onSaved?.();
      onOpenChange(false);
    } catch (err) {
      console.error('[GroupEditDialog] Failed to save group:', err);
      const message = err instanceof Error ? err.message : 'Не удалось сохранить';
      setError(message);
      toast.error('Не удалось обновить группу', message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleClose = () => {
    if (isSaving) return;
    onOpenChange(false);
  };

  const avatarInitial = (name || groupInfo.name || '?').charAt(0).toUpperCase() || '?';

  // Avatar preview — show the typed URL if valid-looking, else fallback.
  const previewSrc = trimmedAvatar || undefined;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent
        className={isMobile ? 'inset-0 max-w-none h-full rounded-none' : 'sm:max-w-md'}
        showCloseButton={!isMobile}
      >
        <DialogHeader>
          <DialogTitle>Редактировать группу</DialogTitle>
          <DialogDescription>
            Измените название, аватар и описание. Изменения видны всем участникам.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {/* Avatar preview + URL input */}
          <div className="flex flex-col items-center gap-3">
            <div className="relative group">
              <Avatar className="h-20 w-20 ring-2 ring-border">
                <AvatarImage src={previewSrc} alt={trimmedName || 'Group avatar'} />
                <AvatarFallback className="bg-primary/10 text-primary text-2xl font-semibold">
                  {avatarInitial}
                </AvatarFallback>
              </Avatar>
              {/* Camera badge — purely decorative (no file upload endpoint yet) */}
              <div className="absolute -bottom-1 -right-1 bg-primary text-primary-foreground rounded-full p-1.5 shadow-sm">
                <Camera className="h-3.5 w-3.5" />
              </div>
            </div>
            <p className="text-xs text-muted-foreground text-center max-w-[280px]">
              Вставьте URL изображения. Загрузка файлов появится позже.
            </p>
          </div>

          {/* Avatar URL */}
          <div className="space-y-1.5">
            <Label htmlFor="group-avatar-url">Ссылка на аватар</Label>
            <div className="flex gap-2">
              <Input
                id="group-avatar-url"
                type="url"
                value={avatarUrl}
                onChange={(e) => setAvatarUrl(e.target.value)}
                placeholder="https://example.com/avatar.png"
                disabled={isSaving}
              />
              {trimmedAvatar && (
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => setAvatarUrl('')}
                  disabled={isSaving}
                  title="Очистить аватар"
                >
                  <ImageOff className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>

          {/* Group name */}
          <div className="space-y-1.5">
            <Label htmlFor="group-name">
              Название группы
              <span className="text-destructive ml-0.5">*</span>
            </Label>
            <Input
              id="group-name"
              value={name}
              onChange={(e) => setName(e.target.value.slice(0, NAME_MAX))}
              placeholder="Введите название"
              maxLength={NAME_MAX}
              disabled={isSaving}
              autoFocus
            />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Обязательно для заполнения</span>
              <span>
                {name.length} / {NAME_MAX}
              </span>
            </div>
          </div>

          {/* Description */}
          <div className="space-y-1.5">
            <Label htmlFor="group-description">Описание</Label>
            <Textarea
              id="group-description"
              value={description}
              onChange={(e) => setDescription(e.target.value.slice(0, DESCRIPTION_MAX))}
              placeholder="Расскажите, о чём эта группа (необязательно)"
              rows={3}
              maxLength={DESCRIPTION_MAX}
              disabled={isSaving}
              className="resize-none"
            />
            <div className="flex justify-end text-xs text-muted-foreground">
              <span>
                {description.length} / {DESCRIPTION_MAX}
              </span>
            </div>
          </div>

          {/* Error */}
          {error && (
            <div className="text-sm text-destructive bg-destructive/10 p-3 rounded-md">
              {error}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={handleClose}
            disabled={isSaving}
          >
            Отмена
          </Button>
          <Button
            type="button"
            onClick={handleSave}
            disabled={!canSave}
          >
            {isSaving ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Сохранение...
              </>
            ) : (
              <>
                <Check className="mr-2 h-4 w-4" />
                Сохранить
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
