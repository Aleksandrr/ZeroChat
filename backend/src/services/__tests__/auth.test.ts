import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { prisma } from '../../prisma/client';
import { registerUser, loginUser, logoutUser, refreshTokens, getUserById, unregisterDevice } from '../auth';
import { hashPassword, verifyPassword } from '../../utils/password';
import type { PrismaClient } from '@prisma/client';

describe('Auth Service - Unit Tests', () => {
  const testUsername = `testuser_${Date.now()}`;
  const testPassword = 'StrongP@ssw0rd123!';
  const testDisplayName = 'Test User';
  
  let userId: string;
  let deviceId: string;
  let refreshToken: string;
  let tokenId: string;

  beforeAll(async () => {
    // Clean up any existing test data
    await prisma.user.deleteMany({
      where: { username: { startsWith: 'testuser_' } }
    });
  });

  afterAll(async () => {
    // Cleanup
    await prisma.user.deleteMany({
      where: { username: { startsWith: 'testuser_' } }
    });
  });

  describe('registerUser', () => {
    it('should successfully register a new user with valid credentials', async () => {
      const result = await registerUser(testUsername, testPassword, testDisplayName);
      
      expect(result.user).toBeDefined();
      expect(result.user.username).toBe(testUsername);
      expect(result.user.displayName).toBe(testDisplayName);
      expect(result.tokens.accessToken).toBeDefined();
      expect(result.tokens.refreshToken).toBeDefined();
      expect(result.tokens.expiresIn).toBe(900); // 15 minutes
      expect(result.deviceId).toBeDefined();
      expect(result.deviceNeedsVerification).toBe(false); // First device auto-verified
      
      userId = result.user.id;
      deviceId = result.deviceId;
      refreshToken = result.tokens.refreshToken;
      tokenId = result.tokens.tokenId;
    });

    it('should reject registration with existing username', async () => {
      await expect(registerUser(testUsername, testPassword)).rejects.toThrow('Username already exists');
    });

    it('should reject registration with weak password', async () => {
      const weakPassword = 'weak';
      await expect(registerUser(`newuser_${Date.now()}`, weakPassword)).rejects.toThrow('Password validation failed');
    });

    it('should create a favorites chat for new user', async () => {
      const chat = await prisma.chat.findFirst({
        where: {
          type: 'FAVORITES',
          createdById: userId
        }
      });
      expect(chat).toBeDefined();
      expect(chat?.name).toBe('Избранное');
    });

    it('should create a device record with verifiedAt set', async () => {
      const device = await prisma.device.findUnique({
        where: { deviceId }
      });
      expect(device).toBeDefined();
      expect(device?.userId).toBe(userId);
      expect(device?.verifiedAt).toBeDefined();
      expect(device?.isActive).toBe(true);
    });
  });

  describe('loginUser', () => {
    let secondDeviceId: string;

    it('should successfully login with valid credentials', async () => {
      const result = await loginUser(testUsername, testPassword, deviceId);
      
      expect(result.user.id).toBe(userId);
      expect(result.tokens.accessToken).toBeDefined();
      expect(result.tokens.refreshToken).toBeDefined();
      expect(result.deviceNeedsVerification).toBe(false); // Known verified device
    });

    it('should reject login with invalid credentials', async () => {
      await expect(loginUser(testUsername, 'wrongpassword')).rejects.toThrow('Invalid credentials');
      await expect(loginUser('nonexistent', testPassword)).rejects.toThrow('Invalid credentials');
    });

    it('should handle login from new device requiring verification', async () => {
      secondDeviceId = `dev_${crypto.randomUUID()}`;
      const result = await loginUser(testUsername, testPassword, secondDeviceId);
      
      expect(result.deviceNeedsVerification).toBe(true); // New device needs verification
      expect(result.deviceId).toBe(secondDeviceId);
    });

    it('should update user status to ONLINE on login', async () => {
      const user = await prisma.user.findUnique({
        where: { id: userId }
      });
      expect(user?.status).toBe('ONLINE');
    });
  });

  describe('logoutUser', () => {
    it('should revoke refresh token on logout', async () => {
      // First login to get fresh tokens
      const loginResult = await loginUser(testUsername, testPassword, deviceId);
      const tokenIdToRevoke = loginResult.tokens.tokenId;
      
      await logoutUser(tokenIdToRevoke);
      
      // Token should be revoked - trying to use it should fail
      // This is tested indirectly as the token won't be found in DB
      const revokedToken = await prisma.refreshToken.findUnique({
        where: { id: tokenIdToRevoke }
      });
      expect(revokedToken?.revoked).toBe(true);
    });

    it('should handle logout with empty tokenId gracefully', async () => {
      await expect(logoutUser('')).resolves.toBeUndefined();
    });
  });

  describe('refreshTokens', () => {
    it('should return new token pair with valid refresh token', async () => {
      const loginResult = await loginUser(testUsername, testPassword, deviceId);
      const freshRefreshToken = loginResult.tokens.refreshToken;
      
      const result = await refreshTokens(freshRefreshToken);
      
      expect(result.accessToken).toBeDefined();
      expect(result.refreshToken).toBeDefined();
      expect(result.refreshToken).not.toBe(freshRefreshToken); // Token rotation
    });

    it('should reject expired refresh token', async () => {
      // Create an expired token scenario
      const loginResult = await loginUser(testUsername, testPassword, deviceId);
      
      // Manually expire the token for testing
      await prisma.refreshToken.update({
        where: { id: loginResult.tokens.tokenId },
        data: { expiresAt: new Date(Date.now() - 1000) }
      });
      
      await expect(refreshTokens(loginResult.tokens.refreshToken)).rejects.toThrow();
    });
  });

  describe('getUserById', () => {
    it('should return user details', async () => {
      const user = await getUserById(userId);
      
      expect(user).toBeDefined();
      expect(user?.id).toBe(userId);
      expect(user?.username).toBe(testUsername);
      expect(user?.displayName).toBe(testDisplayName);
    });

    it('should return null for non-existent user', async () => {
      const user = await getUserById('non-existent-id');
      expect(user).toBeNull();
    });
  });

  describe('unregisterDevice', () => {
    it('should remove device keys and sender keys', async () => {
      // First create some test keys
      const deviceKeys = await prisma.deviceKeys.create({
        data: {
          userId,
          deviceId,
          identityKey: Buffer.from('test-identity-key'),
          signedPreKey: Buffer.from('test-signed-prekey'),
          preKeys: [{ keyId: 1, key: Buffer.from('test-prekey') }]
        }
      });

      await prisma.senderKeyDistribution.create({
        data: {
          senderUserId: userId,
          senderDeviceId: deviceId,
          distributionId: 1,
          distributionKey: Buffer.from('test-distribution-key')
        }
      });

      // Unregister
      await unregisterDevice(userId, deviceId);

      // Keys should be deleted
      const remainingKeys = await prisma.deviceKeys.findMany({
        where: { userId, deviceId }
      });
      expect(remainingKeys.length).toBe(0);

      const senderKeys = await prisma.senderKeyDistribution.findMany({
        where: { senderUserId: userId, senderDeviceId: deviceId }
      });
      expect(senderKeys.length).toBe(0);
    });
  });
});

