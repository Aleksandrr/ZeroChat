import { prisma } from '../../prisma/client';

/**
 * Проверяет, имеет ли пользователь право на выполнение команды
 */
export async function checkPermission(
  userId: string,
  command: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any
): Promise<boolean> {
  try {
    switch (command) {
         case 'message.delete':
           return await canDeleteMessage(userId, payload.messageId, payload.chatId);
         case 'message.edit':
           return await canEditMessage(userId, payload.messageId, payload.chatId);
         case 'message.pin':
           return await canPinMessage(userId, payload.chatId);
         case 'message.unpin':
           return await canUnpinMessage(userId, payload.chatId);
         case 'message.react':
           return await canReactMessage(userId, payload.chatId, payload.userId);
         case 'message.unreact':
           return await canUnreactMessage(userId, payload.chatId, payload.userId);
         case 'chat.delete':
           return await canDeleteChat(userId, payload.chatId);
      case 'chat.leave':
        return await canLeaveChat(userId, payload.chatId, payload.userId);
      case 'chat.update':
        return await canUpdateChat(userId, payload.chatId);
      case 'participant.add':
        return await canAddParticipant(userId, payload.chatId);
      case 'participant.remove':
        return await canRemoveParticipant(userId, payload.chatId, payload.userId);
      case 'participant.role_update':
        return await canUpdateParticipantRole(userId, payload.chatId, payload.userId);
      case 'system.clear_chat':
        return await canClearChat(userId, payload.chatId, payload.clearFor);
      case 'system.export_chat':
        return await canExportChat(userId, payload.chatId);
      case 'system.report_message':
        return await canReportMessage(userId, payload.chatId);
      
       default:
         // Unknown commands are denied by default
         return false;
    }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[Permission] Error checking permission:', error);
      return false;
    }
}

/**
 * Получает роль пользователя в чате
 */
export async function getUserRoleInChat(
  chatId: string,
  userId: string
): Promise<string | null> {
  const chatUser = await prisma.chatUser.findUnique({
    where: { chatId_userId: { chatId, userId } },
    select: { role: true },
  });
  
  return chatUser?.role ?? null;
}

/**
 * Проверяет, является ли пользователь участником чата
 */
import { isChatParticipant } from '../../services/chats';
// Re-export for external callers that import from permissions.ts
export { isChatParticipant };

/**
 * Проверяет, может ли пользователь удалить сообщение
 *
 * Note: Delivered messages are not stored on server, only pending messages (offline queue).
 * This check only verifies chat participation, as message ownership is validated client-side.
 */
export async function canDeleteMessage(
  userId: string,
  _messageId: string,
  chatId: string
): Promise<boolean> {
  // Only require chat participation - message ownership is client-side responsibility
  // Pending messages (offline queue) can be deleted by any chat participant
  return await isChatParticipant(chatId, userId);
}

/**
 * Проверяет, может ли пользователь редактировать сообщение
 *
 * Note: Delivered messages are not stored on server, only pending messages (offline queue).
 * This check only verifies chat participation, as message ownership is validated client-side.
 * Editing is a client-side operation - server only broadcasts the edit command.
 */
export async function canEditMessage(
  userId: string,
  _messageId: string,
  chatId: string
): Promise<boolean> {
  // Only require chat participation - message ownership is client-side responsibility
  return await isChatParticipant(chatId, userId);
}

/**
 * Проверяет, может ли пользователь удалить чат
 *
 * Для приватных чатов любой участник может удалить чат для всех.
 * Для групповых/каналов требуются права OWNER или ADMIN.
 * FAVOURITES и SYSTEM чаты удалить нельзя (они создаются автоматически).
 */
