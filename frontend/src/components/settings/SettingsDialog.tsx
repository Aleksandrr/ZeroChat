import { zodResolver } from '@hookform/resolvers/zod';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import { Smartphone,X, Folder } from 'lucide-react';
import {
  Bell,
  Check as CheckIcon,
  Key,
  Loader2,
  Lock,
  LogOut,
  Monitor as MonitorIcon,
  Moon,
  Palette,
  Shield as ShieldIcon,
  Sun,
  User} from 'lucide-react';
import { useTheme as useNextTheme } from 'next-themes';
import type * as React from 'react';
import { useEffect,useState } from 'react';
import { useForm } from 'react-hook-form';
import { useAuth } from '@/contexts/AuthContext';

import { DeviceList } from '@/components/devices';
import { FolderManagementDialog } from '@/components/settings/FolderManagementDialog';
import { SafetyNumbersPanel } from '@/components/settings/SafetyNumbersPanel';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { toast } from '@/components/ui/toast';
import { getAccessToken } from '@/services/auth';
import { useDevices } from '@/hooks/use-devices';
import { useIsMobile } from '@/hooks/use-mobile';
import * as signal from '@/lib/signal';
import { type SettingsInput,settingsSchema } from '@/lib/validation';
import type { ThemeMode, UserSettings } from '@/types';

// API base URL — mirrors services/auth/api.ts (already includes /api prefix)
const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001/api';

export type SettingsTab = 'appearance' | 'notifications' | 'privacy' | 'account' | 'security' | 'devices' | 'folders';

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: UserSettings;
  onSettingsChange: (settings: UserSettings) => void;
  onDeviceDelete?: () => void;
}

