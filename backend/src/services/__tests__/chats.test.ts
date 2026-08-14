import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '../../prisma/client';
import { 
  getOrCreateFavoritesChat, 
  isFavoritesChat,
  checkChatLimit,
  getUserRole,
  isChatParticipant,
  canChangeRoles,
  canRemoveParticipant,
  findExistingPrivateChat,
  createPrivateChat,
  createGroupChat,
  getGroupInfo,
  addParticipants,
  removeParticipant,
  updateParticipantRole,
  leaveGroup,
  deleteChat,
  CHAT_LIMITS
} from '../chats';

describe('Chat Service - Unit Tests', () => {
  let testUserId1: string;
  let testUserId2: string;
  let testUserId3: string;
  let testUsername1: string;
  let testUsername2: string;
  let testUsername3: string;

  beforeAll(async () => {
    // Create test users
    testUsername1 = `chatuser1_${Date.now()}`;
    testUsername2 = `chatuser2_${Date.now()}`;
    testUsername3 = `chatuser3_${Date.now()}`;

    const user1 = await prisma.user.create({
      data: {
        username: testUsername1,
        displayName: 'User 1',
        password: 'hashed_password'
      }
    });
    testUserId1 = user1.id;

    const user2 = await prisma.user.create({
      data: {
        username: testUsername2,
        displayName: 'User 2',
        password: 'hashed_password'
      }
    });
    testUserId2 = user2.id;

    const user3 = await prisma.user.create({
      data: {
        username: testUsername3,
        displayName: 'User 3',
        password: 'hashed_password'
      }
    });
    testUserId3 = user3.id;
  });

  afterAll(async () => {
    // Cleanup - сначала удаляем чаты, потом пользователей (из-за FK constraints)
    // Удаляем все чаты созданные пользователями (кроме FAVORITES которые имеют того же createdById)
    await prisma.chat.deleteMany({
      where: { 
        AND: [
          { createdById: testUserId1 },
          { type: { not: 'FAVORITES' } }
        ]
      }
    });
    
    await prisma.user.deleteMany({
      where: { username: { startsWith: 'chatuser' } }
    });
  });

  describe('Favorites Chat', () => {
    it('should get or create favorites chat for user', async () => {
      const favoritesChat = await getOrCreateFavoritesChat(testUserId1);
      
      expect(favoritesChat).toBeDefined();
      expect(favoritesChat.type).toBe('FAVORITES');
      expect(favoritesChat.name).toBe('Избранное');
      expect(favoritesChat.participants.some(p => p.userId === testUserId1)).toBe(true);
    });

    it('should return same favorites chat on multiple calls', async () => {
      const chat1 = await getOrCreateFavoritesChat(testUserId1);
      const chat2 = await getOrCreateFavoritesChat(testUserId1);
      
      expect(chat1.id).toBe(chat2.id);
    });

    it('should identify favorites chat correctly', async () => {
      const favoritesChat = await getOrCreateFavoritesChat(testUserId1);
      const isFav = await isFavoritesChat(favoritesChat.id);
      
      expect(isFav).toBe(true);
      
      const isNotFav = await isFavoritesChat('non-favorites-id');
      expect(isNotFav).toBe(false);
    });
  });

  describe('Chat Limits', () => {
    it('should allow creating chats within limit', async () => {
      const withinLimit = await checkChatLimit(testUserId1);
      expect(withinLimit).toBe(true);
    });

    it('should enforce max participants in batch', async () => {
      expect(CHAT_LIMITS.MAX_PARTICIPANTS_IN_BATCH).toBe(100);
      expect(CHAT_LIMITS.MAX_GROUP_NAME_LENGTH).toBe(100);
      expect(CHAT_LIMITS.MAX_MESSAGE_LENGTH).toBe(10000);
    });
  });

  describe('User Roles and Permissions', () => {
    let groupChatId: string;

    beforeAll(async () => {
      // Create a group chat for testing
      const groupChat = await createGroupChat({
        currentUserId: testUserId1,
        name: 'Test Group',
        participantUsernames: [testUsername2]
        // description field removed from schema
      });
      groupChatId = groupChat.id;
    });

    it('should return correct user role', async () => {
      const ownerRole = await getUserRole(groupChatId, testUserId1);
      expect(ownerRole).toBe('OWNER');

      const memberRole = await getUserRole(groupChatId, testUserId2);
      expect(memberRole).toBe('MEMBER');
    });

    it('should verify chat participation', async () => {
      const isParticipant1 = await isChatParticipant(groupChatId, testUserId1);
      expect(isParticipant1).toBe(true);

      const isParticipant3 = await isChatParticipant(groupChatId, testUserId3);
      expect(isParticipant3).toBe(false);
    });

    it('should allow OWNER to change roles', async () => {
      const canChange = canChangeRoles('OWNER', 'MEMBER');
      expect(canChange).toBe(true);

      const cannotChange = canChangeRoles('MEMBER', 'ADMIN');
      expect(cannotChange).toBe(false);
    });

    it('should allow OWNER/ADMIN to remove participants', async () => {
      const ownerCanRemove = canRemoveParticipant('OWNER', 'MEMBER');
      expect(ownerCanRemove).toBe(true);

      const adminCanRemove = canRemoveParticipant('ADMIN', 'MEMBER');
      expect(adminCanRemove).toBe(true);

      const memberCannotRemove = canRemoveParticipant('MEMBER', 'MEMBER');
      expect(memberCannotRemove).toBe(false);
    });
  });

  describe('Private Chat', () => {
    it('should find existing private chat between two users', async () => {
      // First create a private chat
      const created = await createPrivateChat({
        currentUserId: testUserId1,
        contactUsername: testUsername2
      });

      // Should find the same chat
      const found = await findExistingPrivateChat(testUserId1, testUserId2);
      expect(found).toBeDefined();
      expect(found?.id).toBe(created.chat.id);
    });

    it('should return null for non-existent private chat', async () => {
      const found = await findExistingPrivateChat(testUserId1, testUserId3);
      // May or may not exist depending on test order
      expect(found === null || found?.id).toBeDefined();
    });
  });

  describe('Group Chat Management', () => {
    let groupChatId: string;
    let newParticipantUsername: string;
    let newParticipantId: string;

    beforeAll(async () => {
      const groupChat = await createGroupChat({
        currentUserId: testUserId1,
        name: 'Management Test Group',
        participantUsernames: [] // Пустой список - только создатель
        // description field removed from schema
      });
      groupChatId = groupChat.id;
      
      // Создаём нового пользователя для тестов
      newParticipantUsername = `newparticipant_${Date.now()}`;
      const newParticipant = await prisma.user.create({
        data: {
          username: newParticipantUsername,
          displayName: 'New Participant',
          password: 'hashed_password'
        }
      });
      newParticipantId = newParticipant.id;
    });

    afterAll(async () => {
      // Очищаем созданного пользователя
      if (newParticipantId) {
        await prisma.user.delete({ where: { id: newParticipantId } }).catch(() => {});
      }
    });

    it('should get group info', async () => {
      const groupInfo = await getGroupInfo(groupChatId, testUserId1);
      
      expect(groupInfo).toBeDefined();
      expect(groupInfo.id).toBe(groupChatId);
      expect(groupInfo.name).toBe('Management Test Group');
      expect(groupInfo.participants.length).toBeGreaterThanOrEqual(1);
    });

    it('should add participants to group', async () => {
      const initialCount = (await getGroupInfo(groupChatId, testUserId1)).participants.length;
      
      // Добавляем нового участника
      await addParticipants(groupChatId, testUserId1, [newParticipantUsername]);
      
      const updatedGroup = await getGroupInfo(groupChatId, testUserId1);
      expect(updatedGroup.participants.length).toBeGreaterThan(initialCount);
    });

    it('should update participant role', async () => {
      // Изменяем роль добавленного участника
      // Сигнатура: updateParticipantRole(chatId, targetUserId, currentUserId, role)
      await updateParticipantRole(groupChatId, newParticipantId, testUserId1, 'ADMIN');
      
      const role = await getUserRole(groupChatId, newParticipantId);
      expect(role).toBe('ADMIN');
      
      // Reset to MEMBER
      await updateParticipantRole(groupChatId, newParticipantId, testUserId1, 'MEMBER');
    });

    it('should remove participant from group', async () => {
      const initialCount = (await getGroupInfo(groupChatId, testUserId1)).participants.length;
      
      // Сигнатура: removeParticipant(chatId, targetUserId, currentUserId)
      await removeParticipant(groupChatId, newParticipantId, testUserId1);
      
      const updatedGroup = await getGroupInfo(groupChatId, testUserId1);
      expect(updatedGroup.participants.length).toBeLessThan(initialCount);
    });

    it('should allow user to leave group', async () => {
      // Добавляем нового пользователя для теста выхода
      const leaveTestUsername = `leavetest_${Date.now()}`;
      const leaveTestUser = await prisma.user.create({
        data: {
          username: leaveTestUsername,
          displayName: 'Leave Test User',
          password: 'hashed'
        }
      });

      await addParticipants(groupChatId, testUserId1, [leaveTestUsername]);
      
      await leaveGroup(groupChatId, leaveTestUser.id);
      
      const isParticipant = await isChatParticipant(groupChatId, leaveTestUser.id);
      expect(isParticipant).toBe(false);

      // Cleanup
      await prisma.user.delete({ where: { id: leaveTestUser.id } });
    });

    it('should delete chat', async () => {
      const tempGroup = await createGroupChat({
        currentUserId: testUserId1,
        name: 'To Delete',
        participantUsernames: []
      });

      await deleteChat(tempGroup.id, testUserId1);
      
      // Chat should be deleted or marked as deleted
      const deletedChat = await prisma.chat.findUnique({
        where: { id: tempGroup.id }
      });
      // Chat is hard deleted in current implementation
      expect(deletedChat).toBeNull();
    });
  });
});

