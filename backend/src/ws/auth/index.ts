import { verifyAccessToken } from '../../utils/jwt';
import { prisma } from '../../prisma/client';

export interface AuthenticatedDevice {
  id: string;
  deviceId: string;        // UUID для идентификации устройства
  signalDeviceId: number; // Signal Protocol device ID (1-127)
  name: string;
  type: string;
  userId: string;
  username: string;
  isActive: boolean;
}

export interface AuthResult {
  success: boolean;
  device?: AuthenticatedDevice;
  error?: string;
  message?: string;  // Optional message for error details
  /**
   * WebSocket close code to emit when `success === false`. Defaults to
   * 4002 (generic auth failure) if unset. Specific failure modes use
   * dedicated codes:
   *   - 4003 SIGNAL_DEVICE_NOT_READY  (device has no signalDeviceId yet)
   *   - 4004 DEVICE_NOT_VERIFIED      (device has not completed verification)
   */
  code?: number;
  /** Stable machine-readable reason tag (mirrors `error` for clarity). */
  reason?: string;
}

export class WebSocketAuth {
  
  /**
   * Аутентифицирует WebSocket соединение по JWT токену
   */
  async authenticate(token: string): Promise<AuthResult> {
    try {
      // 1. Валидация JWT
      const decoded = verifyAccessToken(token);
      
      if (!decoded) {
        return { success: false, error: 'Invalid access token' };
      }

      // 2. Проверка устройства в базе
      const device = await prisma.device.findFirst({
        where: {
          deviceId: decoded.deviceId || '',
          userId: decoded.userId,
          isActive: true
        },
        include: {
          user: {
            select: {
              id: true,
              username: true,
              status: true
            }
          }
        }
      });

      if (!device) {
        return { success: false, error: 'Device not found or inactive' };
      }

      // 3. Обновление lastSeen
      await prisma.device.update({
        where: { id: device.id },
        data: { lastSeen: new Date() }
      });

      // 4. Обновление статуса пользователя и lastSeen
      await prisma.user.update({
        where: { id: decoded.userId },
        data: { status: 'ONLINE', lastSeen: new Date() }
      });

      // Calculate signalDeviceId with proper null handling
      const signalDeviceId: number | null = typeof device.signalDeviceId === 'number' 
        ? device.signalDeviceId 
        : device.signalDeviceId 
          ? parseInt(device.signalDeviceId, 10) 
          : null;
      
      // CRITICAL: Do not allow WebSocket connection without valid signalDeviceId
      // This prevents race condition where WS connects before keys are published
      if (!signalDeviceId) {
        console.warn(`[WS-Auth] Device ${device.deviceId} has no signalDeviceId - keys not published yet`);
        return { 
          success: false, 
          error: 'SIGNAL_DEVICE_NOT_READY',
          code: 4003,
          reason: 'SIGNAL_DEVICE_NOT_READY',
          message: 'Device registration in progress. Please retry in a moment.'
        };
      }

      // BUG #3 FIX: Reject WebSocket connections from UNVERIFIED devices.
      //
      // Previously `authenticate()` only checked `signalDeviceId !== null`,
      // so a device that had bound its signalDeviceId (e.g. via the old
      // Bug #2 path where the binding happened before the verifiedAt
      // check) could open a WebSocket without ever completing device
      // verification. That fully bypassed the "login from a new device
      // → real verification" requirement — the user could just publish
      // keys (or have them bound) and immediately open a WS.
      //
      // Now we explicitly check `verifiedAt` after the signalDeviceId
      // check and reject with close code 4004 / reason
      // DEVICE_NOT_VERIFIED. The user must complete the device
      // verification flow (POST /devices/:id/verify with the 6-digit
      // code delivered to an existing verified device) before they can
      // open a WebSocket. Verified devices are unaffected.
      if (!device.verifiedAt) {
        console.warn(`[WS-Auth] Device ${device.deviceId} is not verified — rejecting WS connection (4004)`);
        return {
          success: false,
          error: 'DEVICE_NOT_VERIFIED',
          code: 4004,
          reason: 'DEVICE_NOT_VERIFIED',
          message: 'Device is not verified. Complete device verification first.',
        };
      }
      
      return {
        success: true,
        device: {
          id: device.id,
          deviceId: device.deviceId,
          signalDeviceId: signalDeviceId,
          name: device.name,
          type: device.type,
          userId: decoded.userId,
          username: device.user.username,
          isActive: device.isActive
        }
      };

    } catch (error) {
      console.error('WebSocket auth error:', error);
      return { success: false, error: 'Authentication failed' };
    }
  }

  /**
   * Вызывается при отключении устройства
   */
  async onDisconnect(_deviceId: string, userId: string): Promise<void> {
    try {
      // Проверяем остальные активные соединения пользователя
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
      
      const activeDevices = await prisma.device.count({
        where: {
          userId,
          isActive: true,
          lastSeen: { gte: fiveMinutesAgo }
        }
      });

      // Если это последнее устройство, ставим OFFLINE и обновляем lastSeen
      if (activeDevices <= 1) {
        await prisma.user.update({
          where: { id: userId },
          data: { status: 'OFFLINE', lastSeen: new Date() }
        });
      }
    } catch (error) {
      console.error('Error updating user status on disconnect:', error);
    }
  }
}

export const wsAuth = new WebSocketAuth();
