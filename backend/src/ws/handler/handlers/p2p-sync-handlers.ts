import { prisma } from '../../../prisma/client';
import type {
  SyncInvitePayload,
  SyncAcceptPayload,
  SyncCancelPayload,
  SyncRejectPayload
} from '../../types';
import { WebSocketClient } from '../client';
import { WebSocketManager } from '../../manager';

/**
 * Handle sync invite from a new device
 * New device sends this to request history from existing devices
 * Server forwards the invite to all online devices of the same user
 */
export async function handleSyncInvite(
  payload: SyncInvitePayload,
  sender: WebSocketClient,
  manager: WebSocketManager
): Promise<void> {
  const userId = sender.getUserId();
  const invitingDeviceId = payload.invitingDeviceId;

  console.log(`[SyncInvite] Device ${invitingDeviceId} invites for sync, user: ${userId}`);

  try {
    // Verify the inviting device belongs to this user
    const invitingDevice = await prisma.device.findFirst({
      where: {
        deviceId: invitingDeviceId,
        userId,
        isActive: true
      }
    });

    if (!invitingDevice) {
      sender.send({
        type: 'error',
        payload: { code: 403, message: 'Device not authorized' },
        timestamp: Date.now(),
        id: crypto.randomUUID()
      });
      return;
    }

    // Get all other devices of this user
    const otherDevices = await prisma.device.findMany({
      where: {
        userId,
        isActive: true,
        deviceId: { not: invitingDeviceId }
      },
      select: { deviceId: true, name: true }
    });

    if (otherDevices.length === 0) {
      // No other devices - notify the inviting device
      sender.send({
        type: 'sync_cancel',
        payload: {
          invitingDeviceId,
          acceptedByDeviceId: '',
          reason: 'no_devices' as any
        },
        timestamp: Date.now(),
        id: crypto.randomUUID()
      });
      return;
    }

    // Find online devices (excluding the inviting device)
    const allClients = manager.getClientsByUserId(userId);
    console.log(`[SyncInvite] Total clients for user ${userId}: ${allClients.length}`);
    console.log(`[SyncInvite] Client deviceIds:`, allClients.map(c => c.getDeviceId()));
    console.log(`[SyncInvite] Inviting deviceId: ${invitingDeviceId}`);

    const onlineClients = allClients.filter(c => c.getDeviceId() !== invitingDeviceId);
    console.log(`[SyncInvite] Filtered clients (excluding inviting): ${onlineClients.length}`);

    // Forward invite to all online devices
    for (const onlineClient of onlineClients) {
      onlineClient.send({
        type: 'sync_invite',
        payload: {
          invitingDeviceId,
          invitingDeviceName: payload.invitingDeviceName || invitingDevice.name || 'New Device',
          timestamp: payload.timestamp || Date.now()
        },
        timestamp: Date.now(),
        id: crypto.randomUUID()
      });
    }

    console.log(`[SyncInvite] Forwarded invite to ${onlineClients.length} online devices`);

    // Store invite for offline devices (they will see it when they come online)
    const offlineDeviceIds = otherDevices
      .filter(d => !onlineClients.some(c => c.getDeviceId() === d.deviceId))
      .map(d => d.deviceId);

    if (offlineDeviceIds.length > 0) {
      await prisma.syncEvent.createMany({
        data: offlineDeviceIds.map(deviceId => ({
          userId,
          deviceId: invitingDeviceId,
          seq: Math.floor(Date.now() / 1000),
          entity: 'sync_invite',
          entityId: deviceId,
          op: 'sync_invite',
          version: 0,
          payloadCiphertext: JSON.stringify({
            invitingDeviceId,
            invitingDeviceName: payload.invitingDeviceName || invitingDevice.name || 'New Device',
            timestamp: payload.timestamp || Date.now()
          })
        }))
      });
      console.log(`[SyncInvite] Stored invite for ${offlineDeviceIds.length} offline devices`);
    }

    // Acknowledge the invite
    sender.send({
      type: 'sync_invite_ack',
      payload: {
        status: 'forwarded',
        onlineDevicesCount: onlineClients.length,
        offlineDevicesCount: offlineDeviceIds.length
      },
      timestamp: Date.now(),
      id: crypto.randomUUID()
    });

  } catch (error) {
    console.error('[SyncInvite] Error handling sync invite:', error);
    sender.send({
      type: 'error',
      payload: { code: 500, message: 'Failed to process sync invite' },
      timestamp: Date.now(),
      id: crypto.randomUUID()
    });
  }
}

/**
 * Handle sync accept from an existing device
 * Device accepts the sync request and will send history
 * Server forwards accept to the inviting device and sends cancel to others
 */
