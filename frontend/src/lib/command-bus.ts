/**
 * Command Bus - Unified command delivery system for ZeroChat
 * 
 * Features:
 * - P2P encryption via Signal Protocol
 * - Server-mediated commands
 * - Multi-device synchronization
 * - Retry logic with exponential backoff
 * - Event subscription system
 * - Idempotency protection
 */

import type { CommandType, CommandMetadata, EncryptedPayload } from '@/types';
import { validateCommandPayload, createCommandMetadata } from './command-validators';

// ==================== Types ====================

export interface CommandBusConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

interface PendingCommand {
  command: CommandType;
  payload: Record<string, unknown>;
  timestamp: number;
  retryCount: number;
  resolve: ((value: string) => void) | null;
  reject: ((error: Error) => void) | null;
  options: CommandOptions;
  /**
   * Set when ack/error arrives BEFORE waitForAck attaches resolve/reject.
   * Allows waitForAck to resolve/reject immediately instead of rejecting with "Command not found".
   */
  result?: { status: 'executed' | 'received' | 'failed' | 'error'; payload: unknown };
}

export interface CommandOptions {
  encrypt?: boolean;
  recipientId?: string;
  targetSignalDeviceId?: number;
  chatId?: string;
  priority?: CommandPriority;
  timeout?: number;
}

export interface CommandEvent {
  type: 'ack' | 'event' | 'error';
  commandId: string;
  commandType: CommandType;
  payload: Record<string, unknown>;
  result?: unknown;
  timestamp: number;
}


export type CommandEventCallback = (event: CommandEvent) => void;

export type CommandPriority = 'low' | 'normal' | 'high' | 'critical';

// ==================== Default Config ====================

const DEFAULT_CONFIG: CommandBusConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
};

// ==================== CommandBus Class ====================

export class CommandBus {
  private config: CommandBusConfig;
  private pendingCommands: Map<string, PendingCommand>;
  private eventListeners: Set<CommandEventCallback>;
  private isProcessing: boolean;
  
  // Dependencies (injected)
  private wsSend: (message: { type: string; payload: unknown; timestamp: number; id: string }) => void;
  private encryptFn: (recipientId: string, recipientDeviceId: number, message: string) => Promise<{ body: string; type: number }>;
  private decryptFn: (senderId: string, senderDeviceId: number, message: Uint8Array, messageType: number) => Promise<string>;
  private currentUserId: string | null;
  private currentDeviceId: string | null;
  private signalDeviceId: number | null;

  constructor(
    config: Partial<CommandBusConfig> = {},
    deps: {
      wsSend: (message: { type: string; payload: unknown; timestamp: number; id: string }) => void;
      encrypt: (recipientId: string, recipientDeviceId: number, message: string) => Promise<{ body: string; type: number }>;
      decrypt: (senderId: string, senderDeviceId: number, message: Uint8Array, messageType: number) => Promise<string>;
      getCurrentUserId: () => string | null;
      getCurrentDeviceId: () => string | null;
      getSignalDeviceId: () => number | null;
    }
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.pendingCommands = new Map();
    this.eventListeners = new Set();
    this.isProcessing = false;
    
    this.wsSend = deps.wsSend;
    this.encryptFn = deps.encrypt;
    this.decryptFn = deps.decrypt;
    this.currentUserId = deps.getCurrentUserId();
    this.currentDeviceId = deps.getCurrentDeviceId();
    this.signalDeviceId = deps.getSignalDeviceId();
  }

  // ==================== Public API ====================

  /**
   * Send a command
   */
  async sendCommand(
    command: CommandType,
    payload: Record<string, unknown>,
    options: CommandOptions = {}
  ): Promise<string> {
    // Validate payload
    const validatedPayload = validateCommandPayload(command, payload);

    // Generate command ID
    const commandId = crypto.randomUUID();
    const now = Date.now();

    // Create metadata
    const metadata = createCommandMetadata(
      this.currentUserId!,
      this.currentDeviceId!,
      this.signalDeviceId || undefined,
      options.priority || 'normal',
      options.encrypt || false
    );

    const commandMessage = {
      commandId,
      command,
      payload: validatedPayload,
      metadata,
    };

    // Encrypt if needed
    let finalPayload: Record<string, unknown> | EncryptedPayload = validatedPayload;
    if (options.encrypt) {
      if (!options.recipientId && !options.targetSignalDeviceId) {
        throw new Error('Encryption requires recipientId or targetSignalDeviceId');
      }
      
      const encrypted = await this.encryptCommandPayload(
        validatedPayload,
        options.recipientId!,
        options.targetSignalDeviceId
      );
      finalPayload = encrypted as EncryptedPayload;
    }

    // Create pending command
    const pending: PendingCommand = {
      command,
      payload: validatedPayload,
      timestamp: now,
      retryCount: 0,
      resolve: null,
      reject: null,
      options,
    };

    this.pendingCommands.set(commandId, pending);

    // Send via WebSocket
    try {
      this.wsSend({
        type: 'command',
        payload: { ...commandMessage, payload: finalPayload },
        timestamp: now,
        id: commandId,
      });
    } catch (error) {
      this.pendingCommands.delete(commandId);
      throw error;
    }

    // Wait for ack or timeout
    return this.waitForAck(commandId, options.timeout);
  }

