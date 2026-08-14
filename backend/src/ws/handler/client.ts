import { AuthenticatedDevice } from '../auth';
import { WSClient } from '../manager';

// ==================== WebSocket Client ====================

export class WebSocketClient implements WSClient {
  public device: AuthenticatedDevice;
  public socket: WebSocket;
  private userId: string;

  // RC-8 fix: Flag to prevent duplicate handleClientReady calls
  public isProcessingReady = false;

  constructor(device: AuthenticatedDevice, socket: WebSocket) {
    this.device = device;
    this.socket = socket;
    this.userId = device.userId;
  }

  getUserId(): string {
    return this.userId;
  }

  /**
   * Get device ID (UUID string)
   */
  getDeviceId(): string {
    return this.device.deviceId;
  }

  /**
   * Get Signal Protocol device ID (numeric 1-127)
   */
  getSignalDeviceId(): number {
    return this.device.signalDeviceId;
  }

  /**
   * Send data to WebSocket client
   * @returns true if sent successfully, false if socket was closed
   */
  send(data: unknown): boolean {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      try {
        this.socket.send(typeof data === 'string' ? data : JSON.stringify(data));
        return true;
      } catch (error) {
        // Race condition: socket may have closed between check and send
        console.error('[WebSocketClient] Send failed (connection likely closed):', error);
        return false;
      }
    }
    return false;
  }

  close(code?: number, reason?: string): void {
    if (this.socket) {
      this.socket.close(code, reason);
    }
  }

  isOpen(): boolean {
    return this.socket && this.socket.readyState === WebSocket.OPEN;
  }
}
