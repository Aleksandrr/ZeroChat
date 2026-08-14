import { Check, Clock, Copy, Crown, Link as LinkIcon, Loader2, Pencil, Settings, Shield, UserMinus, Users } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useAuth } from '@/contexts';
import { useChat } from '@/contexts/ChatContext';
import { pluralize } from '@/lib/utils';
import { createInviteLink, getGroupInfo, leaveGroup, chatService } from '@/services/chat';
import { toast } from '@/components/ui/toast';
import type { GroupInfo as GroupInfoType, HistoryAccess, User, UserRole } from '@/types';

import { GroupEditDialog } from './GroupEditDialog';
import { GroupMemberItem } from './GroupMemberItem';

interface GroupChatInfoProps {
  chatId: string;
  onClose: () => void;
}

const historyAccessLabels: Record<HistoryAccess, string> = {
  ALL: 'Вся история',
  FROM_NOW: 'С момента вступления',
  NONE: 'Нет доступа',
};

export function GroupChatInfo({ chatId, onClose }: GroupChatInfoProps) {
  const { user } = useAuth();
  const { openContactCard, addParticipant, removeParticipant, updateParticipantRole } = useChat();
  const [groupInfo, setGroupInfo] = useState<GroupInfoType | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [creatingLink, setCreatingLink] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [showAddParticipant, setShowAddParticipant] = useState(false);
  const [newParticipantUsername, setNewParticipantUsername] = useState('');
  const [addingParticipant, setAddingParticipant] = useState(false);
  const [searchingUser, setSearchingUser] = useState(false);
  const [foundUser, setFoundUser] = useState<User | null>(null);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  // AlertDialog state — replaces native confirm() for leave / remove actions
  const [confirmDialog, setConfirmDialog] = useState<{
    open: boolean;
    title: string;
    description: string;
    onConfirm: () => void | Promise<void>;
  }>({ open: false, title: '', description: '', onConfirm: () => {} });

  const loadGroupInfo = useCallback(async () => {
    try {
      const info = await getGroupInfo(chatId);
      setGroupInfo(info);
    } catch (error) {
      console.error('Failed to load group info:', error);
    } finally {
      setLoading(false);
    }
  }, [chatId]);

  useEffect(() => {
    void loadGroupInfo();
  }, [loadGroupInfo]);

  const handleCopyInviteLink = async () => {
    if (!groupInfo?.inviteCode) {
      setCreatingLink(true);
      try {
        const result = await createInviteLink(chatId, 24);
        await navigator.clipboard.writeText(result.data.inviteUrl);
      } catch (error) {
        console.error('Failed to create invite link:', error);
      } finally {
        setCreatingLink(false);
      }
    } else {
      const link = `${window.location.origin}/invite/${groupInfo.inviteCode}`;
      await navigator.clipboard.writeText(link);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleLeave = async () => {
    setLeaving(true);
    try {
      await leaveGroup(chatId);
      onClose();
    } catch (error) {
      console.error('Failed to leave group:', error);
      const message = error instanceof Error ? error.message : 'Не удалось покинуть группу';
      toast.error('Ошибка', message);
    } finally {
      setLeaving(false);
    }
  };

  const handleSearchUser = async () => {
    if (!newParticipantUsername.trim()) return;

    setSearchingUser(true);
    try {
      const results = await chatService.searchUsers(newParticipantUsername.trim());
      const found = results[0];
      if (found) {
        setFoundUser({
          id: found.id,
          username: found.username,
          displayName: found.displayName || found.username,
          avatar: found.avatar,
          status: found.status || 'offline',
        } as User);
      } else {
        setFoundUser(null);
      }
    } catch (error) {
      console.error('Failed to search user:', error);
      setFoundUser(null);
    } finally {
      setSearchingUser(false);
    }
  };

  const currentUserRole = groupInfo?.participants.find(
    p => p.userId === user?.id
  )?.role as UserRole | undefined;

  const isAdmin = currentUserRole === 'OWNER' || currentUserRole === 'ADMIN';

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full p-4">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!groupInfo) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-4">
        <p className="text-muted-foreground">Не удалось загрузить информацию о группе</p>
      </div>
    );
  }

  // Reload group info after a successful edit (called from GroupEditDialog).
  const handleEditSaved = () => {
    void loadGroupInfo();
  };

  // Role change via command bus — invoked by GroupMemberItem dropdown.
  const handleRoleChange = async (userId: string, newRole: UserRole) => {
    try {
      await updateParticipantRole(chatId, userId, newRole);
      toast.success('Роль обновлена');
      void loadGroupInfo();
    } catch (err) {
      console.error('[GroupChatInfo] Failed to update role:', err);
      const message = err instanceof Error ? err.message : 'Не удалось обновить роль';
      toast.error('Ошибка', message);
    }
  };

  // Remove a participant via command bus.
  const handleRemoveParticipant = async (userId: string) => {
    try {
      await removeParticipant(chatId, userId);
      toast.success('Участник исключён');
      void loadGroupInfo();
    } catch (err) {
      console.error('[GroupChatInfo] Failed to remove participant:', err);
      const message = err instanceof Error ? err.message : 'Не удалось исключить участника';
      toast.error('Ошибка', message);
    }
  };

  // Add a participant via command bus (after a user-search step).
  const handleAddParticipant = async () => {
    if (!foundUser) return;
    setAddingParticipant(true);
    try {
      await addParticipant(chatId, foundUser.id, 'MEMBER');
      toast.success('Участник добавлен');
      setShowAddParticipant(false);
      setNewParticipantUsername('');
      setFoundUser(null);
      void loadGroupInfo();
    } catch (err) {
      console.error('[GroupChatInfo] Failed to add participant:', err);
      const message = err instanceof Error ? err.message : 'Не удалось добавить участника';
      toast.error('Ошибка', message);
    } finally {
      setAddingParticipant(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Заголовок — pencil opens the edit dialog for admins */}
      <div className="p-4 border-b">
        <div className="flex items-center gap-3">
          <Avatar className="h-14 w-14">
            <AvatarImage src={groupInfo.avatar} alt={groupInfo.name} />
            <AvatarFallback className="bg-primary/10 text-primary text-lg">
              {groupInfo.name.charAt(0).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="font-semibold text-lg truncate">{groupInfo.name}</h2>
              {isAdmin && (
                <button
                  onClick={() => setEditDialogOpen(true)}
                  className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
                  title="Редактировать"
                  aria-label="Редактировать группу"
                >
                  <Pencil className="h-4 w-4" />
                </button>
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              {/* U6: proper Russian pluralization for participant count */}
              {groupInfo.participants.length}{' '}
              {pluralize(groupInfo.participants.length, ['участник', 'участника', 'участников'])}
            </p>
            {groupInfo.description && (
              <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{groupInfo.description}</p>
            )}
          </div>
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-4 space-y-4">
          {/* Настройки группы */}
          <div className="space-y-3">
            <h3 className="text-sm font-medium flex items-center gap-2">
              <Settings className="h-4 w-4" />
              Настройки
            </h3>

            <div className="bg-muted/50 rounded-lg p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground flex items-center gap-2">
                  <Shield className="h-4 w-4" />
                  Одобрение на вступление
                </span>
                <Badge variant={groupInfo.requireApproval ? 'default' : 'secondary'}>
                  {groupInfo.requireApproval ? 'Да' : 'Нет'}
                </Badge>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground flex items-center gap-2">
                  <Clock className="h-4 w-4" />
                  История чата
                </span>
                <span className="text-sm">
                  {historyAccessLabels[groupInfo.historyAccess] ?? groupInfo.historyAccess}
                </span>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground flex items-center gap-2">
                  <Crown className="h-4 w-4" />
                  Создатель
                </span>
                <span className="text-sm">
                  {groupInfo.createdBy.username}
                </span>
              </div>
            </div>
          </div>

          <Separator />

          {/* Ссылка-приглашение */}
          <div className="space-y-3">
            <h3 className="text-sm font-medium flex items-center gap-2">
              <LinkIcon className="h-4 w-4" />
              Приглашение
            </h3>

            <Button
              variant="outline"
              className="w-full justify-start"
              onClick={handleCopyInviteLink}
              disabled={creatingLink}
            >
              {creatingLink ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : copied ? (
                <Check className="h-4 w-4 mr-2 text-green-500" />
              ) : (
                <Copy className="h-4 w-4 mr-2" />
              )}
              {copied ? 'Скопировано!' : 'Скопировать ссылку'}
            </Button>
          </div>

          <Separator />

          {/* Участники */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium flex items-center gap-2">
                <Users className="h-4 w-4" />
                Участники ({groupInfo.participants.length})
              </h3>
              {isAdmin && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowAddParticipant(true)}
                  className="text-xs"
                >
                  + Добавить
                </Button>
              )}
            </div>

            <div className="space-y-1">
              {groupInfo.participants.map((participant) => (
                <GroupMemberItem
                  key={participant.userId}
                  participant={participant}
                  isCurrentUser={participant.userId === user?.id}
                  isAdmin={isAdmin}
                  canManage={currentUserRole === 'OWNER' && participant.role !== 'OWNER' && participant.userId !== user?.id}
                  onRoleChange={(role: UserRole) => {
                    void handleRoleChange(participant.userId, role);
                  }}
                  onRemove={() => {
                    // P0-9: AlertDialog replaces native confirm()
                    setConfirmDialog({
                      open: true,
                      title: 'Исключить участника?',
                      description: `Исключить ${participant.username} из группы?`,
                      onConfirm: () => { void handleRemoveParticipant(participant.userId); },
                    });
                  }}
                  onOpenContactCard={openContactCard}
                />
              ))}
            </div>
          </div>
        </div>
      </ScrollArea>

      {/* Dialog: Edit Group (name/avatar/description) */}
      <GroupEditDialog
        open={editDialogOpen}
        onOpenChange={setEditDialogOpen}
        chatId={chatId}
        groupInfo={groupInfo}
        onSaved={handleEditSaved}
      />

      {/* Dialog: Add Participant */}
      {showAddParticipant && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center">
          <div className="bg-background rounded-lg shadow-xl p-6 w-full max-w-md mx-4">
            <h3 className="text-lg font-semibold mb-4">Добавить участника</h3>

            <div className="space-y-4">
              <div>
                <label htmlFor="new-participant-username" className="text-sm font-medium mb-1 block">
                  Имя пользователя
                </label>
                <div className="flex gap-2">
                  <Input
                    id="new-participant-username"
                    value={newParticipantUsername}
                    onChange={(e) => setNewParticipantUsername(e.target.value)}
                    placeholder="username"
                    className="flex-1"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        void handleSearchUser();
                      }
                    }}
                  />
                  <Button
                    onClick={handleSearchUser}
                    disabled={!newParticipantUsername.trim() || searchingUser}
                    variant="outline"
                  >
                    {searchingUser ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      'Найти'
                    )}
                  </Button>
                </div>
              </div>

              {foundUser && (
                <div className="flex items-center gap-3 p-3 border rounded-lg">
                  <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
                    <span className="text-sm font-medium">
                      {foundUser.username.charAt(0).toUpperCase()}
                    </span>
                  </div>
                  <div className="flex-1">
                    <p className="font-medium text-sm">{foundUser.username}</p>
                    <p className="text-xs text-muted-foreground">
                      {foundUser.displayName || foundUser.username}
                    </p>
                  </div>
                  <Button
                    onClick={handleAddParticipant}
                    disabled={addingParticipant}
                    size="sm"
                  >
                    {addingParticipant ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      'Добавить'
                    )}
                  </Button>
                </div>
              )}
            </div>

            <div className="flex justify-end mt-6">
              <Button
                variant="ghost"
                onClick={() => {
                  setShowAddParticipant(false);
                  setNewParticipantUsername('');
                  setFoundUser(null);
                }}
              >
                Отмена
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Кнопка выхода */}
      <div className="p-4 border-t">
        <Button
          variant="destructive"
          className="w-full"
          onClick={() => {
            // P0-9: AlertDialog replaces native confirm()
            setConfirmDialog({
              open: true,
              title: 'Покинуть группу?',
              description: 'Вы уверены, что хотите покинуть эту группу?',
              onConfirm: () => { void handleLeave(); },
            });
          }}
          disabled={leaving}
        >
          {leaving ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <UserMinus className="h-4 w-4 mr-2" />
          )}
          Покинуть группу
        </Button>
      </div>

      {/* AlertDialog — заменяет native confirm() для leave/remove */}
      <AlertDialog
        open={confirmDialog.open}
        onOpenChange={(open) => setConfirmDialog(prev => ({ ...prev, open }))}
      >
        <AlertDialogContent>
          <AlertDialogTitle>{confirmDialog.title}</AlertDialogTitle>
          <AlertDialogDescription>{confirmDialog.description}</AlertDialogDescription>
          <div className="flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2 mt-4">
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const fn = confirmDialog.onConfirm;
                setConfirmDialog(prev => ({ ...prev, open: false }));
                void fn();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Подтвердить
            </AlertDialogAction>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
