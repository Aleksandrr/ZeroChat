/**
 * WebRTC Call Handlers — relay-only signaling.
 *
 * The server does NOT decrypt or inspect SDP/ICE payloads.
 * It simply forwards call signaling messages between caller and callee
 * based on userId lookup in the WebSocketManager.
 *
 * Media encryption is handled by WebRTC's built-in DTLS-SRTP.
 * Signaling messages (SDP, ICE) are sent in cleartext through the WS relay
 * — this is standard practice (Signal, WhatsApp, Telegram all do this).
 */

import type { WebSocketManager } from '../../manager';
import type { WebSocketClient } from '../client';
import type {
  CallOfferPayload,
  CallAnswerPayload,
  CallIcePayload,
  CallEndPayload,
} from '../../types';
import { prisma } from '../../../prisma/client';

type WSMessage = { type: string; payload: any; timestamp: number; id: string; messageId?: string };

/**
 * SECURITY helper: emit a SENDER_MISMATCH error to the client without
 * closing the socket. We deliberately do NOT close the socket (or
 * send a close-code) so we don't leak timing info about whether the
 * target user/call exists.
 */
function rejectSenderMismatch(sender: WebSocketClient): void {
  sender.send({
    type: 'error',
    payload: { code: 'SENDER_MISMATCH', message: 'Sender identity mismatch' },
    timestamp: Date.now(),
    id: crypto.randomUUID(),
  });
}

function relayToUser(
  manager: WebSocketManager,
  userId: string,
  message: WSMessage,
  excludeDeviceId?: string,
): number {
  const clients = manager.getClientsByUserId(userId);
  let delivered = 0;
  for (const client of clients) {
    if (excludeDeviceId && client.getDeviceId() === excludeDeviceId) continue;
    if (client.isOpen()) {
      client.send(message);
      delivered++;
    }
  }
  return delivered;
}

export async function handleCallOffer(
  payload: CallOfferPayload,
  sender: WebSocketClient,
  manager: WebSocketManager,
): Promise<void> {
  const { callId, recipientId, callerId, callerName, callType, chatId, sdp } = payload;

  // SECURITY: The authenticated WS user must equal `callerId`.
  // Without this check, a malicious user could place calls that
  // appear to originate from someone else.
  if (callerId !== sender.getUserId()) {
    rejectSenderMismatch(sender);
    return;
  }

  // Verify that caller and recipient have a shared chat (optional security check)
  if (chatId) {
    const chat = await prisma.chat.findFirst({
      where: {
        id: chatId,
        chatUsers: { some: { userId: callerId } },
        AND: { chatUsers: { some: { userId: recipientId } } },
      },
      select: { id: true },
    });
    if (!chat) {
      sender.send({
        type: 'call_end',
        payload: { callId, reason: 'failed' },
        timestamp: Date.now(),
        id: crypto.randomUUID(),
      });
      return;
    }
  }

  // Relay to all of the recipient's online devices (multi-device ring)
  relayToUser(manager, recipientId, {
    type: 'call_offer',
    payload: { callId, callerId, callerName, callType, chatId, sdp },
    timestamp: Date.now(),
    id: crypto.randomUUID(),
  }, sender.getDeviceId());
}

export async function handleCallAnswer(
  payload: CallAnswerPayload,
  sender: WebSocketClient,
  manager: WebSocketManager,
): Promise<void> {
  const { callId, callerId, answer } = payload;

  // SECURITY: The answer is sent by the call RECIPIENT (the person
  // being called), not the caller. The authenticated WS user must
  // therefore NOT be the caller. If `recipientId` is present in the
  // payload (some clients include it), we additionally verify that
  // it matches the sender.
  if (callerId === sender.getUserId()) {
    rejectSenderMismatch(sender);
    return;
  }
  const payloadRecipientId = (payload as any).recipientId as string | undefined;
  if (payloadRecipientId && payloadRecipientId !== sender.getUserId()) {
    rejectSenderMismatch(sender);
    return;
  }

  // Relay SDP answer to the caller
  relayToUser(manager, callerId, {
    type: 'call_answer',
    payload: { callId, answer },
    timestamp: Date.now(),
    id: crypto.randomUUID(),
  }, sender.getDeviceId());
}

