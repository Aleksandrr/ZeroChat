/**
 * Contexts Index
 * Re-exports all contexts and hooks
 */

// Context providers
export { AppProvider } from './AppContext';
export { AuthProvider } from './AuthContext';
export { ChatProvider } from './ChatContext';
export { SignalProvider } from './SignalContext';
export { UIProvider } from './UIContext';
export { WebSocketProvider } from './WebSocketContext';

// Context hooks
export { type AuthContextType,useAuth } from './AuthContext';
export { useChat } from './ChatContext';
export { type EncryptedMessage,type SignalContextType, useSignal } from './SignalContext';
export { type UIContextType,useUI } from './UIContext';
export { type MessageHandler,useWebSocketContext, type WebSocketContextType } from './WebSocketContext';
export type { ChatContextType } from '@/types/chat';

// Signal utilities
export { arrayBufferToBase64, base64ToArrayBuffer, establishedSessions } from './SignalContext';
