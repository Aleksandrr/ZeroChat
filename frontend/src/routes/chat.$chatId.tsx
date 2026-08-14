import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';

import { ChatLayout } from '@/components/chat/ChatLayout';
import { ContactsModal } from '@/components/contacts/ContactsModal';
import { SettingsDialog, type SettingsTab } from '@/components/settings/SettingsDialog';
import { Sidebar } from '@/components/sidebar/Sidebar';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth, useChat, useUI } from '@/contexts';
import { useChat as useChatQuery } from '@/queries';

export const Route = createFileRoute('/chat/$chatId')({
  beforeLoad: async ({ context }) => {
    // Access auth state from context
    const { isAuthenticated } = context;
    if (!isAuthenticated) {
      throw redirect({ to: '/' });
    }
  },
  component: ChatPage,
});

function ChatPage() {
  const { chatId } = Route.useParams();
  const navigate = useNavigate();
  const { user, deviceNeedsVerification, isLoading, logout, isAuthenticated } = useAuth();

  // Redirect to auth if session expired
  useEffect(() => {
    if (!isAuthenticated) {
      navigate({ to: '/auth' });
    }
  }, [isAuthenticated, navigate]);

  // If device needs verification, redirect to home page
  useEffect(() => {
    if (deviceNeedsVerification) {
      navigate({ to: '/' });
    }
  }, [deviceNeedsVerification, navigate]);

  // Show loading state while user is being fetched
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

  // Render the main chat app only if user is loaded and device is verified
  return <ChatApp chatId={chatId} user={user} logout={logout} />;
}

function ChatApp({ chatId, user, logout }: { chatId: string; user: any; logout: () => Promise<void> }) {
  const {
    chats,
    selectChat,
    sendMessage,
    activeChat,
    clearActiveChat,
  } = useChat();
  const { settings, updateSettings, contactsOpen, setContactsOpen } = useUI();
  const { data: queryChat, isLoading: queryLoading } = useChatQuery(chatId);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pendingChatId, setPendingChatId] = useState<string | null>(null);
  const navigate = useNavigate();

  // Merge query chat with context chat for real-time status updates
  const chatFromContext = chats.find((c) => c.id === chatId);
  
  const queryChatWithStatus = queryChat ? {
    ...queryChat,
    participants: queryChat.participants.map(p => {
      const contextParticipant = chatFromContext?.participants.find(cp => cp.id === p.id);
      return contextParticipant ? { ...p, status: contextParticipant.status, lastSeen: contextParticipant.lastSeen } : p;
    })
  } : null;
  
  // Check for virtual chat (if activeChat matches the chatId and is virtual)
  const virtualChat = activeChat?.id === chatId && activeChat?.isVirtual ? activeChat : null;
  
  // Priority: context chat > query chat > virtual chat
  const chat = chatFromContext || queryChatWithStatus || virtualChat || null;

  // Auto-select the chat when found
  // Use ref to prevent multiple calls
  const lastSelectedChatIdRef = useRef<string | null>(null);
  
  useEffect(() => {
    // Only select if chat changed and is different from activeChat
    if (chat && chat.id !== lastSelectedChatIdRef.current && activeChat?.id !== chat.id && !activeChat?.isVirtual) {
      lastSelectedChatIdRef.current = chat.id;
      selectChat(chat);
    }
  }, [chat, activeChat, selectChat]);

  // Handle chat created from NewChatDialog or contact selection
  useEffect(() => {
    if (pendingChatId) {
      // Check if this is a virtual chat (ID starts with "virtual-")
      if (pendingChatId.startsWith('virtual-')) {
        // Wait for activeChat to be set by openVirtualChat
        if (activeChat?.id === pendingChatId) {
          navigate({ to: '/chat/$chatId', params: { chatId: pendingChatId } });
          setPendingChatId(null);
        }
        // If activeChat doesn't match yet, do nothing and wait
      } else {
        const newChat = chats.find((c) => c.id === pendingChatId);
        if (newChat) {
          // Navigate to the new chat (auto-select will set activeChat)
          void navigate({ to: '/chat/$chatId', params: { chatId: newChat.id } });
          setPendingChatId(null);
        }
      }
    }
  }, [chats, pendingChatId, navigate, activeChat]);

  // Navigate to real chat after virtual chat becomes real (first message sent)
  useEffect(() => {
    if (activeChat && !activeChat.isVirtual && chatId.startsWith('virtual-')) {
      navigate({ to: '/chat/$chatId', params: { chatId: activeChat.id } });
    }
  }, [activeChat, chatId, navigate]);

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
       // For virtual chat, set pendingChatId to trigger navigation after activeChat is set
       setPendingChatId(chatId);
     } else {
       // Find private chat with this user
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

    return (
       <div className="flex min-h-0 h-screen bg-background p-3">
         <div className="flex-1 w-full min-h-0 flex gap-3">
          {/* Sidebar - floating module */}
          <aside className="w-80 shrink-0 hidden lg:flex flex-col rounded-2xl bg-card shadow-lg ring-1 ring-border/5">
           <div className="p-3">
             <Sidebar
               user={user}
               chats={chats}
               selectedChatId={chatId}
               onLogout={logout}
               onOpenSettings={() => openSettings('appearance')}
               onOpenContacts={openContacts}
               onOpenFavorites={openFavorites}
                onChatCreated={(newChatId) => {
                  setPendingChatId(newChatId);
                }}
             />
           </div>
          </aside>

          {/* Chat area - floating module */}
          <main className="flex-1 flex flex-col min-w-0 min-h-0 rounded-2xl bg-card shadow-lg ring-1 ring-border/5 overflow-hidden">
            {queryLoading ? (
              <div className="flex-1 flex items-center justify-center">
                <div className="text-center space-y-4">
                  <Skeleton className="h-8 w-48 mx-auto" />
                  <Skeleton className="h-4 w-32 mx-auto" />
                </div>
              </div>
            ) : chat ? (
                    <ChatLayout
                      chat={chat}
                      currentUser={user}
                      onSendMessage={sendMessage}
                      onBack={() => {
                        clearActiveChat();
                        navigate({ to: '/' });
                      }}
                    />
            ) : (
              <div className="flex-1 flex items-center justify-center text-muted-foreground">
                <div className="text-center">
                  <h2 className="text-xl font-medium mb-2">Чат не найден</h2>
                  <p className="text-sm">Выберите другой чат из списка</p>
                </div>
              </div>
            )}
          </main>
        </div>

        {/* Settings dialog */}
        <SettingsDialog
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          settings={settings}
          onSettingsChange={updateSettings}
        />

        {/* Contacts Modal - global, accessible from anywhere */}
        <ContactsModal
          open={contactsOpen}
          onOpenChange={setContactsOpen}
          onOpenChat={handleOpenChatFromContacts}
        />
      </div>
    );
}
