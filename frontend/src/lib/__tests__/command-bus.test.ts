import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CommandBus } from '../command-bus';

// Mock dependencies
const mockWsSend = vi.fn();
const mockEncrypt = vi.fn();
const mockDecrypt = vi.fn();
const mockGetCurrentUserId = vi.fn(() => 'user-123');
const mockGetCurrentDeviceId = vi.fn(() => 'device-123');
const mockGetSignalDeviceId = vi.fn(() => 1);

// Helper to generate UUID
const uuid = () => '123e4567-e89b-12d3-a456-426614174000';

describe('CommandBus', () => {
  let commandBus: CommandBus;

  beforeEach(() => {
    vi.clearAllMocks();
    commandBus = new CommandBus(
      { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000 },
      {
        wsSend: mockWsSend,
        encrypt: mockEncrypt,
        decrypt: mockDecrypt,
        getCurrentUserId: mockGetCurrentUserId,
        getCurrentDeviceId: mockGetCurrentDeviceId,
        getSignalDeviceId: mockGetSignalDeviceId,
      }
    );
  });

  describe('sendCommand', () => {
    it('should send command without encryption for server-mediated', async () => {
      const command = 'chat.mute' as any;
      const payload = { chatId: uuid(), mutedUntil: null };

      mockWsSend.mockImplementation(() => Promise.resolve());

      const sendPromise = commandBus.sendCommand(command, payload, { chatId: payload.chatId, timeout: 5000 });

      await Promise.resolve();

      expect(mockWsSend).toHaveBeenCalledTimes(1);
      const sentMessage = mockWsSend.mock.calls[0]![0] as any;

      expect(sentMessage.type).toBe('command');
      expect(sentMessage.payload.command).toBe(command);
      expect(sentMessage.payload.payload).toEqual(payload);
      expect(sentMessage.payload.metadata.issuer.userId).toBe('user-123');
      expect(sentMessage.payload.metadata.issuer.deviceId).toBe('device-123');
      expect(sentMessage.payload.metadata.encrypted).toBe(false);
      expect(sentMessage.id).toBeDefined();

      const commandId = sentMessage.id;

      commandBus.handleCommandAck({
        commandId,
        commandType: command,
        status: 'executed',
      });

      const result = await sendPromise;
      expect(result).toBe(commandId);
    });

    it('should encrypt payload for P2P commands', async () => {
      const command = 'message.delete' as any;
      const payload = { messageId: uuid(), chatId: uuid(), deleteForEveryone: true };
      const recipientId = 'user-456';

      mockEncrypt.mockResolvedValue({ body: 'encrypted-payload', type: 2 });
      mockWsSend.mockImplementation(() => Promise.resolve());

      const sendPromise = commandBus.sendCommand(
        command,
        payload,
        { recipientId, encrypt: true, timeout: 5000 } // P2P: no targetSignalDeviceId
      );

      // Wait for async encrypt and send
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mockEncrypt).toHaveBeenCalledWith(
        recipientId,
        1, // signalDeviceId from mockGetSignalDeviceId
        expect.any(String)
      );

      expect(mockWsSend).toHaveBeenCalledTimes(1);
      const sentMessage = mockWsSend.mock.calls[0]![0] as any;
      expect(sentMessage.payload.payload).toEqual({
        encryptedBase64: 'encrypted-payload',
        encryptionType: 'signal_pqxdh',
      });

      const commandId = sentMessage.id;
      commandBus.handleCommandAck({
        commandId,
        commandType: command,
        status: 'executed',
      });

      const result = await sendPromise;
      expect(result).toBe(commandId);
    });

    it('should generate unique commandId for each command', async () => {
      const command = 'chat.pin' as any;
      const payload = { chatId: uuid() };

      mockWsSend.mockImplementation(() => Promise.resolve());

      const promise1 = commandBus.sendCommand(command, payload, { timeout: 5000 });
      await Promise.resolve();
      const commandId1 = (mockWsSend.mock.calls[0]![0] as any).id;

      const promise2 = commandBus.sendCommand(command, payload, { timeout: 5000 });
      await Promise.resolve();
      const commandId2 = (mockWsSend.mock.calls[1]![0] as any).id;

      commandBus.handleCommandAck({ commandId: commandId1, commandType: command, status: 'executed' });
      commandBus.handleCommandAck({ commandId: commandId2, commandType: command, status: 'executed' });

      const [result1, result2] = await Promise.all([promise1, promise2]);

      expect(result1).not.toBe(result2);
    });

    it('should throw when wsSend fails', async () => {
      const command = 'chat.mute' as any;
      const payload = { chatId: uuid() };

      mockWsSend.mockImplementation(() => {
        throw new Error('Network error');
      });

      const sendPromise = commandBus.sendCommand(command, payload, { timeout: 5000 });

      await expect(sendPromise).rejects.toThrow('Network error');
    });

    it('should validate payload before sending', async () => {
      const command = 'message.delete' as any;
      const payload = { messageId: 'invalid-uuid', chatId: uuid(), deleteForEveryone: true };

      mockWsSend.mockImplementation(() => Promise.resolve());

      const sendPromise = commandBus.sendCommand(command, payload, { timeout: 5000 });

      await expect(sendPromise).rejects.toThrow('Invalid UUID');
      expect(mockWsSend).not.toHaveBeenCalled();
    });
  });

  describe('decryptCommandPayload', () => {
    it('should decrypt encrypted payload', async () => {
      const encryptedBase64 = btoa('encrypted-body');
      const senderId = 'user-456';
      const senderSignalDeviceId = 2;

      mockDecrypt.mockResolvedValue(JSON.stringify({ chatId: uuid(), action: 'mute' }));

      const result = await commandBus.decryptCommandPayload(
        encryptedBase64,
        senderId,
        senderSignalDeviceId
      );

      expect(mockDecrypt).toHaveBeenCalledWith(
        senderId,
        senderSignalDeviceId,
        expect.any(Uint8Array),
        2
      );
      expect(result).toEqual({ chatId: expect.any(String), action: 'mute' });
    });

    it('should throw on decryption failure', async () => {
      const encryptedBase64 = 'invalid-base64';
      mockDecrypt.mockRejectedValue(new Error('Decryption failed'));

      await expect(
        commandBus.decryptCommandPayload(encryptedBase64, 'user-456', 2)
      ).rejects.toThrow('Failed to decrypt command payload');
    });
  });

  describe('subscribeToCommandEvents', () => {
    it('should return unsubscribe function', () => {
      const callback = vi.fn();
      const unsubscribe = commandBus.subscribeToCommandEvents(callback);

      expect(typeof unsubscribe).toBe('function');
    });

    it('should allow multiple subscribers', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      commandBus.subscribeToCommandEvents(callback1);
      commandBus.subscribeToCommandEvents(callback2);

      // @ts-ignore - accessing private field
      expect(commandBus.eventListeners.size).toBe(2);
    });

    it('should call subscribers on event', () => {
      const callback = vi.fn();
      commandBus.subscribeToCommandEvents(callback);

      commandBus.handleCommandEvent({
        commandId: 'cmd-123',
        commandType: 'message.delete',
        payload: { messageId: uuid(), chatId: uuid() },
        timestamp: Date.now(),
      });

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'event',
          commandId: 'cmd-123',
          commandType: 'message.delete',
        })
      );
    });
  });

  describe('retryFailedCommand', () => {
    it('should throw if command not found', async () => {
      await expect(commandBus.retryFailedCommand('non-existent')).rejects.toThrow('not found');
    });

    it('should reject after max retries', async () => {
      const commandId = uuid();
      const command = 'chat.pin' as any;
      const payload = { chatId: uuid() };

      const commandBusAny = commandBus as any;
      commandBusAny.pendingCommands.set(commandId, {
        command,
        payload,
        timestamp: Date.now(),
        retryCount: 3, // maxRetries
        resolve: null,
        reject: null,
        options: {},
      });

      mockWsSend.mockImplementation(() => {
        throw new Error('Network error');
      });

      await expect(commandBus.retryFailedCommand(commandId)).rejects.toThrow('Max retries exceeded');
      expect(mockWsSend).not.toHaveBeenCalled();
    });

    it('should retry once and succeed', async () => {
      const commandId = uuid();
      const command = 'chat.pin' as any;
      const payload = { chatId: uuid() };

      const commandBusAny = commandBus as any;
      commandBusAny.pendingCommands.set(commandId, {
        command,
        payload,
        timestamp: Date.now(),
        retryCount: 0,
        resolve: null,
        reject: null,
        options: {},
      });

      mockWsSend.mockImplementation(() => Promise.resolve());

      const retryPromise = commandBus.retryFailedCommand(commandId);

      // Fast-forward retry delay
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Since wsSend succeeded, the command will be sent and waitForAck will wait for ack
      // We need to ack it to resolve
      commandBus.handleCommandAck({
        commandId,
        commandType: command,
        status: 'executed',
      });

      const result = await retryPromise;
      expect(result).toBe(commandId);
      expect(mockWsSend).toHaveBeenCalledTimes(1);
    });
  });

  describe('handleCommandAck', () => {
    it('should resolve pending command on executed status', async () => {
      const command = 'chat.mute' as any;
      const payload = { chatId: uuid() };

      mockWsSend.mockImplementation(() => Promise.resolve());

      const sendPromise = commandBus.sendCommand(command, payload, { timeout: 5000 });

      await Promise.resolve();

      const sentMessage = mockWsSend.mock.calls[0]![0] as any;
      const commandId = sentMessage.id;

      commandBus.handleCommandAck({
        commandId,
        commandType: command,
        status: 'executed',
      });

      const result = await sendPromise;
      expect(result).toBe(commandId);
    });

    it('should reject pending command on failed status', async () => {
      const command = 'chat.mute' as any;
      const payload = { chatId: uuid() };

      mockWsSend.mockImplementation(() => Promise.resolve());

      const sendPromise = commandBus.sendCommand(command, payload, { timeout: 5000 });

      await Promise.resolve();

      const sentMessage = mockWsSend.mock.calls[0]![0] as any;
      const commandId = sentMessage.id;

      commandBus.handleCommandAck({
        commandId,
        commandType: command,
        status: 'failed',
        error: { message: 'Permission denied' },
      });

      await expect(sendPromise).rejects.toThrow('Permission denied');
    });

    it('should ignore ack for unknown command', () => {
      commandBus.handleCommandAck({
        commandId: 'unknown',
        commandType: 'chat.mute',
        status: 'executed',
      });
    });
  });

  describe('handleCommandEvent', () => {
    it('should emit event for subscribers', () => {
      const callback = vi.fn();
      commandBus.subscribeToCommandEvents(callback);

      commandBus.handleCommandEvent({
        commandId: 'cmd-123',
        commandType: 'message.delete',
        payload: { messageId: uuid(), chatId: uuid() },
        timestamp: Date.now(),
      });

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'event',
          commandId: 'cmd-123',
          commandType: 'message.delete',
        })
      );
    });
  });

  describe('handleCommandError', () => {
    it('should reject pending command on error', async () => {
      const command = 'chat.mute' as any;
      const payload = { chatId: uuid() };

      mockWsSend.mockImplementation(() => Promise.resolve());

      const sendPromise = commandBus.sendCommand(command, payload, { timeout: 5000 });

      await Promise.resolve();

      const sentMessage = mockWsSend.mock.calls[0]![0] as any;
      const commandId = sentMessage.id;

      commandBus.handleCommandError({
        commandId,
        commandType: command,
        error: { message: 'Execution failed' },
      });

      await expect(sendPromise).rejects.toThrow('Execution failed');
    });

    it('should ignore error for unknown command', () => {
      commandBus.handleCommandError({
        commandId: 'unknown',
        commandType: 'chat.mute',
        error: { message: 'Some error' },
      });
    });
  });

  describe('clearPendingCommands', () => {
    it('should reject all pending commands', async () => {
      const command = 'chat.mute' as any;
      const payload = { chatId: uuid() };

      mockWsSend.mockImplementation(() => Promise.resolve());

      const sendPromise1 = commandBus.sendCommand(command, payload, { timeout: 5000 });
      const sendPromise2 = commandBus.sendCommand(command, payload, { timeout: 5000 });

      await Promise.resolve();

      commandBus.clearPendingCommands();

      await expect(sendPromise1).rejects.toThrow('Command bus cleared');
      await expect(sendPromise2).rejects.toThrow('Command bus cleared');
    });
  });

  describe('updateAuthInfo', () => {
    it('should update auth info', () => {
      commandBus.updateAuthInfo('new-user', 'new-device', 5);
    });
  });
});
