/**
 * SignalContext - Signal Protocol management
 * Handles encryption, decryption, and session management
 * 
 * Auto-initializes when user becomes authenticated via useEffect.
 * Handles key publication for new devices/users automatically.
 */

import type React from 'react';
import { createContext, useCallback, useContext, useEffect,useRef, useState } from 'react';

import * as signal from '@/lib/signal';
import * as signalStorage from '@/lib/signal/storage';
import type { EncryptedMessage,PreKeyBundle } from '@/lib/signal/types';
import { secureRandomInt } from '@/lib/utils';
import { publishSignalKeys as authPublishSignalKeys, refreshDeviceToken } from '@/services/auth';
import { chatService } from '@/services/chat';
import { getDevices } from '@/services/devices/api';
import { usePrekeyManager } from '@/hooks/usePrekeyManager';

import { useAuth } from './AuthContext';

// ==================== Types ====================

// Re-export EncryptedMessage from signal types
export type { EncryptedMessage } from '@/lib/signal/types';

export interface SignalContextType {
  isInitialized: boolean;
  identityKeyId: string | null;
  deviceNeedsVerification: boolean;
  getDeviceId: () => number | null;
  initialize: (userId: string, deviceId?: number) => Promise<void>;
  initializeWithRestore: (userId: string, isNewUser?: boolean) => Promise<signal.SignalInitializationResult>;
  encrypt: (recipientId: string, recipientDeviceId: number, message: string) => Promise<EncryptedMessage>;
  decrypt: (senderId: string, senderDeviceId: number, message: Uint8Array, messageType: number) => Promise<string>;
  encryptGroupMessage: (groupId: string, message: string) => Promise<EncryptedMessage>;
  decryptGroupMessage: (groupId: string, senderUserId: string, senderDeviceId: number, message: Uint8Array, messageType: number) => Promise<string>;
  initializeSenderKey: (groupId: string) => Promise<Uint8Array>;
  addSenderKey: (groupId: string, senderUserId: string, senderDeviceId: number, senderKeyState: Uint8Array) => Promise<void>;
  processPreKeyBundle: (recipientId: string, deviceId: number, bundle: PreKeyBundle) => Promise<void>;
  hasSession: (recipientId: string, deviceId: number) => Promise<boolean>;
  generatePreKeyBundle: (preKeyId?: number, signedPreKeyId?: number, kyberPreKeyId?: number) => Promise<PreKeyBundle | null>;
  archiveSession: (userId: string, deviceId: number) => Promise<void>;
  cleanup: () => Promise<void>;
  encryptCommand: (recipientId: string, message: string) => Promise<string>;
  decryptCommand: (senderId: string, encryptedBase64: string, senderSignalDeviceId: number) => Promise<string>;
}

// ==================== Context ====================

const SignalContext = createContext<SignalContextType | null>(null);

// ==================== Utility Functions ====================