export async function canDeleteChat(
  userId: string,
  chatId: string
): Promise<boolean> {
  // Проверяем участие в чате
  const chatUser = await prisma.chatUser.findUnique({
    where: { chatId_userId: { chatId, userId } },
    select: { role: true, chat: { select: { type: true } } },
  });

  if (!chatUser) return false;

  // FAVOURITES и SYSTEM нельзя удалить
  if (['FAVORITES', 'SYSTEM'].includes(chatUser.chat.type)) return false;

  // Для приватных чатов любой участник может удалить
  if (chatUser.chat.type === 'PRIVATE') {
    return true;
  }

  // Для групповых/каналов требуются права OWNER или ADMIN
  return ['OWNER', 'ADMIN'].includes(chatUser.role);
}

/**
 * Проверяет, может ли пользователь выйти из чата
 *
 * Защита специальных чатов: FAVOURITES и SYSTEM нельзя покинуть.
 * Приватные чаты покинуть можно (другой участник останется в чате один).
 * Групповые — можно (с проверкой ownership-transfer в command-handler).
 */
export async function canLeaveChat(
  userId: string,
  chatId: string,
  leavingUserId: string
): Promise<boolean> {
  // Пользователь может выйти только сам
  if (userId !== leavingUserId) return false;

  const chatUser = await prisma.chatUser.findUnique({
    where: { chatId_userId: { chatId, userId } },
    select: { chat: { select: { type: true } } },
  });

  if (!chatUser) return false;

  // FAVOURITES и SYSTEM покинуть нельзя
  if (['FAVORITES', 'SYSTEM'].includes(chatUser.chat.type)) return false;

  return true;
}

/**
 * Проверяет, может ли пользователь обновить настройки чата
 *
 * Только GROUP/CHANNEL-чаты могут быть переименованы/перекрыты:
 * PRIVATE-чаты имеют имя, производное от участников, FAVOURITES/SYSTEM
 * — защищены. Для приватного чата OWNER/ADMIN-роль выдаётся
 * автоматически обоим участникам, поэтому формальная проверка
 * проходит, но обновлять такие чаты нельзя.
 */
export async function canUpdateChat(
  userId: string,
  chatId: string
): Promise<boolean> {
  const chatUser = await prisma.chatUser.findUnique({
    where: { chatId_userId: { chatId, userId } },
    select: { role: true, chat: { select: { type: true } } },
  });

  if (!chatUser) return false;

  // Только GROUP и CHANNEL можно редактировать.
  // PRIVATE / SYSTEM / FAVOURITES — нет.
  if (!['GROUP', 'CHANNEL'].includes(chatUser.chat.type)) return false;

  return ['OWNER', 'ADMIN'].includes(chatUser.role);
}

/**
 * Проверяет, может ли пользователь добавить участника
 *
 * Только GROUP/CHANNEL-чаты поддерживают добавление участников.
 * PRIVATE-чаты создаются через отдельный flow (createPrivateChat).
 */
export async function canAddParticipant(
  userId: string,
  chatId: string
): Promise<boolean> {
  const chatUser = await prisma.chatUser.findUnique({
    where: { chatId_userId: { chatId, userId } },
    select: { role: true, chat: { select: { type: true } } },
  });

  if (!chatUser) return false;
  if (!['GROUP', 'CHANNEL'].includes(chatUser.chat.type)) return false;
  return ['OWNER', 'ADMIN'].includes(chatUser.role);
}

/**
 * Проверяет, может ли пользователь исключить участника
 *
 * Защита владельца: OWNER не может быть исключён НИКЕМ — ни админом,
 * ни другим овнером. Чтобы убрать владельца из группы, он должен сначала
 * передать ownership через `participant.role_update` (сделать кого-то
 * другого OWNER, что автоматически понизит его самого до ADMIN),
 * либо удалить группу целиком через `chat.delete`.
 */
export async function canRemoveParticipant(
  userId: string,
  chatId: string,
  targetUserId: string
): Promise<boolean> {
  // Нельзя исключить самого себя через removeParticipant (используйте leaveChat)
  if (userId === targetUserId) return false;

  const role = await getUserRoleInChat(chatId, userId);
  if (role === null || !['OWNER', 'ADMIN'].includes(role)) return false;

  // Целевой пользователь должен быть участником.
  const targetRole = await getUserRoleInChat(chatId, targetUserId);
  if (targetRole === null) return false;

  // Защита владельца: никто не может исключить OWNER.
  // Владелец должен сначала передать ownership или удалить чат.
  if (targetRole === 'OWNER') return false;

  // Владелец может исключать любого (кроме OWNER — см. выше).
  if (role === 'OWNER') return true;

  // Админ может исключать только MEMBER (не другого админа/модератора).
  return targetRole === 'MEMBER';
}