function CustomDialog({ open, onOpenChange, children, title = 'Settings', description = 'Manage app settings' }: { open: boolean; onOpenChange: (o: boolean) => void; children: React.ReactNode; title?: string; description?: string }) {
  const isMobile = useIsMobile();
  
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 bg-black/50 z-50 animate-in fade-in-0" />
        <DialogPrimitive.Content
          className={`fixed z-50 bg-background shadow-xl outline-none animate-in fade-in-0 zoom-in-95 ${
            isMobile
              ? 'inset-0 rounded-none'
              : 'rounded-lg top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2'
          }`}
          style={isMobile ? {} : {
            width: '800px',
            height: '600px',
            maxWidth: 'calc(100vw - 40px)',
            maxHeight: 'calc(100vh - 40px)',
          }}
        >
          <DialogPrimitive.Title>
            <VisuallyHidden>{title}</VisuallyHidden>
          </DialogPrimitive.Title>
          <DialogPrimitive.Description>
            <VisuallyHidden>{description}</VisuallyHidden>
          </DialogPrimitive.Description>
          {children}
          <DialogPrimitive.Close className="absolute top-3 right-3 rounded-xs opacity-70 transition-opacity hover:opacity-100 focus:outline-none">
            <X className="h-4 w-4" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function SettingsDialog({
  open,
  onOpenChange,
  settings,
  onSettingsChange,
  onDeviceDelete
}: SettingsDialogProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('appearance');
  const { resolvedTheme, setTheme: setNextTheme } = useNextTheme();
  const isMobile = useIsMobile();
  const { user, handleFullLogout } = useAuth();
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [showLogoutAllConfirm, setShowLogoutAllConfirm] = useState(false);
  
   // Form setup with React Hook Form
   const {
     watch,
     setValue,
     reset,
   } = useForm<SettingsInput>({
    resolver: zodResolver(settingsSchema),
    defaultValues: {
      theme: settings.theme,
      notifications: settings.notifications,
      sound: settings.sound,
      showOnlineStatus: settings.showOnlineStatus,
      readReceipts: settings.readReceipts,
      autoSaveMedia: settings.autoSaveMedia,
    },
  });

   // Watch form values
   const formTheme = watch('theme');
   const formNotifications = watch('notifications');
   const formSound = watch('sound');
   const formShowOnlineStatus = watch('showOnlineStatus');
   const formReadReceipts = watch('readReceipts');

  // Sync form with props when dialog opens
  useEffect(() => {
    if (open) {
      reset({
        theme: settings.theme,
        notifications: settings.notifications,
        sound: settings.sound,
        showOnlineStatus: settings.showOnlineStatus,
        readReceipts: settings.readReceipts,
        autoSaveMedia: settings.autoSaveMedia,
      });
    }
  }, [open, settings, reset]);

  // Handle settings change with form
  const updateSettings = (key: keyof SettingsInput, value: unknown) => {
    setValue(key, value as SettingsInput[keyof SettingsInput], { shouldDirty: true });
    onSettingsChange({
      ...settings,
      [key]: value,
    });
    
    // Sync theme with next-themes when theme changes
    if (key === 'theme') {
      setNextTheme(value as ThemeMode);
    }
  };
  
  // Use the devices hook for device management
  const {
    devices,
    currentDeviceId,
    isLoading: devicesLoading,
    loadDevices,
    removeDeviceById,
    renameDevice,
  } = useDevices({ autoLoad: false });
  
  // Reset to appearance tab when dialog opens
  useEffect(() => {
    if (open) {
      setActiveTab('appearance');
    }
  }, [open]);
  
   // Load devices when opening devices tab
   useEffect(() => {
     if (activeTab === 'devices' && open) {
       void loadDevices();
     }
   }, [activeTab, open, loadDevices]);

  const handleDeleteDevice = async (deviceId: string) => {
    try {
      await removeDeviceById(deviceId);
      
      // Clear local Signal data associated with the removed device
      if (signal.isSignalInitialized()) {
        const deviceIdNum = parseInt(deviceId, 10);
        if (!isNaN(deviceIdNum)) {
          await signal.unlinkDevice(deviceIdNum);
        }
      }
      
      if (onDeviceDelete) {
        onDeviceDelete();
      }
    } catch (error) {
      console.error('Failed to delete device:', error);
      alert('Failed to delete device');
    }
  };

  const handleRenameDevice = async (deviceId: string, newName: string) => {
    try {
      await renameDevice(deviceId, newName);
    } catch (error) {
      console.error('Failed to rename device:', error);
      throw error;
    }
  };

  /**
   * Выйти из всех устройств: DELETE /api/auth/sessions (revoke all refresh
   * tokens for this user) followed by local handleFullLogout (clears Signal
   * state, access tokens, and broadcasts logout to other tabs).
   */
  const handleLogoutAllDevices = async () => {
    setShowLogoutAllConfirm(false);
    setIsLoggingOut(true);
    try {
      const token = getAccessToken();
      const response = await fetch(`${API_BASE_URL}/auth/sessions`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        credentials: 'include',
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error((err as { message?: string })?.message || `HTTP ${response.status}`);
      }
      await handleFullLogout();
      toast.success('Вы вышли из всех устройств');
    } catch (err) {
      console.error('[SettingsDialog] logoutAllDevices failed:', err);
      toast.error('Не удалось выйти', err instanceof Error ? err.message : undefined);
    } finally {
      setIsLoggingOut(false);
    }
  };

  // Toggle button styles
  const getToggleClass = (enabled: boolean) => {
    if (enabled) {
      return 'bg-primary dark:bg-blue-500';
    }
    return isDark ? 'bg-[#3a3a3a]' : 'bg-gray-200';
  };

  const getToggleKnobClass = (enabled: boolean) => {
    if (enabled) {
      return 'left-5 bg-white';
    }
    return isDark ? 'left-0.5 bg-gray-400' : 'left-0.5 bg-gray-500';
  };

  const themeOptions: { value: ThemeMode; label: string; icon: React.ReactNode; description: string }[] = [
    { value: 'light', label: '\u0421\u0432\u0435\u0442\u043b\u0430\u044f', icon: <Sun className="w-5 h-5" />, description: '\u042f\u0440\u043a\u0438\u0439 \u0440\u0435\u0436\u0438\u043c' },
    { value: 'dark', label: '\u0422\u0451\u043c\u043d\u0430\u044f', icon: <Moon className="w-5 h-5" />, description: '\u0422\u0451\u043c\u043d\u044b\u0439 \u0440\u0435\u0436\u0438\u043c' },
    { value: 'system', label: '\u0421\u0438\u0441\u0442\u0435\u043c\u043d\u0430\u044f', icon: <MonitorIcon className="w-5 h-5" />, description: '\u041a\u0430\u043a \u0432 \u0441\u0438\u0441\u0442\u0435\u043c\u0435' },
  ];

  const navItems: { id: SettingsTab; label: string; icon: React.ElementType }[] = [
    { id: 'appearance', label: '\u0412\u043d\u0435\u0448\u043d\u0439 \u0432\u0438\u0434', icon: Palette },
    { id: 'notifications', label: '\u0423\u0432\u0435\u0434\u043e\u043c\u043b\u0435\u043d\u0438\u044f', icon: Bell },
    { id: 'privacy', label: '\u041f\u0440\u0438\u0432\u0430\u0442\u043d\u043e\u0441\u0442\u044c', icon: Lock },
    { id: 'account', label: '\u0410\u043a\u043a\u0430\u0443\u043d\u0442', icon: User },
    { id: 'security', label: '\u0411\u0435\u0437\u043e\u043f\u0430\u0441\u043d\u043e\u0441\u0442\u044c', icon: Key },
    { id: 'devices', label: '\u0423\u0441\u0442\u0440\u043e\u0439\u0441\u0442\u0432\u0430', icon: Smartphone },
    { id: 'folders', label: '\u041f\u0430\u043f\u043a\u0438', icon: Folder },
  ];

  const isDark = resolvedTheme === 'dark';
  const iconBgLight = isDark ? 'bg-gray-800' : 'bg-gray-100';
  const iconBgSelected = isDark ? 'bg-primary/20' : 'bg-primary/10';
  const iconTextSelected = 'text-primary';
  const iconTextDefault = 'text-muted-foreground';
  const itemSelectedBg = isDark ? 'bg-primary/20' : 'bg-primary/10';

  const renderContent = () => {
    switch (activeTab) {
      case 'appearance':
        return (
          <div className="space-y-3">
            <h3 className="text-sm font-semibold">{'\u0422\u0435\u043c\u0430 \u043e\u0444\u043e\u0440\u043c\u043b\u0435\u043d\u0438\u044f'}</h3>
            <RadioGroup value={formTheme} onValueChange={(v) => updateSettings('theme', v as ThemeMode)} className="space-y-2">
              {themeOptions.map((opt) => {
                const isSelected = formTheme === opt.value;

                return (
                  <div
                    key={opt.value}
                    role="button"
                    tabIndex={0}
                    className={`flex items-center gap-3 p-3 rounded-md border cursor-pointer transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 ${isSelected ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted/50'}`}
                    onClick={() => updateSettings('theme', opt.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        updateSettings('theme', opt.value);
                      }
                    }}
                  >
                    <RadioGroupItem value={opt.value} id={`t-${opt.value}`} className="sr-only" />
                    <div className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${isSelected ? iconBgSelected : iconBgLight}`}>
                      <span className={isSelected ? iconTextSelected : iconTextDefault}>{opt.icon}</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <Label htmlFor={`t-${opt.value}`} className="cursor-pointer text-sm font-medium block">{opt.label}</Label>
                      <p className="text-xs text-muted-foreground truncate">{opt.description}</p>
                    </div>
                    {isSelected && <CheckIcon className={`w-4 h-4 ${iconTextSelected} shrink-0`} />}
                  </div>
                );
              })}
            </RadioGroup>
          </div>
        );
      case 'notifications':
        return (
          <div className="space-y-3">
            <h3 className="text-sm font-semibold">{'\u0423\u0432\u0435\u0434\u043e\u043c\u043b\u0435\u043d\u0438\u044f'}</h3>
            <div className="space-y-2">
              <div className="flex items-center justify-between p-3 rounded-md border border-border">
                <div className="flex-1 min-w-0 pr-4">
                  <Label className="text-sm font-medium block">{'\u0417\u0432\u0443\u043a\u043e\u0432\u044b\u0435 \u0443\u0432\u0435\u0434\u043e\u043c\u043b\u0435\u043d\u0438\u044f'}</Label>
                  <p className="text-xs text-muted-foreground truncate">{'\u0412\u043e\u0441\u043f\u0440\u043e\u0438\u0437\u0432\u043e\u0434\u0438\u0442\u044c \u0437\u0432\u0443\u043a \u043f\u0440\u0438 \u043d\u043e\u0432\u044b\u0445 \u0441\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u044f\u0445'}</p>
                </div>
                <button
                  onClick={() => updateSettings('sound', !formSound)}
                  className={`w-10 h-5.5 rounded-full transition-colors relative shrink-0 ${getToggleClass(formSound)}`}
                >
                  <span className={`absolute top-0.5 w-4.5 h-4.5 rounded-full shadow transition-transform ${getToggleKnobClass(formSound)}`} />
                </button>
              </div>
              <div className="flex items-center justify-between p-3 rounded-md border border-border">
                <div className="flex-1 min-w-0 pr-4">
                  <Label className="text-sm font-medium block">Push-{'\u0443\u0432\u0435\u0434\u043e\u043c\u043b\u0435\u043d\u0438\u044f'}</Label>
                  <p className="text-xs text-muted-foreground truncate">{'\u041f\u043e\u043a\u0430\u0437\u044b\u0432\u0430\u0442\u044c \u0443\u0432\u0435\u0434\u043e\u043c\u043b\u0435\u043d\u0438\u044f \u043d\u0430 \u0443\u0441\u0442\u0440\u043e\u0439\u0441\u0442\u0432\u0435'}</p>
                </div>
                <button
                  onClick={() => updateSettings('notifications', !formNotifications)}
                  className={`w-10 h-5.5 rounded-full transition-colors relative shrink-0 ${getToggleClass(formNotifications)}`}
                >
                  <span className={`absolute top-0.5 w-4.5 h-4.5 rounded-full shadow transition-transform ${getToggleKnobClass(formNotifications)}`} />
                </button>
              </div>
            </div>
          </div>
        );
      case 'privacy':
        return (
          <div className="space-y-3">
            <h3 className="text-sm font-semibold">{'\u041a\u043e\u043d\u0444\u0438\u0434\u0435\u043d\u0446\u0438\u0430\u043b\u044c\u043d\u043e\u0441\u0442\u044c'}</h3>
            <div className="space-y-2">
              <div className="flex items-center justify-between p-3 rounded-md border border-border">
                <div className="flex-1 min-w-0 pr-4">
                  <Label className="text-sm font-medium block">{'\u0421\u0442\u0430\u0442\u0443\u0441 \u0432 \u0441\u0435\u0442\u0438'}</Label>
                  <p className="text-xs text-muted-foreground truncate">{'\u041f\u043e\u043a\u0430\u0437\u044b\u0432\u0430\u0442\u044c \u0434\u0440\u0443\u0433\u0438\u043c, \u043a\u043e\u0433\u0434\u0430 \u0432\u044b \u043e\u043d\u043b\u0430\u0439\u043d'}</p>
                </div>
                <button onClick={() => updateSettings('showOnlineStatus', !formShowOnlineStatus)} className={`w-10 h-5.5 rounded-full transition-colors relative shrink-0 ${getToggleClass(formShowOnlineStatus)}`}>
                  <span className={`absolute top-0.5 w-4.5 h-4.5 rounded-full shadow transition-transform ${getToggleKnobClass(formShowOnlineStatus)}`} />
                </button>
              </div>
              <div className="flex items-center justify-between p-3 rounded-md border border-border">
                <div className="flex-1 min-w-0 pr-4">
                  <Label className="text-sm font-medium block">{'\u041e\u0442\u0447\u0451\u0442\u044b \u043e \u043f\u0440\u043e\u0447\u0442\u0435\u043d\u0438\u0438'}</Label>
                  <p className="text-xs text-muted-foreground truncate">{'\u041e\u0442\u043f\u0440\u0430\u0432\u043b\u044f\u0442\u044c \u0433\u0430\u043b\u043e\u0447\u043a\u0438 \u043e \u043f\u0440\u043e\u0447\u0442\u0435\u043d\u0438\u0438'}</p>
                </div>
                <button onClick={() => updateSettings('readReceipts', !formReadReceipts)} className={`w-10 h-5.5 rounded-full transition-colors relative shrink-0 ${getToggleClass(formReadReceipts)}`}>
                  <span className={`absolute top-0.5 w-4.5 h-4.5 rounded-full shadow transition-transform ${getToggleKnobClass(formReadReceipts)}`} />
                </button>
              </div>
            </div>
          </div>
        );
      case 'account':
        return (
          <div className="space-y-3">
            <h3 className="text-sm font-semibold">{'\u0410\u043a\u043a\u0430\u0443\u043d\u0442'}</h3>
            <div className="p-3 rounded-md border border-border">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-full bg-secondary flex items-center justify-center shrink-0"><User className="w-6 h-6 text-secondary-foreground" /></div>
                <div className="flex-1 min-w-0">
                  <h3 className="font-medium text-sm">{'\u0412\u0430\u0448 \u043f\u0440\u043e\u0444\u0438\u043b\u044c'}</h3>
                  <p className="text-xs text-muted-foreground truncate">{user?.username ?? ""}</p>
                </div>
                <Button variant="outline" size="sm" className="shrink-0" disabled>{'\u0418\u0437\u043c\u0435\u043d\u0438\u0442\u044c'}</Button>
              </div>
            </div>
          </div>
        );
      case 'security':
        return (
          <div className="space-y-3">
            <h3 className="text-sm font-semibold">{'\u0411\u0435\u0437\u043e\u043f\u0430\u0441\u043d\u043e\u0441\u0442\u044c'}</h3>
            <div className="space-y-2">
              <div className="flex items-center justify-between p-3 rounded-md border border-border opacity-50">
                <div className="flex items-center gap-3 flex-1 min-w-0 pr-4">
                  <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center shrink-0"><Smartphone className="w-4 h-4 text-secondary-foreground" /></div>
                  <div className="min-w-0"><h4 className="text-sm font-medium">2FA <span className="text-xs text-muted-foreground">(скоро)</span></h4><p className="text-xs text-muted-foreground truncate">{'\u0414\u043e\u043f\u043e\u043b\u043d\u0438\u0442\u0435\u043b\u044c\u043d\u0430\u044f \u0437\u0430\u0449\u0438\u0442\u0430'}</p></div>
                </div>
                <span className="text-sm text-primary font-medium shrink-0">{'\u041d\u0430\u0441\u0442\u0440\u043e\u0438\u0442\u044c'}</span>
              </div>
              <div className="flex items-center justify-between p-3 rounded-md border border-border opacity-50">
                <div className="flex items-center gap-3 flex-1 min-w-0 pr-4">
                  <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center shrink-0"><Key className="w-4 h-4 text-secondary-foreground" /></div>
                  <div className="min-w-0"><h4 className="text-sm font-medium">{'\u0421\u0435\u0441\u0441\u0438\u0438'}</h4><p className="text-xs text-muted-foreground truncate">{'\u0423\u043f\u0440\u0430\u0432\u043b\u0435\u043d\u0438\u0435 \u0441\u0435\u0441\u0441\u0438\u044f\u043c\u0438'}</p></div>
                </div>
                <span className="text-sm text-primary font-medium shrink-0">{'\u041f\u0440\u043e\u0441\u043c\u043e\u0442\u0440'}</span>
              </div>
              <div className="flex items-center justify-between p-3 rounded-md border border-green-500/30 bg-green-500/10">
                <div className="flex items-center gap-3 flex-1 min-w-0 pr-4">
                  <div className="w-8 h-8 rounded-full bg-green-500/20 flex items-center justify-center shrink-0"><ShieldIcon className="w-4 h-4 text-green-600 dark:text-green-400" /></div>
                  <div className="min-w-0"><h4 className="text-sm font-medium">E2E {'\u0448\u0438\u0444\u0440\u043e\u0432\u0430\u043d\u0438\u0435'}</h4><p className="text-xs text-muted-foreground truncate">{'\u0412\u0441\u0435 \u0441\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u044f \u0437\u0430\u0449\u0438\u0449\u0435\u043d\u044b'}</p></div>
                </div>
                <span className="text-sm text-green-600 dark:text-green-400 font-medium shrink-0">{'\u0412\u043a\u043b\u044e\u0447\u0435\u043d\u043e'}</span>
              </div>

              {/* Safety Numbers — contact verification (Signal-style safety number per contact) */}
              <div className="p-3 rounded-md border border-border">
                <div className="mb-3">
                  <h4 className="text-sm font-medium">{'\u0412\u0435\u0440\u0438\u0444\u0438\u043a\u0430\u0446\u0438\u044f \u043a\u043e\u043d\u0442\u0430\u043a\u0442\u043e\u0432'}</h4>
                  <p className="text-xs text-muted-foreground">
                    Safety numbers для каждого контакта — защита от перехвата
                  </p>
                </div>
                <SafetyNumbersPanel />
              </div>
              {/* Выйти из всех устройств — security: revokes ALL refresh tokens (incl. current session) */}
              <div className="flex items-center justify-between p-3 rounded-md border border-destructive/30 bg-destructive/5">
                <div className="flex items-center gap-3 flex-1 min-w-0 pr-4">
                  <div className="w-8 h-8 rounded-full bg-destructive/10 flex items-center justify-center shrink-0"><LogOut className="w-4 h-4 text-destructive" /></div>
                  <div className="min-w-0">
                    <h4 className="text-sm font-medium">Выйти из всех устройств</h4>
                    <p className="text-xs text-muted-foreground truncate">Завершить все активные сессии, включая текущую</p>
                  </div>
                </div>
                <Button
                  variant="destructive"
                  size="sm"
                  className="shrink-0"
                  onClick={() => setShowLogoutAllConfirm(true)}
                  disabled={isLoggingOut}
                >
                  {isLoggingOut ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <LogOut className="w-4 h-4 mr-2" />}
                  Выйти
                </Button>
              </div>
            </div>
          </div>
        );
       case 'devices':
         return (
           <div className="space-y-4">
             <DeviceList
               devices={devices}
               currentDeviceId={currentDeviceId || ''}
               onRemoveDevice={handleDeleteDevice}
               onRenameDevice={handleRenameDevice}
               onRefresh={loadDevices}
               isLoading={devicesLoading}
             />
           </div>
         );
       case 'folders':
         return (
           <div className="space-y-4">
             <FolderManagementDialog
               open={activeTab === 'folders'}
               onOpenChange={(open) => {
                 if (!open) setActiveTab('appearance');
               }}
             />
           </div>
         );
    }
  };

  return (
    <CustomDialog open={open} onOpenChange={onOpenChange}>
      <div className="flex flex-col h-full">
        <div className="px-5 py-3 border-b shrink-0">
          <h2 className="text-lg font-semibold">{'\u041d\u0430\u0441\u0442\u0440\u043e\u0439\u043a\u0438'}</h2>
          <p className="text-sm text-muted-foreground mt-0.5">{'\u0423\u043f\u0440\u0430\u0432\u043b\u0435\u043d\u0438\u0435 \u043f\u0430\u0440\u0430\u043c\u0435\u0442\u0440\u0430\u043c\u0438'}</p>
        </div>
        
        <div className={`flex flex-1 overflow-hidden ${isMobile ? 'flex-col' : ''}`}>
          <div className={`${isMobile ? 'w-full border-b' : 'w-[180px] sm:w-[240px] shrink-0 border-r'} p-4 space-y-1 ${isMobile ? 'flex overflow-x-auto gap-1 pb-2' : ''}`}>
            {navItems.map((item) => (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id)}
                className={`flex items-center gap-2 px-3 py-2.5 ${isMobile ? 'shrink-0' : 'w-full justify-start'} text-sm rounded-md transition-colors ${activeTab === item.id ? itemSelectedBg : 'hover:bg-muted/30 text-muted-foreground/80'}`}
              >
                <item.icon className={`w-4 h-4 ${activeTab === item.id ? iconTextSelected : iconTextDefault}`} />
                <span className={`truncate ${activeTab === item.id ? 'font-medium' : ''} ${isMobile ? 'hidden sm:inline' : ''}`}>{item.label}</span>
              </button>
            ))}
          </div>
          
          <div className={`flex-1 overflow-y-auto min-w-0 ${isMobile ? 'px-4 py-3' : 'px-6 py-4'}`}>
            {renderContent()}
          </div>
        </div>
      </div>

      {/* Выйти из всех устройств — подтверждение */}
      <AlertDialog open={showLogoutAllConfirm} onOpenChange={setShowLogoutAllConfirm}>
        <AlertDialogContent>
          <AlertDialogTitle>Выйти из всех устройств?</AlertDialogTitle>
          <AlertDialogDescription>
            Это действие завершит все активные сессии, включая текущую.
            Вам потребуется заново войти на каждом устройстве.
          </AlertDialogDescription>
          <div className="flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2 mt-4">
            <AlertDialogCancel disabled={isLoggingOut}>Отмена</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault(); // keep dialog open until handler closes it
                void handleLogoutAllDevices();
              }}
              disabled={isLoggingOut}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isLoggingOut && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Выйти из всех устройств
            </AlertDialogAction>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </CustomDialog>
  );
}