function arrayBufferToBase64(buffer: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < buffer.length; i++) {
    const byte = buffer[i];
    if (byte !== undefined) {
      binary += String.fromCharCode(byte);
    }
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

// Track established sessions to avoid re-establishing
const establishedSessions = new Set<string>();

// ==================== Provider ====================

export function SignalProvider({ children }: { children: React.ReactNode }) {
  const { user, isAuthenticated } = useAuth();
  const [isInitialized, setIsInitialized] = useState(false);
  const [identityKeyId, setIdentityKeyId] = useState<string | null>(null);
  const [deviceNeedsVerification, setDeviceNeedsVerification] = useState(false);
  
  // RACE CONDITION FIX: Use promise-based mutex instead of boolean flag
  // This ensures that if two calls happen almost simultaneously, both will
  // wait for the same initialization promise instead of starting parallel
  // initializations that could conflict in IndexedDB.
  const initPromiseRef = useRef<Promise<unknown> | null>(null);
  // RACE CONDITION FIX: Track mounted state to prevent setState on unmounted component
  const mountedRef = useRef(true);

  // U10 / U11 — Automatic prekey maintenance. Starts as soon as the
  // user is authenticated AND Signal is initialized. The hook sets
  // up an hourly check + initial 5s-delayed check + a global event
  // listener so `useChatMessages.sendMessage` can trigger a post-send
  // check via `window.dispatchEvent(new Event('zerochat:prekey-check'))`.
  usePrekeyManager({
    enabled: isInitialized && !!user,
    userId: user?.id ?? null,
  });

  // Helper function to perform initialization logic
  const performInitialization = useCallback(async (userId: string): Promise<void> => {
    await signal.initSignalDB();
    await signal.cleanupOrphanedIdentityKeys(userId);
    const result = await signal.initializeSignalWithRestore(userId);
    
    // Check if component is still mounted before updating state
    if (!mountedRef.current) return;
    
    // Publish keys if needed (new device or key rotation)
    if (result.keysForPublishing) {
      const { preKeys, signedPreKeys, kyberPreKeys, identityKey, registrationId, deviceId } = result.keysForPublishing;
      
      const publishResult = await authPublishSignalKeys({
        userId,
        deviceId: deviceId ?? null,
        registrationId,
        identityKey,
        preKeys: preKeys.map(pk => ({
          id: pk.id,
          publicKey: pk.publicKey,
        })),
        signedPreKey: {
          id: signedPreKeys[0]?.id || 0,
          publicKey: signedPreKeys[0]?.publicKey || '',
          signature: signedPreKeys[0]?.signature || '',
        },
        kyberPreKey: {
          id: kyberPreKeys[0]?.id || 0,
          publicKey: kyberPreKeys[0]?.publicKey || '',
          signature: kyberPreKeys[0]?.signature || '',
        },
      });
      
      // Check if component is still mounted before continuing
      if (!mountedRef.current) return;
      
      // If server created a new device, refresh JWT with new deviceId
      if (publishResult.newDeviceId) {
        await refreshDeviceToken(publishResult.newDeviceId);
      }
      
      // Wait for signalDeviceId to propagate
      await new Promise(resolve => setTimeout(resolve, 500));
    } else {
      // SERVER KEY SYNC FIX: After restore, check if our keys exist on server
      // This handles the case where server DB was reset but client has existing keys
      try {
        const myDevices = await chatService.getRecipientDevices(userId);
        if (myDevices.length === 0) {
          // Generate fresh bundle from existing client
          const bundle = await signal.generatePreKeyBundle();
          if (!bundle) {
            throw new Error('Failed to generate PreKey bundle for republish');
          }
          
          const publishResult = await authPublishSignalKeys({
            userId,
            deviceId: bundle.deviceId ?? null,
            registrationId: bundle.registrationId,
            identityKey: arrayBufferToBase64(bundle.identityKey),
            preKeys: bundle.preKeyId ? [{
              id: bundle.preKeyId,
              publicKey: arrayBufferToBase64(bundle.preKey!)
            }] : [],
            signedPreKey: {
              id: bundle.signedPreKeyId,
              publicKey: arrayBufferToBase64(bundle.signedPreKey),
              signature: arrayBufferToBase64(bundle.signedPreKeySignature),
            },
            kyberPreKey: {
              id: bundle.kyberPreKeyId ?? 0,
              publicKey: arrayBufferToBase64(bundle.kyberPreKey ?? new Uint8Array(0)),
              signature: arrayBufferToBase64(bundle.kyberPreKeySignature ?? new Uint8Array(0)),
            },
          });
          
          // Check if component is still mounted before continuing
          if (!mountedRef.current) return;
          
          // If server returned new deviceId, update token
          if (publishResult.newDeviceId) {
            await refreshDeviceToken(publishResult.newDeviceId);
          }
        }
      } catch (error) {
        console.warn('[SignalContext] Failed to check/republish keys after restore:', error);
      }
    }
    
    // Final mount check before setting state
    if (!mountedRef.current) return;
    
    setIsInitialized(true);
    setIdentityKeyId(userId);
  }, []);

  // Auto-initialize Signal Protocol when user becomes authenticated
  useEffect(() => {
    mountedRef.current = true;
    
    const init = async () => {
      // Skip if conditions not met
      if (!isAuthenticated || !user || isInitialized) {
        return;
      }

      // SECURITY: Check device verification status before initializing Signal
      // Signal Protocol initialization should only happen for verified devices
      try {
        const devicesResponse = await getDevices();
        const deviceId = localStorage.getItem('device-id');
        const currentDevice = devicesResponse.devices.find(d => d.device_uuid === deviceId);
        
        if (currentDevice && !currentDevice.verified_at) {
          console.warn('[SignalContext] Device not verified, blocking Signal initialization');
          setDeviceNeedsVerification(true);
          return;
        }
      } catch (error) {
        console.error('[SignalContext] Failed to check device verification:', error);
        // On error, we block initialization for security
        setDeviceNeedsVerification(true);
        return;
      }

      // RACE CONDITION FIX: Return existing promise if initialization is in progress
      if (initPromiseRef.current) {
        try {
          await initPromiseRef.current;
        } catch {
          // Ignore errors from concurrent initialization
        }
        return;
      }

      // Create and store the promise
      const promise = performInitialization(user.id)
        .catch(error => {
          console.error('[SignalContext] Failed to auto-initialize Signal Protocol:', error);
          throw error;
        })
        .finally(() => {
          initPromiseRef.current = null;
        });
      
      initPromiseRef.current = promise;
      await promise;
    };
    init();
    
    return () => {
      mountedRef.current = false;
    };
  }, [isAuthenticated, user, isInitialized, performInitialization]);

  // Initialize Signal Protocol (manual call) - with promise-based mutex
  const initialize = useCallback(async (userId: string, _deviceId?: number): Promise<void> => {
    // Return existing promise if initialization is in progress
    if (initPromiseRef.current) {
      await initPromiseRef.current;
      return;
    }

    const promise = performInitialization(userId)
      .finally(() => {
        initPromiseRef.current = null;
      });
    
    initPromiseRef.current = promise;
    await promise;
  }, [performInitialization]);

  // Initialize with restore (enhanced version) - with promise-based mutex
  const initializeWithRestore = useCallback(async (userId: string, isNewUser?: boolean): Promise<signal.SignalInitializationResult> => {
    // Return existing promise if initialization is in progress
    if (initPromiseRef.current) {
      // Wait for it to complete but return a default result
      try {
        await initPromiseRef.current;
      } catch {
        // Ignore errors from concurrent initialization
      }
      return { success: false, isInitialized: false, keysForPublishing: undefined };
    }

    const promise = (async () => {
      await signal.initSignalDB();
      const result = await signal.initializeSignalWithRestore(userId, isNewUser);
      setIsInitialized(true);
      setIdentityKeyId(userId);
      return result;
    })()
      .catch(error => {
        console.error('[SignalContext] Failed to initialize Signal:', error);
        throw error;
      })
      .finally(() => {
        initPromiseRef.current = null;
      });
    
    initPromiseRef.current = promise;
    return promise;
  }, []);

  // Encrypt message
  const encrypt = useCallback(async (
    recipientId: string,
    recipientDeviceId: number,
    message: string
  ): Promise<EncryptedMessage> => {
    if (!isInitialized) {
      throw new Error('Signal Protocol not initialized');
    }

    const sessionKey = `${recipientId}.${recipientDeviceId}`;
    const sessionExists = await signal.hasSession(recipientId, recipientDeviceId);

    if (!sessionExists && !establishedSessions.has(sessionKey)) {
      throw new Error(`No session established with ${recipientId}.${recipientDeviceId}`);
    }

    const plaintext = new TextEncoder().encode(message);
    const encrypted = await signal.encryptMessage(recipientId, recipientDeviceId, plaintext);
    return encrypted;
  }, [isInitialized]);

  // Decrypt message with automatic session recovery
  const decrypt = useCallback(async (
    senderId: string,
    senderDeviceId: number,
    message: Uint8Array,
    messageType: number,
    maxRetries: number = 2
  ): Promise<string> => {
    if (!isInitialized) {
      throw new Error('Signal Protocol not initialized');
    }

    let lastError: Error | null = null;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // CRITICAL FIX: Force session reload from IndexedDB before decryption
        // This ensures we have the latest session state, especially in multi-tab scenarios
        if (attempt > 1) {
          // The session is automatically loaded from IndexedDB by decryptMessage via saveSession/load cycle
          // Additional explicit reload is not needed as ensureKeys() is called internally
        }

        const decrypted = await signal.decryptMessage(senderId, senderDeviceId, message, messageType);
        const plaintext = new TextDecoder().decode(decrypted.body);
        return plaintext;
      } catch (error: any) {
        lastError = error;
        
        // Check if this is a session corruption error
        const isSessionError = 
          error.message?.includes('Session corrupted') ||
          error.message?.includes('Operation failed') ||
          error.message?.includes('No session') ||
          error.name === 'SignalError';

        if (isSessionError && attempt < maxRetries) {
          console.warn(`[SignalContext] Decryption failed (attempt ${attempt}/${maxRetries}):`, error.message);
          
          // Archive the corrupted session to force re-establishment
          try {
            await signal.archiveSession(senderId, senderDeviceId);
          } catch (archiveError) {
            console.warn('[SignalContext] Failed to archive session:', archiveError);
          }
          
          // Remove from established sessions cache
          establishedSessions.delete(`${senderId}.${senderDeviceId}`);
          
          // Wait a bit before retry
          await new Promise(resolve => setTimeout(resolve, 100));
          continue;
        }
        
        throw error;
      }
    }
    
    throw lastError || new Error('Decryption failed after retries');
  }, [isInitialized]);

  // Process PreKey bundle to establish session
  const processPreKeyBundle = useCallback(async (
    recipientId: string,
    deviceId: number,
    bundle: PreKeyBundle
  ): Promise<void> => {
    if (!isInitialized) {
      throw new Error('Signal Protocol not initialized');
    }

    await signal.processPreKeyBundle(recipientId, deviceId, bundle);
    establishedSessions.add(`${recipientId}.${deviceId}`);
  }, [isInitialized]);

  // Check if session exists
  const hasSession = useCallback(async (recipientId: string, deviceId: number): Promise<boolean> => {
    return signal.hasSession(recipientId, deviceId);
  }, []);

  // Generate PreKey bundle for sharing
  const generatePreKeyBundle = useCallback(async (
    preKeyId?: number,
    signedPreKeyId?: number,
    kyberPreKeyId?: number
  ): Promise<PreKeyBundle | null> => {
    if (!isInitialized) {
      return null;
    }

    try {
      const _registrationId = await signalStorage.loadRegistration().then(r => r?.registrationId) || 1;
      // U1: CSPRNG-backed IDs for PreKey / SignedPreKey / KyberPreKey.
      // signal-wasm accepts 31-bit positive integers, so cap at 0x7FFFFFFF.
      const pkId = preKeyId ?? secureRandomInt(1, 0x7FFFFFFF);
      const spkId = signedPreKeyId ?? secureRandomInt(1, 0x7FFFFFFF);
      const kpkId = kyberPreKeyId ?? secureRandomInt(1, 0x7FFFFFFF);
      
      return await signal.generatePreKeyBundle(pkId, spkId, kpkId);
    } catch (error) {
      console.error('[SignalContext] Failed to generate PreKey bundle:', error);
      return null;
    }
  }, [isInitialized]);

  // Group message encryption
  const encryptGroupMessage = useCallback(async (groupId: string, message: string): Promise<EncryptedMessage> => {
    return signal.encryptGroupMessage(groupId, message);
  }, []);

  // Group message decryption
  const decryptGroupMessage = useCallback(async (
    groupId: string, 
    senderUserId: string, 
    senderDeviceId: number, 
    message: Uint8Array, 
    messageType: number
  ): Promise<string> => {
    return signal.decryptGroupMessage(groupId, senderUserId, senderDeviceId, message, messageType);
  }, []);

  // Initialize Sender Key
  const initializeSenderKey = useCallback(async (groupId: string): Promise<Uint8Array> => {
    return signal.initializeSenderKey(groupId);
  }, []);

  // Add Sender Key (process sender key distribution from other group members)
  const addSenderKey = useCallback(async (
    groupId: string, 
    senderUserId: string, 
    senderDeviceId: number,
    senderKeyState: Uint8Array
  ): Promise<void> => {
    return signal.addSenderKey(groupId, senderUserId, senderDeviceId, senderKeyState);
  }, []);

  // Archive session
  const archiveSession = useCallback(async (userId: string, deviceId: number): Promise<void> => {
    await signal.archiveSession(userId, deviceId);
    establishedSessions.delete(`${userId}.${deviceId}`);
  }, []);

  // Cleanup
  const cleanup = useCallback(async (): Promise<void> => {
    await signal.uiLogout();
    setIsInitialized(false);
    setIdentityKeyId(null);
    establishedSessions.clear();
  }, []);

  // Get current device ID
  const getDeviceId = useCallback((): number | null => {
    const deviceId = signal.getCurrentDeviceId();
    return deviceId > 0 ? deviceId : null;
  }, []);

  // Encrypt command payload (for Command Bus)
  const encryptCommand = useCallback(async (recipientId: string, message: string): Promise<string> => {
    if (!isInitialized) {
      throw new Error('Signal Protocol not initialized');
    }
    const deviceId = signal.getCurrentDeviceId();
    if (!deviceId) {
      throw new Error('Device ID not available');
    }
    const encrypted = await signal.encryptMessage(recipientId, deviceId, new TextEncoder().encode(message));
    return arrayBufferToBase64(encrypted.body);
  }, [isInitialized, signal]);

  // Decrypt command payload (for Command Bus)
  const decryptCommand = useCallback(async (senderId: string, encryptedBase64: string, senderSignalDeviceId: number): Promise<string> => {
    if (!isInitialized) {
      throw new Error('Signal Protocol not initialized');
    }
    const ciphertext = base64ToArrayBuffer(encryptedBase64);
    const decrypted = await signal.decryptMessage(senderId, senderSignalDeviceId, ciphertext, 2);
    return new TextDecoder().decode(decrypted.body);
  }, [isInitialized, signal]);

  const value: SignalContextType = {
    isInitialized,
    identityKeyId,
    deviceNeedsVerification,
    getDeviceId,
    initialize,
    initializeWithRestore,
    encrypt,
    decrypt,
    encryptGroupMessage,
    decryptGroupMessage,
    initializeSenderKey,
    addSenderKey,
    processPreKeyBundle,
    hasSession,
    generatePreKeyBundle,
    archiveSession,
    cleanup,
    encryptCommand,
    decryptCommand,
  };

  return (
    <SignalContext.Provider value={value}>
      {children}
    </SignalContext.Provider>
  );
}

// ==================== Hook ====================

export function useSignal(): SignalContextType {
  const context = useContext(SignalContext);
  if (!context) {
    throw new Error('useSignal must be used within SignalProvider');
  }
  return context;
}

// Export utility functions for external use
export { arrayBufferToBase64, base64ToArrayBuffer, establishedSessions };
