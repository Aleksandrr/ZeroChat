import { useIsMobile } from '@/hooks/use-mobile';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { FolderRail } from './FolderRail';
import { Sidebar } from './Sidebar';
import type { Chat, User } from '@/types';

interface ResponsiveSidebarProps {
  user: User;
  chats: Chat[];
  selectedChatId?: string;
  onLogout: () => Promise<void>;
  onOpenSettings: () => void;
  onOpenContacts: () => void;
  onOpenFavorites?: () => void;
  onChatCreated?: (chatId: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ResponsiveSidebar({
  user,
  chats,
  selectedChatId,
  onLogout,
  onOpenSettings,
  onOpenContacts,
  onOpenFavorites,
  onChatCreated,
  open,
  onOpenChange,
}: ResponsiveSidebarProps) {
  const isMobile = useIsMobile();

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="left" className="w-80 p-0">
          <Sidebar
            user={user}
            chats={chats}
            selectedChatId={selectedChatId}
            onLogout={onLogout}
            onOpenSettings={onOpenSettings}
            onOpenContacts={onOpenContacts}
            onOpenFavorites={onOpenFavorites}
            onChatCreated={onChatCreated}
          />
        </SheetContent>
      </Sheet>
    );
  }

  // Desktop: narrow FolderRail column to the left of the main Sidebar.
  // Mobile does NOT render FolderRail (separate tabs UI owned by another agent).
  return (
    <aside className="hidden md:flex shrink-0 flex-row">
      <FolderRail />
      <div className="w-80 flex flex-col rounded-2xl bg-card shadow-lg ring-1 ring-border/5">
        <div className="p-3">
          <Sidebar
            user={user}
            chats={chats}
            selectedChatId={selectedChatId}
            onLogout={onLogout}
            onOpenSettings={onOpenSettings}
            onOpenContacts={onOpenContacts}
            onOpenFavorites={onOpenFavorites}
            onChatCreated={onChatCreated}
          />
        </div>
      </div>
    </aside>
  );
}