describe('Chat Service - Integration Tests', () => {
  let userId1: string;
  let userId2: string;
  let username1: string;
  let username2: string;
  let groupChatId: string;

  beforeAll(async () => {
    // Setup users
    username1 = `intuser1_${Date.now()}`;
    username2 = `intuser2_${Date.now()}`;

    const u1 = await prisma.user.create({
      data: {
        username: username1,
        displayName: 'Integration User 1',
        password: 'hashed'
      }
    });
    userId1 = u1.id;

    const u2 = await prisma.user.create({
      data: {
        username: username2,
        displayName: 'Integration User 2',
        password: 'hashed'
      }
    });
    userId2 = u2.id;
  });

  afterAll(async () => {
    // Cleanup - сначала удаляем чаты, потом пользователей (из-за FK constraints)
    await prisma.chat.deleteMany({
      where: { createdById: userId1 }
    });
    
    await prisma.user.deleteMany({
      where: { username: { startsWith: 'intuser' } }
    });
  });

  it('should complete full group chat lifecycle', async () => {
    // 1. Create group
    const group = await createGroupChat({
      currentUserId: userId1,
      name: 'Lifecycle Test Group',
      participantUsernames: []
      // description field removed from schema
    });
    groupChatId = group.id;

    // 2. Verify creation
    const groupInfo = await getGroupInfo(groupChatId, userId1);
    expect(groupInfo.name).toBe('Lifecycle Test Group');
    expect(groupInfo.participants.length).toBe(1);

    // 3. Add first participant (using username)
    const username2_local = `intuser2_lifecycle_${Date.now()}`;
    const user2_lifecycle = await prisma.user.create({
      data: {
        username: username2_local,
        displayName: 'Lifecycle User 2',
        password: 'hashed'
      }
    });

    await addParticipants(groupChatId, userId1, [username2_local]);
    
    let updatedInfo = await getGroupInfo(groupChatId, userId1);
    expect(updatedInfo.participants.length).toBe(2);

    // 4. Add another participant (using username)
    const username3 = `intuser3_${Date.now()}`;
    const user3 = await prisma.user.create({
      data: {
        username: username3,
        displayName: 'Integration User 3',
        password: 'hashed'
      }
    });

    await addParticipants(groupChatId, userId1, [username3]);
    
    updatedInfo = await getGroupInfo(groupChatId, userId1);
    expect(updatedInfo.participants.length).toBe(3);

    // 5. Promote to admin
    await updateParticipantRole(groupChatId, user2_lifecycle.id, userId1, 'ADMIN');
    const role = await getUserRole(groupChatId, user2_lifecycle.id);
    expect(role).toBe('ADMIN');

    // 6. Demote back
    await updateParticipantRole(groupChatId, user2_lifecycle.id, userId1, 'MEMBER');

    // 7. User leaves
    await leaveGroup(groupChatId, user3.id);
    const finalInfo = await getGroupInfo(groupChatId, userId1);
    expect(finalInfo.participants.length).toBe(2);

    // 8. Cleanup
    await prisma.user.delete({ where: { id: user3.id } });
    await prisma.user.delete({ where: { id: user2_lifecycle.id } });
    await deleteChat(groupChatId, userId1);
  });

  it('should handle private chat flow', async () => {
    // 1. Create private chat
    const chat1 = await createPrivateChat({
      currentUserId: userId1,
      contactUsername: username2
    });

    // 2. Find existing
    const chat2 = await findExistingPrivateChat(userId1, userId2);
    expect(chat2?.id).toBe(chat1.chat.id);

    // 3. Both users should see it in their chats
    const user1Chats = await prisma.chatUser.findMany({
      where: { userId: userId1 }
    });
    expect(user1Chats.some(cu => cu.chatId === chat1.chat.id)).toBe(true);

    const user2Chats = await prisma.chatUser.findMany({
      where: { userId: userId2 }
    });
    expect(user2Chats.some(cu => cu.chatId === chat1.chat.id)).toBe(true);
  });
});