  /**
   * Decrypt an encrypted command payload
   */
  async decryptCommandPayload(
    encryptedBase64: string,
    senderId: string,
    senderSignalDeviceId: number
  ): Promise<Record<string, unknown>> {
    try {
      const decrypted = await this.decryptFn(
        senderId,
        senderSignalDeviceId,
        this.base64ToUint8Array(encryptedBase64),
        2 // SignalMessage type
      );
      return JSON.parse(decrypted);
    } catch (error) {
      console.error('[CommandBus] Decryption failed:', error);
      throw new Error(`Failed to decrypt command payload: ${error}`);
    }
  }

  /**
   * Subscribe to command events (ack, event, error)
   */
  subscribeToCommandEvents(callback: CommandEventCallback): () => void {
    this.eventListeners.add(callback);
    return () => this.eventListeners.delete(callback);
  }

  /**
   * Retry a failed command
   */
  async retryFailedCommand(commandId: string): Promise<string> {
    const pending = this.pendingCommands.get(commandId);
    if (!pending) {
      throw new Error(`Command ${commandId} not found or already completed`);
    }

    // Increment retry count
    pending.retryCount++;

    if (pending.retryCount > this.config.maxRetries) {
      this.pendingCommands.delete(commandId);
      const error = new Error(`Max retries exceeded for command ${commandId}`);
      pending.reject?.(error);
      throw error;
    }

    // Calculate delay with exponential backoff
    const delay = Math.min(
      this.config.baseDelayMs * Math.pow(2, pending.retryCount - 1),
      this.config.maxDelayMs
    );

    await this.sleep(delay);

    // Resend command
    const now = Date.now();
    const metadata = createCommandMetadata(
      this.currentUserId!,
      this.currentDeviceId!,
      this.signalDeviceId || undefined,
      pending.options.priority || 'normal',
      pending.options.encrypt || false
    );

    const commandMessage = {
      commandId,
      command: pending.command,
      payload: pending.payload,
      metadata,
    };

    try {
      this.wsSend({
        type: 'command',
        payload: commandMessage,
        timestamp: now,
        id: commandId,
      });
    } catch (error) {
      // Will retry again if failed
      throw error;
    }

    return this.waitForAck(commandId);
  }

  /**
   * Handle incoming command_ack
   */
  handleCommandAck(payload: Record<string, unknown>): void {
    const { commandId, status } = payload as { commandId: string; status: string };
    const pending = this.pendingCommands.get(commandId);

    if (!pending) {
      return; // Unknown command ID, ignore
    }

    if (status === 'executed' || status === 'received') {
      // Stash result so a late waitForAck can still resolve (race condition:
      // ack arrives before sendCommand's waitForAck attaches resolve/reject).
      pending.result = { status, payload: commandId };
      if (pending.resolve) {
        this.pendingCommands.delete(commandId);
        pending.resolve(commandId);
      }
    } else if (status === 'failed') {
      const error = new Error((payload as { error?: { message?: string } }).error?.message || 'Command failed');
      pending.result = { status: 'failed', payload: error };
      if (pending.reject) {
        this.pendingCommands.delete(commandId);
        pending.reject(error);
      }
    }

    // Emit event
    this.emitEvent({
      type: 'ack',
      commandId,
      commandType: payload.commandType as CommandType,
      payload,
      timestamp: Date.now(),
    });
  }

  /**
   * Handle incoming command_event
   */
    async handleCommandEvent(payload: Record<string, unknown>): Promise<void> {
    const { commandId, commandType, payload: eventPayload, result } = payload as { 
      commandId: string; 
      commandType: string; 
      payload: Record<string, unknown>;
      result?: unknown;
    };

    // Emit event (with decrypted payload if needed)
    this.emitEvent({
      type: 'event',
      commandId,
      commandType: commandType as CommandType,
      payload: eventPayload,
      result,
      timestamp: Date.now(),
    });
  }


