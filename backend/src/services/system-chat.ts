/**
 * System Chat Service - Сервис для работы с системным чатом ZeroChat
 * 
 * Создаёт и управляет системным чатом для уведомлений:
 * - Генерация кодов верификации
 * - Уведомления о новых входах
 * 
 * Системный чат не шифруется (encrypted = false), так как содержит
 * только техническую информацию (коды, уведомления о входах).
 */

import { prisma } from '../prisma/client';
import { wsManager } from '../ws';

// ID системного бота (создаётся через миграцию)
const SYSTEM_BOT_ID = '00000000-0000-0000-0000-000000000001';

/**
 * Типы системных событий
 */
export type SystemEventType = 'verification_code' | 'new_login';

/**
 * Metadata для системного сообщения
 */
export interface SystemMessageMetadata {
  event: SystemEventType;
  deviceId: string;
  deviceName?: string;
  expiresAt?: string;
  ip?: string | null;
}

/**
 * Находит или создаёт системный чат для пользователя
 * 
 * @param userId - ID пользователя
 * @returns Объект чата
 */
export async function getOrCreateSystemChat(userId: string): Promise<{
  id: string;
  type: string;
}> {
  // Ищем существующий системный чат
  const existingChat = await prisma.chat.findFirst({
    where: {
      type: 'SYSTEM',
      chatUsers: {
        some: { userId }
      }
    },
    select: { id: true, type: true }
  });

  if (existingChat) {
    return existingChat;
  }

  // Создаём новый системный чат
  const newChat = await prisma.chat.create({
    data: {
      type: 'SYSTEM',
      isGroup: false,
      createdById: SYSTEM_BOT_ID,
      chatUsers: {
        create: [
          { userId: SYSTEM_BOT_ID, role: 'OWNER' },
          { userId, role: 'MEMBER' }
        ]
      }
    },
    select: { id: true, type: true }
  });

  return newChat;
}

/**
 * Создаёт системное сообщение, сохраняет в БД и отправляет через WebSocket
 *
 * @param userId - ID получателя
 * @param content - Текст сообщения
 * @param metadata - Метаданные события
 * @returns Созданное сообщение
 */
export async function createSystemMessage(
  userId: string,
  content: string,
  metadata: SystemMessageMetadata
): Promise<{
  id: string;
  chatId: string;
  content: string;
  type: string;
  createdAt: Date;
}> {
  // Получаем системный чат
  const systemChat = await getOrCreateSystemChat(userId);
  
  // Генерируем уникальный ID для сообщения
  const messageId = crypto.randomUUID();
  const createdAt = new Date();

  // Получаем все устройства пользователя (для офлайн-доставки)
  const userDevices = await prisma.device.findMany({
    where: { userId, isActive: true },
    select: { deviceId: true }
  });

  // Получаем онлайн-устройства пользователя через wsManager
  const onlineDeviceIds = new Set<string>();
  if (wsManager) {
    const onlineClients = wsManager.getClientsByUserId(userId);
    onlineClients.forEach(client => onlineDeviceIds.add(client.getDeviceId()));
  }

  // Сохраняем сообщение в базе данных
  // Для онлайн-устройств: одна запись с основным ID
  // Для офлайн-устройств: отдельные записи с pendingDeviceId
  await prisma.message.create({
    data: {
      id: messageId,
      chatId: systemChat.id,
      authorId: SYSTEM_BOT_ID,
      content: content || '',
      type: 'SYSTEM',
      encrypted: false,
      metadata: {
        ...(metadata as unknown as Record<string, unknown>),
        isSystem: true,
      },
      createdAt: createdAt,
      updatedAt: createdAt,
    },
  });

  // Создаем pending-записи для офлайн-устройств (аналогично multi-device-handlers)
  for (const device of userDevices) {
    if (!onlineDeviceIds.has(device.deviceId)) {
      // Устройство офлайн - создаем pending-запись
      await prisma.message.create({
        data: {
          id: `${messageId}-pending-${device.deviceId}`,
          chatId: systemChat.id,
          authorId: SYSTEM_BOT_ID,
          content: content || '',
          type: 'SYSTEM',
          encrypted: false,
          metadata: {
            pendingDeviceId: device.deviceId,
            isSystem: true,
            ...(metadata as unknown as Record<string, unknown>),
          },
          createdAt: createdAt,
          updatedAt: createdAt,
        },
      });
    }
  }

  // Отправляем через WebSocket всем онлайн-устройствам пользователя
  if (wsManager) {
    // Получаем текущий unreadCount для системного чата
    const chatUser = await prisma.chatUser.findUnique({
      where: {
        chatId_userId: {
          chatId: systemChat.id,
          userId: userId
        }
      },
      select: { unreadCount: true }
    });
    const unreadCount = (chatUser?.unreadCount ?? 0) + 1;
    
    // Увеличиваем счётчик непрочитанных в БД
    await prisma.chatUser.update({
      where: {
        chatId_userId: {
          chatId: systemChat.id,
          userId: userId
        }
      },
      data: { unreadCount: { increment: 1 } }
    });
    
    wsManager.sendToUser(userId, {
      type: 'message',
      payload: {
        messageId: messageId,
        chatId: systemChat.id,
        content: content || '',
        type: 'SYSTEM',
        messageType: 0, // Text message type
        encrypted: false,
        metadata: {
          ...metadata,
          isSystem: true,
        },
        senderId: SYSTEM_BOT_ID,
        senderUsername: 'ZeroChat',
        senderDeviceId: 0, // System bot has no device
        timestamp: createdAt.getTime(),
        isSystem: true,
        unreadCount: unreadCount // Добавляем unreadCount для фронтенда
      }
    });
  }

  return {
    id: messageId,
    chatId: systemChat.id,
    content: content || '',
    type: 'SYSTEM',
    createdAt: createdAt
  };
}

