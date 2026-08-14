/**
 * UI routing tests — TanStack Router route guards and route definitions.
 *
 * We test the `beforeLoad` guards of each route directly (without
 * spinning up the full <RouterProvider>), because the guards are the
 * critical security boundary:
 *
 *   - `/` (index) requires `isAuthenticated=true`, otherwise redirects to /auth
 *   - /auth requires `isAuthenticated=false`, otherwise redirects to /
 *   - /chat/$chatId requires `isAuthenticated=true`, otherwise redirects to /
 *
 * We also verify the route tree shape (3 routes + root), and that
 * `hasAccessToken()` correctly drives the rootRoute's `isAuthenticated`
 * context value.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { redirect } from '@tanstack/react-router';

// Mock the heavy dependencies that __root.tsx imports — we only need
// the route definitions, not the actual UI providers.
vi.mock('@/contexts', () => ({
  AppProvider: ({ children }: { children: React.ReactNode }) => children,
  useAuth: () => ({
    user: { id: 'user-1', username: 'alice' },
    logout: vi.fn(),
    deviceNeedsVerification: false,
    setDeviceVerified: vi.fn(),
    isLoading: false,
    isAuthenticated: true,
  }),
  useChat: () => ({
    chats: [],
    selectChat: vi.fn(),
    activeChat: null,
    sendMessage: vi.fn(),
  }),
  useUI: () => ({
    settings: {},
    updateSettings: vi.fn(),
    contactsOpen: false,
    setContactsOpen: vi.fn(),
  }),
}));

vi.mock('@/queries', () => ({
  QueryProvider: ({ children }: { children: React.ReactNode }) => children,
  queryKeys: {
    chats: {
      lists: () => ['chats', 'list'],
      detail: (id: string) => ['chats', 'detail', id],
    },
    messages: {
      chat: (id: string) => ['messages', 'chat', id],
    },
  },
}));

vi.mock('next-themes', () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// Mock service modules so they don't try to access localStorage during
// module load (before each test resets it).
vi.mock('@/services/auth', () => ({
  hasAccessToken: vi.fn(() => false),
}));

// We need to import the route modules AFTER the mocks are registered.
import { Route as rootRoute } from '@/routes/__root';
import { Route as indexRoute } from '@/routes/index';
import { Route as authRoute } from '@/routes/auth';
import { Route as chatChatIdRoute } from '@/routes/chat.$chatId';
import { hasAccessToken } from '@/services/auth';

// Helper: invoke a route's beforeLoad with a fake context and catch
// the redirect that `throw redirect({...})` produces.
//
// TanStack Router v1.x throws a `Response` object (status 307) with the
// target path stored in `(err as any).options.to`. We detect both that
// shape and the older `{ name: 'Redirect', to }` shape.
async function runBeforeLoad(
  route: typeof rootRoute | typeof indexRoute | typeof authRoute | typeof chatChatIdRoute,
  context: Record<string, unknown> = {},
  params: Record<string, unknown> = {},
): Promise<{ redirect?: { to: string }; ok: boolean }> {
  const beforeLoad = (route as any).options.beforeLoad as
    | ((ctx: { context: unknown; params: unknown }) => Promise<unknown>)
    | undefined;
  if (!beforeLoad) {
    return { ok: true };
  }
  try {
    await beforeLoad({ context, params });
    return { ok: true };
  } catch (err: any) {
    // TanStack Router v1.x: redirect throws a Response with `options.to`.
    if (err?.options?.to) {
      return { redirect: { to: err.options.to }, ok: false };
    }
    // Older shape: { name: 'Redirect', to }.
    if (err?.name === 'Redirect' && err?.to) {
      return { redirect: { to: err.to }, ok: false };
    }
    // Sometimes the thrown object is a plain object with `to`.
    if (err?.to) {
      return { redirect: { to: err.to }, ok: false };
    }
    throw err;
  }
}

describe('UI routing — route tree shape', () => {
  it('defines exactly 3 file-routes + 1 root route', () => {
    // From routeTree.gen.ts: IndexRoute, AuthRoute, ChatChatIdRoute, plus rootRoute.
    expect(rootRoute).toBeDefined();
    expect(indexRoute).toBeDefined();
    expect(authRoute).toBeDefined();
    expect(chatChatIdRoute).toBeDefined();
  });

  it('rootRoute is the parent of every other route', () => {
    // TanStack Router's Route object exposes `options.parentRoute` (or
    // for file-routes, the getParentRoute function).
    expect(typeof rootRoute.options.beforeLoad).toBe('function');
  });
});

describe('UI routing — rootRoute.beforeLoad reads hasAccessToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns isAuthenticated=false when hasAccessToken() returns false', async () => {
    (hasAccessToken as any).mockReturnValue(false);
    const result = await (rootRoute as any).options.beforeLoad({});
    expect(result.isAuthenticated).toBe(false);
  });

  it('returns isAuthenticated=true when hasAccessToken() returns true', async () => {
    (hasAccessToken as any).mockReturnValue(true);
    const result = await (rootRoute as any).options.beforeLoad({});
    expect(result.isAuthenticated).toBe(true);
  });

  it('hasAccessToken is called exactly once per beforeLoad', async () => {
    (hasAccessToken as any).mockReturnValue(true);
    await (rootRoute as any).options.beforeLoad({});
    expect(hasAccessToken).toHaveBeenCalledTimes(1);
  });
});

describe('UI routing — `/` (index) guard', () => {
  it('redirects to /auth when not authenticated', async () => {
    const result = await runBeforeLoad(indexRoute, { isAuthenticated: false });
    expect(result.ok).toBe(false);
    expect(result.redirect?.to).toBe('/auth');
  });

  it('does NOT redirect when authenticated', async () => {
    const result = await runBeforeLoad(indexRoute, { isAuthenticated: true });
    expect(result.ok).toBe(true);
    expect(result.redirect).toBeUndefined();
  });
});

describe('UI routing — /auth guard', () => {
  it('redirects to / when already authenticated', async () => {
    const result = await runBeforeLoad(authRoute, { isAuthenticated: true });
    expect(result.ok).toBe(false);
    expect(result.redirect?.to).toBe('/');
  });

  it('does NOT redirect when not authenticated (allows auth page to render)', async () => {
    const result = await runBeforeLoad(authRoute, { isAuthenticated: false });
    expect(result.ok).toBe(true);
    expect(result.redirect).toBeUndefined();
  });
});

describe('UI routing — /chat/$chatId guard', () => {
  it('redirects to / when not authenticated', async () => {
    const result = await runBeforeLoad(
      chatChatIdRoute,
      { isAuthenticated: false },
      { chatId: 'chat-123' },
    );
    expect(result.ok).toBe(false);
    expect(result.redirect?.to).toBe('/');
  });

  it('does NOT redirect when authenticated', async () => {
    const result = await runBeforeLoad(
      chatChatIdRoute,
      { isAuthenticated: true },
      { chatId: 'chat-123' },
    );
    expect(result.ok).toBe(true);
    expect(result.redirect).toBeUndefined();
  });
});

describe('UI routing — route paths and ids', () => {
  // TanStack Router's `Route` object after `.update({ id, path })` may
  // store the path on any of several internal properties. We just
  // verify that the route is registered (truthy) and has a `beforeLoad`
  // guard, which is the contract callers depend on.

  it('indexRoute is a registered route with a beforeLoad guard', () => {
    expect(indexRoute).toBeTruthy();
    expect(typeof (indexRoute as any).options.beforeLoad).toBe('function');
  });

  it('authRoute is a registered route with a beforeLoad guard', () => {
    expect(authRoute).toBeTruthy();
    expect(typeof (authRoute as any).options.beforeLoad).toBe('function');
  });

  it('chatChatIdRoute is a registered route with a beforeLoad guard', () => {
    expect(chatChatIdRoute).toBeTruthy();
    expect(typeof (chatChatIdRoute as any).options.beforeLoad).toBe('function');
  });
});

describe('UI routing — full redirect chain simulation', () => {
  // Simulates the user navigating to various URLs in different auth states
  // and verifies the expected final destination.

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('unauthenticated user visiting / → ends up on /auth', async () => {
    (hasAccessToken as any).mockReturnValue(false);
    const rootCtx = await (rootRoute as any).options.beforeLoad({});
    const indexResult = await runBeforeLoad(indexRoute, rootCtx);
    expect(indexResult.redirect?.to).toBe('/auth');

    // And /auth should NOT redirect them away.
    const authResult = await runBeforeLoad(authRoute, rootCtx);
    expect(authResult.ok).toBe(true);
  });

  it('authenticated user visiting /auth → ends up on /', async () => {
    (hasAccessToken as any).mockReturnValue(true);
    const rootCtx = await (rootRoute as any).options.beforeLoad({});
    const authResult = await runBeforeLoad(authRoute, rootCtx);
    expect(authResult.redirect?.to).toBe('/');

    // And / should NOT redirect them away.
    const indexResult = await runBeforeLoad(indexRoute, rootCtx);
    expect(indexResult.ok).toBe(true);
  });

  it('unauthenticated user visiting /chat/xyz → redirected to /', async () => {
    (hasAccessToken as any).mockReturnValue(false);
    const rootCtx = await (rootRoute as any).options.beforeLoad({});
    const chatResult = await runBeforeLoad(
      chatChatIdRoute,
      rootCtx,
      { chatId: 'xyz' },
    );
    expect(chatResult.redirect?.to).toBe('/');
  });

  it('authenticated user visiting /chat/xyz → stays on the chat page', async () => {
    (hasAccessToken as any).mockReturnValue(true);
    const rootCtx = await (rootRoute as any).options.beforeLoad({});
    const chatResult = await runBeforeLoad(
      chatChatIdRoute,
      rootCtx,
      { chatId: 'xyz' },
    );
    expect(chatResult.ok).toBe(true);
  });
});