export async function handleSyncAccept(
  payload: SyncAcceptPayload,
  sender: WebSocketClient,
  manager: WebSocketManager
): Promise<void> {
  const userId = sender.getUserId();
  const acceptingDeviceId = payload.acceptingDeviceId;
  const targetDeviceId = payload.targetDeviceId;

  console.log(`[SyncAccept] Device ${acceptingDeviceId} accepts sync for ${targetDeviceId}`);

  try {
    // Verify the accepting device belongs to this user
    const acceptingDevice = await prisma.device.findFirst({
      where: {
        deviceId: acceptingDeviceId,
        userId,
        isActive: true
      }
    });

    if (!acceptingDevice) {
      sender.send({
        type: 'error',
        payload: { code: 403, message: 'Device not authorized' },
        timestamp: Date.now(),
        id: crypto.randomUUID()
      });
      return;
    }

    // Verify target device belongs to same user
    const targetDevice = await prisma.device.findFirst({
      where: {
        deviceId: targetDeviceId,
        userId,
        isActive: true
      }
    });

    if (!targetDevice) {
      sender.send({
        type: 'error',
        payload: { code: 404, message: 'Target device not found' },
        timestamp: Date.now(),
        id: crypto.randomUUID()
      });
      return;
    }

    // Send accept to the inviting device
    const targetClient = manager.getClient(targetDeviceId);
    if (targetClient && targetClient.isOpen()) {
      targetClient.send({
        type: 'sync_accept',
        payload: {
          acceptingDeviceId,
          acceptingDeviceName: acceptingDevice.name || 'Device',
          targetDeviceId,
          timestamp: payload.timestamp || Date.now()
        },
        timestamp: Date.now(),
        id: crypto.randomUUID()
      });
      console.log(`[SyncAccept] Sent accept to inviting device ${targetDeviceId}`);
    }

    // Send cancel to all other devices (they should hide the invite dialog)
    const otherClients = manager.getClientsByUserId(userId)
      .filter(c => c.getDeviceId() !== acceptingDeviceId && c.getDeviceId() !== targetDeviceId);

    for (const otherClient of otherClients) {
      otherClient.send({
        type: 'sync_cancel',
        payload: {
          invitingDeviceId: targetDeviceId,
          acceptedByDeviceId: acceptingDeviceId,
          reason: 'accepted'
        },
        timestamp: Date.now(),
        id: crypto.randomUUID()
      });
    }

    console.log(`[SyncAccept] Sent cancel to ${otherClients.length} other devices`);

    // Delete stored sync invites for this device (they're no longer needed)
    await prisma.syncEvent.deleteMany({
      where: {
        userId,
        op: 'sync_invite',
        entityId: acceptingDeviceId
      }
    });

    // Acknowledge the accept
    sender.send({
      type: 'sync_accept_ack',
      payload: {
        status: 'forwarded',
        targetDeviceId
      },
      timestamp: Date.now(),
      id: crypto.randomUUID()
    });

  } catch (error) {
    console.error('[SyncAccept] Error handling sync accept:', error);
    sender.send({
      type: 'error',
      payload: { code: 500, message: 'Failed to process sync accept' },
      timestamp: Date.now(),
      id: crypto.randomUUID()
    });
  }
}

/**
 * Handle sync cancel
 * Sent when sync invite is cancelled (accepted by another device, timeout, or explicit rejection)
 */
export async function handleSyncCancel(
  payload: SyncCancelPayload,
  sender: WebSocketClient,
  manager: WebSocketManager
): Promise<void> {
  const userId = sender.getUserId();
  const invitingDeviceId = payload.invitingDeviceId;

  console.log(`[SyncCancel] Cancel for invite from ${invitingDeviceId}, reason: ${payload.reason}`);

  try {
    // Forward cancel to all devices of this user (except sender)
    const otherClients = manager.getClientsByUserId(userId)
      .filter(c => c.getDeviceId() !== sender.getDeviceId());

    for (const otherClient of otherClients) {
      otherClient.send({
        type: 'sync_cancel',
        payload,
        timestamp: Date.now(),
        id: crypto.randomUUID()
      });
    }

    // Delete stored sync invites
    await prisma.syncEvent.deleteMany({
      where: {
        userId,
        op: 'sync_invite',
        entityId: invitingDeviceId
      }
    });

  } catch (error) {
    console.error('[SyncCancel] Error handling sync cancel:', error);
  }
}

/**
 * Handle sync reject
 * Device explicitly rejects the sync request
 */
export async function handleSyncReject(
  payload: SyncRejectPayload,
  sender: WebSocketClient,
  manager: WebSocketManager
): Promise<void> {
  const userId = sender.getUserId();
  const rejectingDeviceId = payload.rejectingDeviceId;
  const targetDeviceId = payload.targetDeviceId;

  console.log(`[SyncReject] Device ${rejectingDeviceId} rejects sync for ${targetDeviceId}`);

  try {
    // Verify the rejecting device belongs to this user
    const rejectingDevice = await prisma.device.findFirst({
      where: {
        deviceId: rejectingDeviceId,
        userId,
        isActive: true
      }
    });

    if (!rejectingDevice) {
      return;
    }

    // Notify the inviting device about rejection
    const targetClient = manager.getClient(targetDeviceId);
    if (targetClient && targetClient.isOpen()) {
      targetClient.send({
        type: 'sync_reject',
        payload: {
          rejectingDeviceId,
          rejectingDeviceName: rejectingDevice.name || 'Device',
          timestamp: payload.timestamp || Date.now()
        },
        timestamp: Date.now(),
        id: crypto.randomUUID()
      });
    }

    // Check if all devices have rejected (no more online devices to accept)
    const onlineClients = manager.getClientsByUserId(userId)
      .filter(c => c.getDeviceId() !== targetDeviceId && c.getDeviceId() !== rejectingDeviceId);

    // If no more devices to potentially accept, send cancel to inviting device
    if (onlineClients.length === 0) {
      if (targetClient && targetClient.isOpen()) {
        targetClient.send({
          type: 'sync_cancel',
          payload: {
            invitingDeviceId: targetDeviceId,
            acceptedByDeviceId: '',
            reason: 'rejected'
          },
          timestamp: Date.now(),
          id: crypto.randomUUID()
        });
      }
    }

  } catch (error) {
    console.error('[SyncReject] Error handling sync reject:', error);
  }
}
