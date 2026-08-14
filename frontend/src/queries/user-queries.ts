/**
 * User Query Hooks
 *
 * TanStack Query hooks for user operations:
 * - useSearchUsers: Search users by username
 */

import { useQuery } from '@tanstack/react-query';

import { chatService } from '@/services/chat';
import type { UserSearchResult } from '@/types';

import { queryKeys } from './keys';

/**
 * Search users by username
 */
export function useSearchUsers(query: string) {
  return useQuery<UserSearchResult[], Error>({
    queryKey: queryKeys.users.search(query),
    queryFn: () => chatService.searchUsers(query),
    enabled: query.length >= 2, // Only search when query has at least 2 characters
    staleTime: 10_000, // 10 seconds
  });
}
