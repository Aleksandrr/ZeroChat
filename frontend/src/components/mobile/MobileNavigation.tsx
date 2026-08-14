import { MessageCircle, Users, Settings, User } from 'lucide-react';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';

interface MobileNavigationProps {
  activeTab: string;
  onTabChange: (tab: string) => void;
  unreadCount?: number;
}

export function MobileNavigation({ activeTab, onTabChange, unreadCount }: MobileNavigationProps) {
  const isMobile = useIsMobile();

  // Show navigation when sidebar is hidden (mobile + tablet < md)
  // This is controlled by CSS class md:hidden in the parent component
  // So we always render, but CSS will hide it on desktop

  const tabs = [
    { id: 'chats', icon: MessageCircle, label: 'Чаты', badge: unreadCount },
    { id: 'contacts', icon: Users, label: 'Контакты' },
    { id: 'settings', icon: Settings, label: 'Настройки' },
    { id: 'profile', icon: User, label: 'Профиль' },
  ];

  return (
    <nav className="fixed bottom-0 left-0 right-0 bg-background border-t pb-safe px-safe z-50 md:hidden">
      <div className="flex justify-around py-2">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
            className={cn(
              'flex flex-col items-center p-2 min-w-[44px] min-h-[44px] relative',
              activeTab === tab.id ? 'text-primary' : 'text-muted-foreground'
            )}
          >
            <tab.icon className="h-6 w-6" />
            <span className="text-xs mt-1">{tab.label}</span>
            {(tab.badge ?? 0) > 0 && (
              <span className="absolute -top-1 -right-1 bg-destructive text-destructive-foreground text-xs rounded-full h-5 w-5 flex items-center justify-center">
                {(tab.badge ?? 0) > 99 ? '99+' : (tab.badge ?? 0)}
              </span>
            )}
          </button>
        ))}
      </div>
    </nav>
  );
}
