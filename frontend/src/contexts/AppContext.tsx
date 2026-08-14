/**
 * AppContext - Composite provider
 * Combines all contexts in the correct order
 *
 * IMPORTANT: CallProvider (and CallOverlay) live INSIDE AppContent's
 * "verified" branch on purpose — CallProvider calls `useWebSocketContext()`
 * at its top, so it must only mount after WebSocketProvider has mounted.
 * Mounting CallProvider above AppProvider (as it was before) crashes the
 * whole app on /auth with "useWebSocketContext must be used within
 * WebSocketProvider" because AppContent short-circuits to <>{children}</>
 * for unauthenticated users, leaving WebSocketProvider out of the tree.
 */

import type React from 'react';

import { CallOverlay } from '@/components/chat/CallOverlay';
import { SyncInviteHandler } from '@/components/sync';

import { AuthProvider, useAuth } from './AuthContext';
import { CallProvider } from './CallContext';
import { ChatProvider } from './ChatContext';
import { ImageGalleryProvider } from './ImageGalleryContext';
import { SignalProvider } from './SignalContext';
import { UIProvider } from './UIContext';
import { WebSocketProvider } from './WebSocketContext';

export function AppProvider({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider onLogout={async () => {}}>
      <AppContent>{children}</AppContent>
    </AuthProvider>
  );
}

function AppContent({ children }: { children: React.ReactNode }) {
  const { deviceNeedsVerification, isLoading, user } = useAuth();

  // If loading user data or device needs verification, don't render other contexts
  if (isLoading || !user || deviceNeedsVerification) {
    return <>{children}</>;
  }

  // If device is verified and user is loaded, render all contexts.
  // CallProvider/CallOverlay must be inside WebSocketProvider.
  return (
    <UIProvider>
      <SignalProvider>
        <WebSocketProvider>
          <ChatProvider>
            <ImageGalleryProvider>
              <CallProvider>
                {/* Sync invite handler - listens for sync invites from new devices */}
                <SyncInviteHandler />
                {children}
                <CallOverlay />
              </CallProvider>
            </ImageGalleryProvider>
          </ChatProvider>
        </WebSocketProvider>
      </SignalProvider>
    </UIProvider>
  );
}