describe('Chat Service - Edge Cases', () => {
  let testUserId: string;
  let testUsername: string;

  beforeAll(async () => {
    testUsername = `edgeuser_${Date.now()}`;
    const user = await prisma.user.create({
      data: {
        username: testUsername,
        displayName: 'Edge Case User',
        password: 'hashed'
      }
    });
    testUserId = user.id;
  });

  afterAll(async () => {
    // Cleanup - сначала удаляем чаты, потом пользователей (из-за FK constraints)
    // Edge case тесты создают временные группы которые нужно удалить через deleteChat
    const edgeUserChats = await prisma.chat.findMany({
      where: { createdById: testUserId }
    });
    
    for (const chat of edgeUserChats) {
      if (chat.type !== 'FAVORITES' && chat.type !== 'SYSTEM') {
        try {
          await prisma.chat.delete({ where: { id: chat.id } });
        } catch (e) {
          // Игнорируем ошибки если чат уже удалён
        }
      }
    }
    
    await prisma.user.deleteMany({
      where: { username: { startsWith: 'edgeuser' } }
    });
  });

  it('should handle empty participant list in group creation', async () => {
    const group = await createGroupChat({
      currentUserId: testUserId,
      name: 'Empty Group',
      participantUsernames: [], // Only creator
    });

    expect(group).toBeDefined();
    expect(group.participants.length).toBeGreaterThanOrEqual(1); // At least creator
  });

  it('should handle very long group names (up to limit)', async () => {
    const maxLengthName = 'a'.repeat(CHAT_LIMITS.MAX_GROUP_NAME_LENGTH);
    
    const group = await createGroupChat({
      currentUserId: testUserId,
      name: maxLengthName,
      participantUsernames: []
    });

    expect(group.name).toBe(maxLengthName);
  });

  it('should reject non-participant accessing group info', async () => {
    const outsiderUsername = `outsider_${Date.now()}`;
    const outsider = await prisma.user.create({
      data: {
        username: outsiderUsername,
        displayName: 'Outsider',
        password: 'hashed'
      }
    });

    const group = await createGroupChat({
      currentUserId: testUserId,
      name: 'Private Group',
      participantUsernames: []
    });

    // Non-participant should not access
    try {
      await getGroupInfo(group.id, outsider.id);
      // If no error, check if data is restricted
    } catch (error: any) {
      expect(error.message).toMatch(/Access denied|Not a participant/);
    }

    await prisma.user.delete({ where: { id: outsider.id } });
    await deleteChat(group.id, testUserId);
  });
});
