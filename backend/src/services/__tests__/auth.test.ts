import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the prisma client - must be before imports
vi.mock('../../prisma/client', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn(),
    },
    device: {
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    chat: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    chatParticipant: {
      create: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    refreshToken: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    deviceKey: {
      deleteMany: vi.fn(),
    },
    senderKey: {
      deleteMany: vi.fn(),
    },
    $transaction: vi.fn((fn) => 
      fn({
        user: { 
          create: vi.fn((data) => Promise.resolve({ id: 'tx-user-id', ...data.data, createdAt: new Date() })), 
          findUnique: vi.fn(), 
          findFirst: vi.fn() 
        },
        device: { 
          create: vi.fn(), 
          findUnique: vi.fn(), 
          findMany: vi.fn().mockResolvedValue([]) 
        },
        chat: { create: vi.fn(), findFirst: vi.fn() },
        chatParticipant: { create: vi.fn() },
        refreshToken: { create: vi.fn().mockResolvedValue({ id: 'tx-refresh-token-id', token: 'tx-refresh-token', expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) }) },
        deviceKey: { deleteMany: vi.fn() },
        senderKey: { deleteMany: vi.fn() },
      })
    ),
  }
}));

// Mock password utils - include all exports
vi.mock('../../utils/password', () => ({
  hashPassword: vi.fn().mockResolvedValue('$argon2id$v=19$m=65536,p=4,t=3$mocksalt$mockhash'),
  verifyPassword: vi.fn().mockResolvedValue(true),
  isPasswordStrong: vi.fn((pwd) => {
    const strong = pwd.length >= 8 && /[A-Z]/.test(pwd) && /[a-z]/.test(pwd) && /[0-9]/.test(pwd) && /[^A-Za-z0-9]/.test(pwd);
    return {
      isValid: strong,
      errors: strong ? [] : ['Password too weak'],
    };
  }),
  hashSecret: vi.fn().mockResolvedValue('$argon2id$v=19$m=65536,p=4,t=3$mocksalt$mockhash'),
  generateSecureRandomPassword: vi.fn().mockReturnValue('SecureP@ss123!'),
}));

// Import after mocking
import { prisma } from '../../prisma/client';
import { registerUser, loginUser, logoutUser, getUserById } from '../auth';

describe('Auth Service - Unit Tests', () => {
  const testUsername = `testuser_${Date.now()}`;
  const testPassword = 'StrongP@ssw0rd123!';
  const testDisplayName = 'Test User';
  const testUserId = 'test-user-id-123';
  const testDeviceId = 'dev_test-device-id';

  beforeEach(() => {
    vi.clearAllMocks();
    
    // Setup default mock responses
    (prisma.user.findUnique as any).mockResolvedValue(null);
    (prisma.user.create as any).mockResolvedValue({
      id: testUserId,
      username: testUsername,
      displayName: testDisplayName,
      createdAt: new Date(),
    });
    (prisma.device.create as any).mockResolvedValue({ deviceId: testDeviceId });
    (prisma.device.findMany as any).mockResolvedValue([]);
    (prisma.chat.create as any).mockResolvedValue({ id: 'chat-favorites' });
    (prisma.chatUser.create as any).mockResolvedValue({});
    (prisma.refreshToken.create as any).mockResolvedValue({
      id: 'refresh-token-id',
      token: 'mock-refresh-token',
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
  });

  describe('registerUser', () => {
    it('should successfully register a new user with valid credentials', async () => {
      const result = await registerUser(testUsername, testPassword, testDisplayName);
      
      expect(result).toBeDefined();
      expect(result.user).toBeDefined();
      expect(result.user.username).toBe(testUsername);
      expect(result.tokens.accessToken).toBeDefined();
      expect(result.tokens.refreshToken).toBeDefined();
      expect(result.deviceId).toBeDefined();
    });

    it('should reject registration with existing username', async () => {
      (prisma.user.findUnique as any).mockResolvedValueOnce({
        id: 'existing-user-id',
        username: testUsername,
      });
      
      await expect(registerUser(testUsername, testPassword)).rejects.toThrow('Username already exists');
    });

    it('should reject registration with weak password', async () => {
      const weakPassword = 'weak';
      await expect(registerUser(`newuser_${Date.now()}`, weakPassword)).rejects.toThrow('Password validation failed');
    });
  });

  describe('loginUser', () => {
    it('should reject login with invalid credentials', async () => {
      (prisma.user.findUnique as any).mockResolvedValue(null);
      
      await expect(loginUser(testUsername, 'wrongpassword')).rejects.toThrow('Invalid credentials');
    });

    it('should handle logout with empty tokenId gracefully', async () => {
      await expect(logoutUser('')).resolves.not.toThrow();
    });
  });

  describe('getUserById', () => {
    it('should return null for non-existent user', async () => {
      (prisma.user.findUnique as any).mockResolvedValue(null);
      
      const user = await getUserById('non-existent-id');
      expect(user).toBeNull();
    });
  });
});

describe('Auth Service - Security Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.user.findUnique as any).mockResolvedValue(null);
    (prisma.user.create as any).mockResolvedValue({
      id: 'test-user-id',
      username: 'sectest_user',
      displayName: 'Security Test',
      createdAt: new Date(),
    });
    (prisma.device.create as any).mockResolvedValue({ deviceId: 'dev_sec_test' });
    (prisma.device.findMany as any).mockResolvedValue([]);
    (prisma.chat.create as any).mockResolvedValue({ id: 'chat-favorites' });
    (prisma.chatUser.create as any).mockResolvedValue({});
    (prisma.refreshToken.create as any).mockResolvedValue({
      id: 'refresh-token-id',
      token: 'mock-refresh-token',
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
  });

  it('should not expose password in user object', async () => {
    const result = await registerUser('sectest_user', 'StrongP@ssw0rd123!');
    
    expect((result.user as any).password).toBeUndefined();
  });

  it('should generate unique device IDs', async () => {
    const result1 = await registerUser('devicetest_user1', 'StrongP@ssw0rd123!');
    (prisma.user.findUnique as any).mockResolvedValue({
      id: 'existing-user',
      username: 'devicetest_user1',
      displayName: 'Device Test',
      createdAt: new Date(),
      password: '$argon2id$v=19$m=65536,p=4,t=3$mocksalt$mockhash',
    });
    const result2 = await loginUser('devicetest_user1', 'StrongP@ssw0rd123!', `dev_${crypto.randomUUID()}`);
    
    expect(result1.deviceId).not.toBe(result2.deviceId);
  });
});