export async function handleCallReject(
  payload: CallEndPayload,
  sender: WebSocketClient,
  manager: WebSocketManager,
): Promise<void> {
  const { callId } = payload;

  // SECURITY: Reject is sent by the call recipient. The caller
  // must not be the sender (same rationale as handleCallAnswer).
  const callerId = (payload as any).callerId as string | undefined;
  if (callerId && callerId === sender.getUserId()) {
    rejectSenderMismatch(sender);
    return;
  }

  // Relay reject to the caller — we need the callerId.
  // The caller's devices should be listening for call_reject with this callId.
  // We broadcast to all of the sender's chat participants who might be the caller.
  // In practice, the frontend tracks the callId → callerId mapping and
  // the caller's devices will match on callId.
  relayToUser(manager, callerId ?? '', {
    type: 'call_reject',
    payload: { callId, reason: 'rejected' },
    timestamp: Date.now(),
    id: crypto.randomUUID(),
  }, sender.getDeviceId());
}

export async function handleCallEnd(
  payload: CallEndPayload,
  sender: WebSocketClient,
  manager: WebSocketManager,
): Promise<void> {
  const { callId } = payload;

  // SECURITY: Either the caller or the recipient may end a call.
  // The authenticated WS user must be one of the two parties.
  const callerId = (payload as any).callerId as string | undefined;
  const recipientId = (payload as any).recipientId as string | undefined;
  const senderId = sender.getUserId();
  const isCaller = callerId && callerId === senderId;
  const isRecipient = recipientId && recipientId === senderId;
  if (!isCaller && !isRecipient) {
    rejectSenderMismatch(sender);
    return;
  }

  // Relay to the other party. We need to know who the other party is.
  // The frontend includes the recipientId in the payload for routing.
  const otherPartyId = recipientId ?? callerId;
  if (otherPartyId) {
    relayToUser(manager, otherPartyId, {
      type: 'call_end',
      payload: { callId, reason: payload.reason ?? 'ended' },
      timestamp: Date.now(),
      id: crypto.randomUUID(),
    }, sender.getDeviceId());
  }
}

export async function handleCallIce(
  payload: CallIcePayload,
  sender: WebSocketClient,
  manager: WebSocketManager,
): Promise<void> {
  const { callId, candidate, toUserId } = payload;

  // SECURITY: ICE candidates flow from one party of a call to the
  // other. The sender must NOT be the target (you can't relay ICE
  // to yourself). If the payload includes explicit callerId /
  // recipientId / fromUserId fields, we additionally require the
  // sender to be one of them.
  const senderId = sender.getUserId();
  if (toUserId === senderId) {
    rejectSenderMismatch(sender);
    return;
  }
  const callerId = (payload as any).callerId as string | undefined;
  const recipientId = (payload as any).recipientId as string | undefined;
  const fromUserId = (payload as any).fromUserId as string | undefined;
  if (callerId || recipientId || fromUserId) {
    const isParty =
      (callerId && callerId === senderId) ||
      (recipientId && recipientId === senderId) ||
      (fromUserId && fromUserId === senderId);
    if (!isParty) {
      rejectSenderMismatch(sender);
      return;
    }
  }

  // Relay ICE candidate to the target user
  relayToUser(manager, toUserId, {
    type: 'call_ice',
    payload: { callId, candidate, fromUserId: senderId },
    timestamp: Date.now(),
    id: crypto.randomUUID(),
  }, sender.getDeviceId());
}

export async function handleCallBusy(
  payload: CallEndPayload,
  sender: WebSocketClient,
  manager: WebSocketManager,
): Promise<void> {
  const { callId } = payload;

  // SECURITY: Either the caller or the recipient may report busy.
  const callerId = (payload as any).callerId as string | undefined;
  const recipientId = (payload as any).recipientId as string | undefined;
  const senderId = sender.getUserId();
  const isCaller = callerId && callerId === senderId;
  const isRecipient = recipientId && recipientId === senderId;
  if (!isCaller && !isRecipient) {
    rejectSenderMismatch(sender);
    return;
  }

  // Relay busy to the caller
  if (callerId) {
    relayToUser(manager, callerId, {
      type: 'call_busy',
      payload: { callId },
      timestamp: Date.now(),
      id: crypto.randomUUID(),
    }, sender.getDeviceId());
  }
}
