import { wsAuth } from '../../auth';
import { prisma } from '../../../prisma/client';
import type { AuthPayload, PreKeyPayload } from '../../types';
import { WebSocketClient } from '../client';
import { WebSocketManager } from '../../manager';

/**
 * Handle auth message (re-authentication)
 */
export async function handleAuthMessage(
  payload: AuthPayload,
  client: WebSocketClient,
  manager: WebSocketManager,
  sendError: (socket: WebSocket, code: string, message: string) => void
): Promise<void> {
  try {
    const authResult = await wsAuth.authenticate(payload.accessToken);

    if (!authResult.success || !authResult.device) {
      sendError(client.socket, 'auth_failed', authResult.error || 'Re-auth failed');
      return;
    }

    if (authResult.device.deviceId !== payload.deviceId) {
      sendError(client.socket, 'device_mismatch', 'Device ID mismatch');
      return;
    }

    client.device = authResult.device;
    manager.updateClient(client);

    client.send({
      type: 'auth',
      success: true,
      device: authResult.device
    });

  } catch (error) {
    console.error('Re-auth error:', error);
    sendError(client.socket, 'auth_error', 'Authentication error');
  }
}

/**
 * Handle prekey message (Signal Protocol pre-key exchange)
 *
 * SECURITY: The WS sender must match the `recipientId` in the payload.
 * PreKey messages are how a device publishes its OWN prekeys to the
 * server — so the authenticated WS user must equal the user whose
 * keys are being published. Without this check, a malicious user
 * could publish forged prekeys on behalf of another user.
 */
export async function handlePreKeyMessage(
  payload: PreKeyPayload,
  sender: WebSocketClient,
  manager: WebSocketManager
): Promise<void> {
  try {
    // Sender identity verification — must be the very first check.
    if (sender.getUserId() !== payload.recipientId) {
      sender.send({
        type: 'error',
        payload: { code: 'SENDER_MISMATCH', message: 'Sender identity mismatch' },
        timestamp: Date.now(),
        id: crypto.randomUUID(),
      });
      return;
    }

    const recipientUserId = payload.recipientId;
    const recipientDeviceId = String(payload.recipientDeviceId);
    
    // SECURITY: Проверка верификации устройства
    // Публикация ключей через WebSocket разрешена ТОЛЬКО для верифицированных устройств
    const device = await prisma.device.findFirst({
      where: {
        deviceId: recipientDeviceId,
        userId: recipientUserId,
        isActive: true,
      },
      select: {
        verifiedAt: true,
      },
    });

    if (!device) {
      console.error('Device not found for prekey message');
      return;
    }

    // Запрещаем если устройство не верифицировано
    if (!device.verifiedAt) {
      console.warn({
        userId: recipientUserId,
        deviceId: recipientDeviceId,
        verifiedAt: device.verifiedAt,
      }, '[WS] Unverified device attempted to publish keys via WebSocket');
      return; // Не сохраняем ключи
    }

    await prisma.deviceKeys.upsert({
      where: {
        userId_deviceId: {
          userId: recipientUserId,
          deviceId: recipientDeviceId
        }
      },
      create: {
        userId: payload.recipientId,
        deviceId: String(payload.recipientDeviceId),
        registrationId: payload.preKeyBundle.registrationId,
        identityKeyPub: payload.preKeyBundle.identityKey,
        signedPreKeyId: payload.preKeyBundle.signedPreKeyId,
        signedPreKeyPub: payload.preKeyBundle.signedPreKey,
        signedPreKeySig: payload.preKeyBundle.signedPreKeySignature
      },
      update: {
        registrationId: payload.preKeyBundle.registrationId,
        identityKeyPub: payload.preKeyBundle.identityKey,
        signedPreKeyId: payload.preKeyBundle.signedPreKeyId,
        signedPreKeyPub: payload.preKeyBundle.signedPreKey,
        signedPreKeySig: payload.preKeyBundle.signedPreKeySignature
      }
    });

    const recipientClient = manager.getClientByUserId(payload.recipientId);

    if (recipientClient) {
      recipientClient.send({
        type: 'prekey',
        payload,
        timestamp: Date.now(),
        id: crypto.randomUUID()
      });
    }

  } catch (error) {
    console.error('PreKey handling error:', error);
  }
}
