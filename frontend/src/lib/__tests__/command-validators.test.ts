import { describe, it, expect } from 'vitest';
import {
  validateCommandPayload,
  createCommandMetadata,
  CommandMetadataSchema,
} from '../command-validators';
import { z } from 'zod';

describe('Command Validators (Frontend)', () => {
  describe('validateCommandPayload', () => {
    it('should validate message.delete payload', () => {
      const payload = {
        messageId: '123e4567-e89b-12d3-a456-426614174000',
        chatId: '223e4567-e89b-12d3-a456-426614174000',
        deleteForEveryone: true,
      };

      const result = validateCommandPayload('message.delete', payload);
      expect(result).toEqual(payload);
    });

    it('should throw for invalid messageId UUID', () => {
      const payload = {
        messageId: 'not-a-uuid', // Invalid UUID
        chatId: '223e4567-e89b-12d3-a456-426614174000',
        deleteForEveryone: true,
      };

      expect(() => validateCommandPayload('message.delete', payload)).toThrow('Invalid UUID');
    });

    it('should throw for invalid chatId UUID', () => {
      const payload = {
        messageId: '123e4567-e89b-12d3-a456-426614174000',
        chatId: 'invalid-chat-id', // Invalid UUID
        deleteForEveryone: true,
      };

      expect(() => validateCommandPayload('message.delete', payload)).toThrow('Invalid UUID');
    });

    it('should validate message.edit payload with content length check', () => {
      const payload = {
        messageId: '123e4567-e89b-12d3-a456-426614174000',
        chatId: '223e4567-e89b-12d3-a456-426614174000',
        content: 'Hello, world!',
        editTimestamp: Date.now(),
      };

      const result = validateCommandPayload('message.edit', payload);
      expect(result.content).toBe('Hello, world!');
    });

    it('should throw for message.edit content too long', () => {
      const payload = {
        messageId: '123e4567-e89b-12d3-a456-426614174000',
        chatId: '223e4567-e89b-12d3-a456-426614174000',
        content: 'a'.repeat(10001),
        editTimestamp: Date.now(),
      };

      expect(() => validateCommandPayload('message.edit', payload)).toThrow('too long');
    });

    it('should validate chat.mute with null mutedUntil', () => {
      const payload = {
        chatId: '123e4567-e89b-12d3-a456-426614174000',
        mutedUntil: null,
      };

      const result = validateCommandPayload('chat.mute', payload);
      expect(result.mutedUntil).toBeNull();
    });

    it('should validate chat.mute with valid datetime', () => {
      const payload = {
        chatId: '123e4567-e89b-12d3-a456-426614174000',
        mutedUntil: new Date(Date.now() + 3600000).toISOString(),
      };

      const result = validateCommandPayload('chat.mute', payload);
      expect(result).toEqual(payload);
    });

    it('should throw for unknown command type', () => {
      const payload = { chatId: '123' };
      expect(() => validateCommandPayload('unknown.command' as any, payload)).toThrow('Unknown command type');
    });
  });

  describe('createCommandMetadata', () => {
    it('should create valid metadata', () => {
      const metadata = createCommandMetadata(
        'user-123',
        'device-123',
        1,
        'normal',
        false
      );

      expect(metadata).toEqual({
        version: 1,
        issuer: {
          userId: 'user-123',
          deviceId: 'device-123',
          signalDeviceId: 1,
        },
        priority: 'normal',
        encrypted: false,
        createdAt: expect.any(Number),
      });
    });

    it('should handle optional signalDeviceId', () => {
      const metadata = createCommandMetadata(
        'user-123',
        'device-123',
        undefined,
        'high',
        true
      );

      expect(metadata.issuer.signalDeviceId).toBeUndefined();
      expect(metadata.priority).toBe('high');
      expect(metadata.encrypted).toBe(true);
    });
  });

  describe('All command schemas', () => {
    const commandTypes = [
      'message.delete', 'message.edit', 'message.pin', 'message.unpin',
      'message.react', 'message.unreact', 'message.reply',
      'chat.delete', 'chat.leave', 'chat.update', 'chat.mute', 'chat.unmute',
      'chat.pin', 'chat.unpin', 'chat.archive', 'chat.unarchive',
      'folder.create', 'folder.update', 'folder.delete',
      'folder.add_chat', 'folder.remove_chat', 'folder.reorder',
      'participant.add', 'participant.remove', 'participant.role_update',
      'system.clear_chat', 'system.export_chat', 'system.report_message',
    ];

    it('should have validator function for each command type', () => {
      // All command types should be handled in validateCommandPayload
      for (const cmd of commandTypes) {
        expect(() => validateCommandPayload(cmd as any, {})).not.toThrow('Unknown command type');
      }
    });
  });
});
