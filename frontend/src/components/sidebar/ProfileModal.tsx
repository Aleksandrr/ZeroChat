/**
 * ProfileModal Component
 *
 * Modal dialog for viewing and editing user profile information.
 * Shows current user details and allows updating display name.
 */

import React from 'react';
import { useCallback, useState, useEffect } from 'react';

import { User, Loader2 } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { useAuth } from '@/contexts/AuthContext';
import { userService, UserApiError } from '@/services/user';

interface ProfileModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ProfileModal({ open, onOpenChange }: ProfileModalProps) {
  const { user, updateUser } = useAuth();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset form when modal opens with current user data
  useEffect(() => {
    if (open && user) {
      setUsername(user.username || '');
      setDisplayName(user.displayName || '');
      setError(null);
    }
  }, [open, user]);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!user) {
      setError('User not authenticated');
      return;
    }

    // Validate username if provided
    if (username.length > 0 && (username.length < 3 || username.length > 50)) {
      setError('Username must be between 3 and 50 characters');
      return;
    }

    // Validate display name length
    if (displayName.length > 100) {
      setError('Display name must be 100 characters or less');
      return;
    }

    setIsSubmitting(true);

    try {
      const updatedUser = await userService.updateProfile({
        username: username.trim() || undefined,
        displayName: displayName || undefined,
      });

      // Update auth context with new user data
      updateUser(updatedUser);

      // Close modal on success
      onOpenChange(false);
    } catch (err) {
      if (err instanceof UserApiError) {
        setError(err.message);
      } else {
        setError('Failed to update profile. Please try again.');
      }
    } finally {
      setIsSubmitting(false);
    }
  }, [user, username, displayName, updateUser, onOpenChange]);

  const handleOpenChange = useCallback((newOpen: boolean) => {
    if (!isSubmitting) {
      onOpenChange(newOpen);
    }
  }, [onOpenChange, isSubmitting]);

  if (!user) {
    return null;
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Профиль</DialogTitle>
          <DialogDescription>
            Просмотр и редактирование информации о вашем аккаунте
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* User Avatar and Basic Info */}
          <div className="flex items-center gap-4">
            <Avatar className="h-16 w-16">
              {user.avatar ? (
                <AvatarImage src={user.avatar} alt={user.username} />
              ) : (
                <AvatarFallback className="bg-primary/10 text-lg">
                  <User className="h-8 w-8 text-primary" />
                </AvatarFallback>
              )}
            </Avatar>
            <div className="flex-1">
              <div className="space-y-1">
                <Label className="text-sm text-muted-foreground">Имя пользователя</Label>
                <p className="font-medium">{user.username}</p>
              </div>
              <div className="space-y-1 mt-2">
                <Label className="text-sm text-muted-foreground">Статус</Label>
                <p className="text-sm text-muted-foreground capitalize">
                  {user.status || 'offline'}
                </p>
              </div>
            </div>
          </div>

          {/* Username Edit */}
          <div className="space-y-2">
            <Label htmlFor="username">Логин (имя пользователя)</Label>
            <Input
              id="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Введите логин"
              minLength={3}
              maxLength={50}
              disabled={isSubmitting}
              className="w-full"
            />
            <p className="text-xs text-muted-foreground">
              {username.length}/50 символов
            </p>
          </div>

          {/* Display Name Edit */}
          <div className="space-y-2">
            <Label htmlFor="displayName">Имя отображения</Label>
            <Input
              id="displayName"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Введите имя отображения"
              maxLength={100}
              disabled={isSubmitting}
              className="w-full"
            />
            <p className="text-xs text-muted-foreground">
              {displayName.length}/100 символов
            </p>
          </div>

          {/* Error Message */}
          {error && (
            <div className="text-sm text-destructive bg-destructive/10 p-3 rounded-md">
              {error}
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              Отмена
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Сохранить
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

ProfileModal.displayName = 'ProfileModal';

export default ProfileModal;