  /**
   * Handle incoming command_error
   */
  handleCommandError(payload: Record<string, unknown>): void {
    const { commandId } = payload as { commandId: string };

    // Try to find pending command
    const pending = this.pendingCommands.get(commandId);
    if (pending) {
      const error = new Error((payload as { error: { message: string } }).error.message);
      pending.result = { status: 'error', payload: error };
      if (pending.reject) {
        this.pendingCommands.delete(commandId);
        pending.reject(error);
      }
    }

    // Emit event
    this.emitEvent({
      type: 'error',
      commandId,
      commandType: payload.commandType as CommandType,
      payload,
      timestamp: Date.now(),
    });
  }

  /**
   * Clear all pending commands (e.g., on logout)
   */
  clearPendingCommands(): void {
    for (const [commandId, pending] of this.pendingCommands) {
      const error = new Error('Command bus cleared');
      pending.reject?.(error);
    }
    this.pendingCommands.clear();
  }

  /**
   * Update current user/device info
   */
  updateAuthInfo(userId: string, deviceId: string, signalDeviceId?: number): void {
    this.currentUserId = userId;
    this.currentDeviceId = deviceId;
    this.signalDeviceId = signalDeviceId ?? null;
  }

  // ==================== Private Methods ====================

  private waitForAck(commandId: string, timeoutMs?: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const pending = this.pendingCommands.get(commandId);
      if (!pending) {
        reject(new Error(`Command ${commandId} not found`));
        return;
      }

      // Race-condition guard: ack/error arrived before waitForAck attached
      // resolve/reject. Resolve immediately from stashed result.
      if (pending.result) {
        this.pendingCommands.delete(commandId);
        const { status, payload } = pending.result;
        if (status === 'executed' || status === 'received') {
          resolve(payload as string);
        } else {
          reject(payload as Error);
        }
        return;
      }

      pending.resolve = resolve;
      pending.reject = reject;

      const timeout = timeoutMs ?? 30000; // 30 seconds default
      setTimeout(() => {
        if (this.pendingCommands.has(commandId)) {
          this.pendingCommands.delete(commandId);
          reject(new Error(`Command ${commandId} timed out`));
        }
      }, timeout);
    });
  }

  private async encryptCommandPayload(
    payload: Record<string, unknown>,
    recipientId: string,
    targetSignalDeviceId?: number
  ): Promise<EncryptedPayload> {
    const payloadStr = JSON.stringify(payload);
    
    let encrypted;
    if (targetSignalDeviceId) {
      // Multi-device: encrypt for own other device
      encrypted = await this.encryptFn(
        this.currentUserId!, // recipient = self
        targetSignalDeviceId,
        payloadStr
      );
    } else {
      // P2P: encrypt for other user
      encrypted = await this.encryptFn(
        recipientId,
        this.signalDeviceId!,
        payloadStr
      );
    }

    return {
      encryptedBase64: encrypted.body,
      encryptionType: 'signal_pqxdh',
    };
  }

  private emitEvent(event: CommandEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (error) {
        console.error('[CommandBus] Event listener error:', error);
      }
    }
  }

  /**
   * Subscribe to command events
   */
  on(listener: CommandEventCallback): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private base64ToUint8Array(base64: string): Uint8Array {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
  }
}

// ==================== Singleton Instance ====================

let commandBusInstance: CommandBus | null = null;

export function createCommandBus(
  config: Partial<CommandBusConfig> = {},
  deps: {
    wsSend: (message: { type: string; payload: unknown; timestamp: number; id: string }) => void;
    encrypt: (recipientId: string, recipientDeviceId: number, message: string) => Promise<{ body: string; type: number }>;
    decrypt: (senderId: string, senderDeviceId: number, message: Uint8Array, messageType: number) => Promise<string>;
    getCurrentUserId: () => string | null;
    getCurrentDeviceId: () => string | null;
    getSignalDeviceId: () => number | null;
  }
): CommandBus {
  if (!commandBusInstance) {
    commandBusInstance = new CommandBus(config, deps);
  }
  return commandBusInstance;
}

export function getCommandBus(): CommandBus | null {
  return commandBusInstance;
}

export function resetCommandBus(): void {
  commandBusInstance = null;
}
