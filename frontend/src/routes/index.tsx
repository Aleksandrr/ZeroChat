import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { MoreVertical, Star, User as UserIcon } from 'lucide-react';

import { ChatLayout } from '@/components/chat/ChatLayout';
import { ContactsModal } from '@/components/contacts/ContactsModal';
import { DeviceVerification } from '@/components/devices';
import { OfflineIndicator } from '@/components/ui/offline-indicator';
import { SettingsDialog, type SettingsTab } from '@/components/settings/SettingsDialog';
import { ResponsiveSidebar } from '@/components/sidebar/ResponsiveSidebar';
import { MobileNavigation } from '@/components/mobile/MobileNavigation';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth, useChat, useUI } from '@/contexts';
import { useIsMobile } from '@/hooks/use-mobile';
import type { User } from '@/types';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ChatListPage } from '@/components/chat/ChatListPage';
import { ProfileModal } from '@/components/sidebar/ProfileModal';

export const Route = createFileRoute('/')({
  beforeLoad: async ({ context }) => {
    // Access auth state from context
    const { isAuthenticated } = context;
    if (!isAuthenticated) {
      throw redirect({ to: '/auth' });
    }
    // If device needs verification, let the component handle it
  },
  component: HomePage,
});

function HomePage() {
  const { user, logout, deviceNeedsVerification, setDeviceVerified, isLoading, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  
  // Redirect to auth if session expired
  useEffect(() => {
    if (!isAuthenticated) {
      navigate({ to: '/auth' });
    }
  }, [isAuthenticated, navigate]);
  
  // Проверка верификации устройства - если нужно верифицировать, показываем экран верификации
  const [pendingDeviceId, setPendingDeviceId] = useState<string | null>(null);
  
  useEffect(() => {
    if (deviceNeedsVerification && !pendingDeviceId) {
      // Получаем deviceId из localStorage
      const storedDeviceId = localStorage.getItem('device-id');
      if (storedDeviceId) {
        setPendingDeviceId(storedDeviceId);
      }
    }
  }, [deviceNeedsVerification, pendingDeviceId]);
  
  // Если устройство требует верификации - показываем экран верификации
  if (deviceNeedsVerification || pendingDeviceId) {
    // Если есть пользователь и deviceId - показываем форму верификации
    if (user && pendingDeviceId) {
      return (
        <div className="flex h-screen bg-background items-center justify-center">
          <div className="w-full max-w-md p-6">
            <div className="text-center mb-6">
              <h1 className="text-2xl font-bold mb-2">Требуется верификация устройства</h1>
              <p className="text-muted-foreground">
                Подтвердите, что это действительно вы, введя код из системного чата.
              </p>
            </div>
            <DeviceVerification
              userId={user.id}
              deviceId={pendingDeviceId}
              onVerified={() => {
                setDeviceVerified();
                setPendingDeviceId(null);
              }}
            />
          </div>
        </div>
      );
    }
    
    // Если данные еще загружаются - показываем загрузку
    return (
      <div className="flex h-screen bg-background items-center justify-center">
        <div className="text-center">
          <Skeleton className="h-8 w-48 mb-4 mx-auto" />
          <Skeleton className="h-4 w-32 mx-auto" />
        </div>
      </div>
    );
  }

  // If device is verified and user data is loaded, render the main app
  if (!user || isLoading) {
    return (
      <div className="flex h-screen bg-background items-center justify-center">
        <div className="text-center">
          <Skeleton className="h-8 w-48 mb-4 mx-auto" />
          <Skeleton className="h-4 w-32 mx-auto" />
        </div>
      </div>
    );
  }

  // Only render MainApp when device is verified and ChatProvider is available
  return <MainApp user={user} logout={logout} />;
}

function MainApp({ user, logout }: { user: User; logout: () => Promise<void> }) {
  const {
    activeChat: selectedChat,
    chats,
    selectChat,
    sendMessage
  } = useChat();
  const { settings, updateSettings, contactsOpen, setContactsOpen } = useUI();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mobileTab, setMobileTab] = useState<string>('chats');
  const [pendingChatId, setPendingChatId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const navigatingRef = useRef(false);

  const onBack = useCallback(() => {
    navigatingRef.current = true;
    selectChat(null);
  }, [selectChat]);

  // Navigate when selectedChat changes (desktop only, mobile uses its own navigation)
  useEffect(() => {
    if (navigatingRef.current) {
      navigatingRef.current = false;
      return;
    }
    if (!isMobile && selectedChat) {
      void navigate({ to: '/chat/$chatId', params: { chatId: selectedChat.id } });
    }
  }, [isMobile, selectedChat, navigate]);

  // Handle pending chat selection
  useEffect(() => {
    if (pendingChatId) {
      if (pendingChatId.startsWith('virtual-')) {
        if (selectedChat?.id === pendingChatId) {
          setPendingChatId(null);
        }
      } else {
        const chat = chats.find((c) => c.id === pendingChatId);
        if (chat) {
          void navigate({ to: '/chat/$chatId', params: { chatId: chat.id } });
          setPendingChatId(null);
        }
      }
    }
  }, [chats, pendingChatId, navigate, selectedChat]);

  const openSettings = (tab: SettingsTab = 'appearance') => {
    setSettingsOpen(true);
  };

  const openContacts = () => {
    setContactsOpen(true);
  };

  const openFavorites = () => {
    const favoritesChat = chats.find(c => c.type === 'favorites');
    if (favoritesChat) {
      void navigate({ to: '/chat/$chatId', params: { chatId: favoritesChat.id } });
    }
  };

  const handleOpenChatFromContacts = (chatId: string) => {
    if (chatId.startsWith('virtual-')) {
      setPendingChatId(chatId);
    } else {
      const chat = chats.find(c =>
        c.type === 'private' &&
        c.participants.some(p => p.id === chatId)
      );
      if (chat) {
        void navigate({ to: '/chat/$chatId', params: { chatId: chat.id } });
      }
    }
    setContactsOpen(false);
  };

  // Handle mobile tab change - navigate to chat when switching to chats tab with selected chat
  const handleMobileTabChange = (tab: string) => {
    setMobileTab(tab);
  };

  if (!user) {
    return (
      <div className="flex h-screen bg-background items-center justify-center">
        <div className="text-center">
          <Skeleton className="h-8 w-48 mb-4 mx-auto" />
          <Skeleton className="h-4 w-32 mx-auto" />
        </div>
      </div>
    );
  }

  return (
    <div className={`flex flex-col min-h-0 h-screen bg-background ${isMobile && selectedChat ? 'p-0 gap-0' : 'p-3 gap-3'}`}>
      <OfflineIndicator />
      
      <div className="flex-1 flex flex-row min-h-0">
        {!isMobile && (
          <ResponsiveSidebar
            user={user}
            chats={chats}
            selectedChatId={selectedChat?.id}
            onLogout={logout}
            onOpenSettings={() => openSettings('appearance')}
            onOpenContacts={openContacts}
            onOpenFavorites={openFavorites}
            onChatCreated={(chatId: string) => {
              setPendingChatId(chatId);
            }}
            open={sidebarOpen}
            onOpenChange={setSidebarOpen}
          />
        )}

        <main className={`flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden ${isMobile && selectedChat ? 'rounded-none shadow-none ring-0' : 'rounded-2xl bg-card shadow-lg ring-1 ring-border/5'}`}>
          {!selectedChat && (
            <div className="flex items-center justify-between p-3 border-b md:hidden">
              <h1 className="text-lg font-semibold">ZeroChat</h1>
              <DropdownMenu open={moreMenuOpen} onOpenChange={setMoreMenuOpen}>
                <DropdownMenuTrigger asChild>
                  <button className="p-2 hover:bg-accent rounded-lg">
                    <MoreVertical className="h-6 w-6" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <DropdownMenuItem onClick={() => {
                    const favoritesChat = chats.find(c => c.type === 'favorites');
                    if (favoritesChat) {
                      void navigate({ to: '/chat/$chatId', params: { chatId: favoritesChat.id } });
                    }
                    setMoreMenuOpen(false);
                  }}>
                    <Star className="w-4 h-4 mr-2" />
                    Избранное
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
          
          {mobileTab === 'chats' && (
            selectedChat ? (
              <ChatLayout
                chat={selectedChat}
                currentUser={user}
                onSendMessage={sendMessage}
                onBack={onBack}
              />
            ) : (
              isMobile ? (
                <ChatListPage onChatCreated={(chatId: string) => setPendingChatId(chatId)} />
              ) : (
                <div className="flex-1 flex items-center justify-center text-muted-foreground">
                  <div className="text-center">
                    <h2 className="text-xl font-medium mb-2">Выберите чат</h2>
                    <p className="text-sm">Выберите чат из списка слева или создайте новый</p>
                  </div>
                </div>
              )
            )
          )}
          
          {mobileTab === 'contacts' && isMobile && (
            <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
              <ContactsModal
                open={true}
                onOpenChange={(open) => {
                  if (!open) setMobileTab('chats');
                }}
                onOpenChat={handleOpenChatFromContacts}
              />
            </div>
          )}
          
          {mobileTab === 'settings' && isMobile && (
            <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
              <SettingsDialog
                open={true}
                onOpenChange={(open) => {
                  if (!open) setMobileTab('chats');
                }}
                settings={settings}
                onSettingsChange={updateSettings}
              />
            </div>
          )}
          
          {mobileTab === 'profile' && isMobile && (
            <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
              <ProfileModal
                open={true}
                onOpenChange={(open) => {
                  if (!open) setMobileTab('chats');
                }}
              />
            </div>
          )}
        </main>
      </div>

      {isMobile && !selectedChat && (
        <MobileNavigation
          activeTab={mobileTab}
          onTabChange={handleMobileTabChange}
          unreadCount={chats.reduce((sum, chat) => sum + (chat.unreadCount || 0), 0)}
        />
      )}

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        settings={settings}
        onSettingsChange={updateSettings}
      />

      <ContactsModal
        open={contactsOpen}
        onOpenChange={setContactsOpen}
        onOpenChat={handleOpenChatFromContacts}
      />
    </div>
  );
}
