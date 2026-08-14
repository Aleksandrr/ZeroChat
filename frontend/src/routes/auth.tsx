import { createFileRoute, redirect } from '@tanstack/react-router';

import { AuthPage } from '@/components/auth/AuthPage';

export const Route = createFileRoute('/auth')({
  beforeLoad: async ({ context }) => {
    // If user is already authenticated, redirect to home
    const { isAuthenticated } = context;
    if (isAuthenticated) {
      throw redirect({ to: '/' });
    }
  },
  component: AuthPage,
});
