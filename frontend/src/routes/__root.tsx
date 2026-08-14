import { createRootRoute, Outlet } from '@tanstack/react-router';
import { useNavigate } from '@tanstack/react-router';
import { ThemeProvider } from 'next-themes';
import { Suspense } from 'react';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { AppProvider } from '@/contexts';
import { QueryProvider } from '@/queries';
import { hasAccessToken } from '@/services/auth';

// Loading skeleton for Suspense fallback
function LoadingFallback() {
  return (
    <div className="flex h-screen bg-background items-center justify-center">
      <div className="text-center">
        <Skeleton className="h-8 w-48 mb-4 mx-auto" />
        <Skeleton className="h-4 w-32 mx-auto" />
      </div>
    </div>
  );
}

// 404 Not Found component
function NotFoundComponent() {
  const navigate = useNavigate();

  return (
    <div className="flex h-screen bg-background items-center justify-center">
      <div className="text-center">
        <h1 className="text-6xl font-bold text-primary mb-4">404</h1>
        <h2 className="text-2xl font-medium mb-2">Страница не найдена</h2>
        <p className="text-muted-foreground mb-6">
          Запрашиваемая страница не существует или была перемещена.
        </p>
        <Button onClick={() => navigate({ to: '/' })}>
          Вернуться на главную
        </Button>
      </div>
    </div>
  );
}

export const Route = createRootRoute({
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  beforeLoad: async () => {
    // Check if user has access token (synchronous check)
    const isAuthenticated = hasAccessToken();
    return { isAuthenticated };
  },
});

function RootComponent() {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <QueryProvider>
        <AppProvider>
          <Suspense fallback={<LoadingFallback />}>
            <Outlet />
          </Suspense>
        </AppProvider>
      </QueryProvider>
    </ThemeProvider>
  );
}
