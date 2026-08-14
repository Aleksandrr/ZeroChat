/**
 * TanStack Query Provider
 * 
 * Configures QueryClient with default options for ZeroChat:
 * - staleTime: 30 seconds (data considered fresh)
 * - gcTime: 5 minutes (cache garbage collection)
 * - retry: 2 attempts on failure
 * - refetchOnWindowFocus: disabled for better UX
 */

import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { type ReactNode,useState } from 'react';

interface QueryProviderProps {
  children: ReactNode;
}

export function QueryProvider({ children }: QueryProviderProps) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000, // 30 seconds
            gcTime: 5 * 60_000, // 5 minutes
            retry: 2,
            refetchOnWindowFocus: false,
          },
          mutations: {
            retry: 1,
          },
        },
      })
  );

  return (
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>
  );
}

// Re-export for convenience
export { QueryClient, QueryClientProvider, useQueryClient };