/**
 * Проверяет, может ли пользователь изменить роль участника
 *
 * Защита владельца: OWNER не может быть понижен напрямую —
 * только через механизм передачи ownership. Если овнер хочет уйти
 * или понизить себя, он должен сначала повысить другого участника
 * до OWNER: тогда текущий овнер автоматически станет ADMIN.
 *
 * Это реализовано в `updateParticipantRole` (command-handlers.ts):
 * если targetUserId — текущий OWNER и newRole !== 'OWNER', операция
 * отклоняется. Если newRole === 'OWNER' и issuer — текущий OWNER,
 * происходит атомарная передача ownership (старый овнер → ADMIN).
 */
export async function canUpdateParticipantRole(
  userId: string,
  chatId: string,
  targetUserId: string
): Promise<boolean> {
  // Только владелец может изменять роли
  const role = await getUserRoleInChat(chatId, userId);
  if (role === null || role !== 'OWNER') return false;

  // Нельзя изменить свою роль напрямую — используй передачу ownership
  // (выбери другого участника и повысь его до OWNER).
  if (userId === targetUserId) return false;

  return true;
}

/**
 * Проверяет, может ли пользователь очистить чат
 */
export async function canClearChat(
  userId: string,
  chatId: string,
  clearFor: 'me' | 'everyone'
): Promise<boolean> {
  if (!await isChatParticipant(chatId, userId)) return false;
  
  if (clearFor === 'me') return true;
  
  const role = await getUserRoleInChat(chatId, userId);
  return role !== null && ['OWNER', 'ADMIN'].includes(role);
}

/**
 * Проверяет, может ли пользователь экспортировать чат
 */
export async function canExportChat(
  userId: string,
  chatId: string
): Promise<boolean> {
  return await isChatParticipant(chatId, userId);
}

/**
 * Проверяет, может ли пользователь пожаловаться на сообщение
 */
export async function canReportMessage(
  userId: string,
  chatId: string
): Promise<boolean> {
  return await isChatParticipant(chatId, userId);
}

/**
 * Проверяет, может ли пользователь реагировать на сообщения
 *
 * C3 (spoofing fix): If the payload contains a `userId` field (the
 * reaction is being attributed to a specific user), it MUST match the
 * authenticated issuer. Without this check, any chat participant
 * could add/remove reactions on behalf of another participant.
 */
export async function canReactMessage(
  userId: string,
  chatId: string,
  payloadUserId?: string,
): Promise<boolean> {
  // If the payload declared a userId, it must equal the issuer.
  if (payloadUserId && payloadUserId !== userId) return false;
  // Любой участник чата может ставить реакции
  return await isChatParticipant(chatId, userId);
}

/**
 * Проверяет, может ли пользователь закрепить сообщение
 */
export async function canPinMessage(
  userId: string,
  chatId: string
): Promise<boolean> {
  // Любой участник чата может закреплять сообщения
  return await isChatParticipant(chatId, userId);
}

/**
 * Проверяет, может ли пользователь открепить сообщение
 */
export async function canUnpinMessage(
  userId: string,
  chatId: string
): Promise<boolean> {
  // Любой участник чата может откреплять сообщения
  return await isChatParticipant(chatId, userId);
}

/**
 * Проверяет, может ли пользователь снять свою реакцию с сообщения
 */
export async function canUnreactMessage(
  userId: string,
  chatId: string,
  targetUserId: string
): Promise<boolean> {
  // Пользователь может снять только СВОЮ реакцию
  if (userId !== targetUserId) return false;
  
  // И должен быть участником чата
  return await isChatParticipant(chatId, userId);
}
