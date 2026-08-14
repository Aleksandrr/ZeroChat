import { WSMessage } from '../types';

/**
 * Validates incoming WebSocket message structure
 */
export function isValidMessage(message: WSMessage): boolean {
  // Ping messages have relaxed validation (no messageId required)
  if (message && message.type === 'ping' && message.timestamp) {
    return true;
  }

  const validTypes = [
    'auth', 'prekey', 'message', 'ack', 'error', 'heartbeat', 'handshake',
    'typing', 'session_sync', 'message_retry', 'mark_read', 'multi_message',
    'ping', 'pong', 'sync_request', 'sync_history', 'sync_ack', 'device_online',
    'ready', 'sync_invite', 'sync_accept', 'sync_cancel', 'sync_reject',
    'group_message', 'group_key_update', 'group_sync', 'sender_key_distribution_message',
    'favorites_message', 'favorites_ack',
    // Command Bus types
    'command', 'command_ack', 'command_event', 'command_error',
    // WebRTC Call Signaling
    'call_offer', 'call_answer', 'call_reject', 'call_end', 'call_ice', 'call_busy',
  ];

  return !!(
    message &&
    typeof message.type === 'string' &&
    validTypes.includes(message.type) &&
    message.timestamp &&
    (message.id || message.messageId)
  );
}

/**
 * Extracts Bearer token from Authorization header.
 *
 * FIX: Fastify's `request.headers` is a plain object (not a `Headers`
 * instance), so calling `request.headers.get(...)` throws at runtime.
 * Access the header directly via `request.headers.authorization`.
 */
export function getAuthHeader(request: { headers: { authorization?: string } & Record<string, unknown> }): string | null {
  const authHeader = request.headers?.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }
  return null;
}
