/**
 * FolderManagementDialog - Manage chat folders
 */
import { useState, useEffect, useCallback } from 'react';
import { Plus, Pencil, Trash2, Folder, X } from 'lucide-react';
import { useChat } from '@/contexts/ChatContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import type { StoredFolder } from '@/lib/messages/db';
import { getAllFolders } from '@/lib/messages/db';

interface FolderManagementDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function FolderManagementDialog({ open, onOpenChange }: FolderManagementDialogProps) {
  const { chats, createFolder, updateFolder, deleteFolder, addChatToFolder, removeChatFromFolder } = useChat();
  const [folders, setFolders] = useState<StoredFolder[]>([]);
  const [loading, setLoading] = useState(false);
  const [editingFolder, setEditingFolder] = useState<StoredFolder | null>(null);
  const [newFolderName, setNewFolderName] = useState('');
  const [newFolderColor, setNewFolderColor] = useState<string>('#3b82f6');
  const [selectedFolder, setSelectedFolder] = useState<StoredFolder | null>(null);

  // Load folders from IndexedDB every time the dialog opens, and again
  // after any local mutation (create / update / delete). Without this,
  // folders were never shown because the dialog only tracked them in local
  // React state that was never seeded.
  const reloadFolders = useCallback(async () => {
    try {
      const folders = await getAllFolders();
      setFolders(folders);
    } catch (err) {
      console.error('[FolderManagementDialog] Failed to load folders:', err);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const folders = await getAllFolders();
        if (!cancelled) setFolders(folders);
      } catch (err) {
        console.error('[FolderManagementDialog] Failed to load folders:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [open]);

  const handleCreateFolder = async () => {
    if (!newFolderName.trim()) return;
    try {
      const folderId = await createFolder(newFolderName.trim(), newFolderColor);
      // Optimistic update + reload from IndexedDB to pick up server-side fields
      const newFolder: StoredFolder = {
        id: folderId,
        name: newFolderName.trim(),
        color: newFolderColor,
        order: folders.length,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      setFolders(prev => [...prev, newFolder]);
      setNewFolderName('');
      setNewFolderColor('#3b82f6');
      void reloadFolders();
    } catch (error) {
      console.error('Failed to create folder:', error);
    }
  };

  const handleUpdateFolder = async () => {
    if (!editingFolder) return;
    try {
      await updateFolder(editingFolder.id, {
        name: newFolderName.trim() || editingFolder.name,
        color: newFolderColor,
      });
      setFolders(prev => prev.map(f =>
        f.id === editingFolder.id
          ? { ...f, name: newFolderName.trim() || f.name, color: newFolderColor, updatedAt: Date.now() }
          : f
      ));
      setEditingFolder(null);
      setNewFolderName('');
      setNewFolderColor('#3b82f6');
      void reloadFolders();
    } catch (error) {
      console.error('Failed to update folder:', error);
    }
  };

  const handleDeleteFolder = async (folderId: string) => {
    try {
      await deleteFolder(folderId);
      setFolders(prev => prev.filter(f => f.id !== folderId));
      if (selectedFolder?.id === folderId) {
        setSelectedFolder(null);
      }
      void reloadFolders();
    } catch (error) {
      console.error('Failed to delete folder:', error);
    }
  };

  const handleAddChatToFolder = async (folderId: string, chatId: string) => {
    try {
      await addChatToFolder(folderId, chatId);
      // Update local chat state
      // In real app, this would be synced via command_event
    } catch (error) {
      console.error('Failed to add chat to folder:', error);
    }
  };

  const handleRemoveChatFromFolder = async (folderId: string, chatId: string) => {
    try {
      await removeChatFromFolder(folderId, chatId);
    } catch (error) {
      console.error('Failed to remove chat from folder:', error);
    }
  };

  const startEditing = (folder: StoredFolder) => {
    setEditingFolder(folder);
    setNewFolderName(folder.name);
    setNewFolderColor(folder.color || '#3b82f6');
  };

  const cancelEditing = () => {
    setEditingFolder(null);
    setNewFolderName('');
    setNewFolderColor('#3b82f6');
  };

  // Filter chats that are not in favorites or system
  const assignableChats = chats.filter(chat =>
    chat.type !== 'favorites' && !chat.isSystem
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Управление папками</DialogTitle>
          <DialogDescription>
            Создавайте и управляйте папками для организации чатов
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {/* Create/Edit Folder */}
          <div className="flex gap-2 items-end">
            <div className="flex-1 space-y-2">
              <Label htmlFor="folderName">Название папки</Label>
              <Input
                id="folderName"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                placeholder="Новая папка"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="folderColor">Цвет</Label>
              <Input
                id="folderColor"
                type="color"
                value={newFolderColor}
                onChange={(e) => setNewFolderColor(e.target.value)}
                className="w-20 h-10"
              />
            </div>
            <div className="flex gap-2">
              {editingFolder ? (
                <>
                  <Button onClick={handleUpdateFolder} size="sm">
                    Сохранить
                  </Button>
                  <Button onClick={cancelEditing} variant="outline" size="sm">
                    Отмена
                  </Button>
                </>
              ) : (
                <Button onClick={handleCreateFolder} size="sm">
                  <Plus className="w-4 h-4 mr-1" />
                  Создать
                </Button>
              )}
            </div>
          </div>

          {/* Folders List */}
          <div className="space-y-2">
            <h3 className="text-sm font-semibold">Папки</h3>
            {folders.length === 0 ? (
              <p className="text-sm text-muted-foreground">Нет созданных папок</p>
            ) : (
              <div className="space-y-2">
                {folders.map((folder) => (
                  <div
                    key={folder.id}
                    className={`flex items-center gap-2 p-3 rounded-lg border ${
                      selectedFolder?.id === folder.id ? 'border-primary bg-primary/5' : 'border-border'
                    }`}
                    onClick={() => setSelectedFolder(folder)}
                  >
                    <div
                      className="w-4 h-4 rounded-full shrink-0"
                      style={{ backgroundColor: folder.color || '#3b82f6' }}
                    />
                    <span className="flex-1 font-medium">{folder.name}</span>
                    <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => startEditing(folder)}
                      >
                        <Pencil className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleDeleteFolder(folder.id)}
                      >
                        <Trash2 className="w-4 h-4 text-destructive" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Assign Chats to Folder */}
          {selectedFolder && (
            <div className="space-y-2">
              <h3 className="text-sm font-semibold">
                Чаты в папке "{selectedFolder.name}"
              </h3>
              <div className="flex flex-wrap gap-2">
                {assignableChats.map((chat) => {
                  const isInFolder = chat.folderId === selectedFolder.id;
                  return (
                    <Button
                      key={chat.id}
                      variant={isInFolder ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => {
                        if (isInFolder) {
                          handleRemoveChatFromFolder(selectedFolder.id, chat.id);
                        } else {
                          handleAddChatToFolder(selectedFolder.id, chat.id);
                        }
                      }}
                    >
                      {chat.name || 'Безымянный чат'}
                      {isInFolder && <X className="w-3 h-3 ml-1" />}
                    </Button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