describe('Auth Service - Integration Tests (Device Verification Flow)', () => {
  const username = `verifytest_${Date.now()}`;
  const password = 'StrongP@ssw0rd123!';
  let firstDeviceId: string;
  let secondDeviceId: string;
  let userId: string;

  beforeAll(async () => {
    await prisma.user.deleteMany({
      where: { username: { startsWith: 'verifytest_' } }
    });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({
      where: { username: { startsWith: 'verifytest_' } }
    });
  });

  it('should auto-verify first device on registration', async () => {
    const result = await registerUser(username, password);
    userId = result.user.id;
    firstDeviceId = result.deviceId;
    
    expect(result.deviceNeedsVerification).toBe(false);
    
    const device = await prisma.device.findUnique({
      where: { deviceId: firstDeviceId }
    });
    expect(device?.verifiedAt).toBeDefined();
  });

  it('should require verification for second device', async () => {
    secondDeviceId = `dev_${crypto.randomUUID()}`;
    const result = await loginUser(username, password, secondDeviceId);
    
    expect(result.deviceNeedsVerification).toBe(true);
    
    const device = await prisma.device.findUnique({
      where: { deviceId: secondDeviceId }
    });
    expect(device?.verifiedAt).toBeNull();
  });

  it('should re-login to same unverified device without creating new one', async () => {
    const result = await loginUser(username, password, secondDeviceId);
    
    expect(result.deviceId).toBe(secondDeviceId);
    expect(result.deviceNeedsVerification).toBe(true);
    
    // Should still be only 2 devices total
    const devices = await prisma.device.findMany({
      where: { userId }
    });
    expect(devices.length).toBe(2);
  });
});

describe('Auth Service - Security Tests', () => {
  it('should not expose password in user object', async () => {
    const username = `sectest_${Date.now()}`;
    const password = 'StrongP@ssw0rd123!';
    
    const result = await registerUser(username, password);
    
    expect((result.user as any).password).toBeUndefined();
    
    const user = await getUserById(result.user.id);
    expect((user as any).password).toBeUndefined();
  });

  it('should hash passwords before storing', async () => {
    const username = `hashtest_${Date.now()}`;
    const password = 'TestPassword123!';
    
    const result = await registerUser(username, password);
    
    const dbUser = await prisma.user.findUnique({
      where: { id: result.user.id }
    });
    
    expect(dbUser?.password).not.toBe(password);
    expect(dbUser?.password).toHaveLength(60); // bcrypt hash length
  });

  it('should generate unique device IDs', async () => {
    const username = `devicetest_${Date.now()}`;
    const password = 'StrongP@ssw0rd123!';
    
    const result1 = await registerUser(username, password);
    const result2 = await loginUser(username, password, `dev_${crypto.randomUUID()}`);
    
    expect(result1.deviceId).not.toBe(result2.deviceId);
  });
});