/**
 * Отправляет уведомление о новом входе
 * 
 * @param userId - ID пользователя
 * @param deviceId - UUID устройства
 * @param deviceName - Имя устройства
 * @param ip - IP адрес (опционально)
 */
export async function sendNewLoginNotification(
  userId: string,
  deviceId: string,
  deviceName: string,
  ip?: string | null
): Promise<void> {
  await createSystemMessage(
    userId,
    `Новый вход с устройства: ${deviceName}`,
    {
      event: 'new_login',
      deviceId,
      deviceName,
      ip: ip || null
    }
  );
}

/**
 * Отправляет код верификации в системный чат
 * 
 * @param userId - ID пользователя
 * @param deviceId - UUID устройства
 * @param code - 6-значный код верификации (открытый, для отображения)
 * @param expiresAt - Время истечения кода
 */
export async function sendVerificationCodeNotification(
  userId: string,
  deviceId: string,
  code: string,
  expiresAt: Date
): Promise<void> {
  await createSystemMessage(
    userId,
    `Код верификации: ${code}`,
    {
      event: 'verification_code',
      deviceId,
      expiresAt: expiresAt.toISOString()
    }
  );
}

// ==================== Command Bus System Operations ====================

/**
 * Очистить чат (для команды system.clear_chat)
 */
export async function clearChatCommand(
  chatId: string,
  userId: string,
  clearFor: 'me' | 'everyone'
): Promise<{ cleared: boolean }> {
  // Проверяем участие в чате
  const chatUser = await prisma.chatUser.findUnique({
    where: { chatId_userId: { chatId, userId } },
  });
  
  if (!chatUser) {
    throw new Error('You are not a participant of this chat');
  }
  
  if (clearFor === 'everyone') {
    const role = chatUser.role;
    if (role !== 'OWNER' && role !== 'ADMIN') {
      throw new Error('Only owner or admin can clear chat for everyone');
    }
    
    await prisma.message.deleteMany({ where: { chatId } });
  }
  
  return { cleared: true };
}

/**
 * Экспортировать чат (для команды system.export_chat)
 */
export async function exportChatCommand(
  chatId: string,
  userId: string,
  format: 'json' | 'txt' | 'pdf',
  includeMedia?: boolean
): Promise<{ exportUrl: string }> {
  // Проверяем участие в чате
  const chatUser = await prisma.chatUser.findUnique({
    where: { chatId_userId: { chatId, userId } },
  });
  
  if (!chatUser) {
    throw new Error('You are not a participant of this chat');
  }
  
  // Возвращаем URL для экспорта (реализация на уровне REST API)
  return { exportUrl: `/api/chats/${chatId}/export?format=${format}&includeMedia=${includeMedia ?? false}` };
}

/**
 * Пожаловаться на сообщение (для команды system.report_message)
 */
export async function reportMessageCommand(
  messageId: string,
  chatId: string,
  userId: string,
  reason: 'spam' | 'abuse' | 'inappropriate' | 'other',
  description?: string
): Promise<{ reported: boolean }> {
  // Проверяем участие в чате
  const chatUser = await prisma.chatUser.findUnique({
    where: { chatId_userId: { chatId, userId } },
  });
  
  if (!chatUser) {
    throw new Error('You are not a participant of this chat');
  }
  
  // Логируем жалобу (в будущем можно создать отдельную таблицу reports)
  console.log('[Report] Message reported:', { messageId, chatId, userId, reason, description });
  
  return { reported: true };
}
