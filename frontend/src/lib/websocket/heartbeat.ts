/**
 * Heartbeat Manager
 * Handles WebSocket heartbeat/ping-pong mechanism
 */

/**
 * Heartbeat configuration
 */
export interface HeartbeatConfig {
  interval: number;
}

/**
 * Default heartbeat configuration
 */
export const DEFAULT_HEARTBEAT_CONFIG: HeartbeatConfig = {
  interval: 30000, // 30 seconds
};

/**
 * Heartbeat Manager Class
 * Manages periodic ping messages to keep connection alive
 */
export class HeartbeatManager {
  private config: HeartbeatConfig;
  private intervalId: number | null = null;
  private sendPing: () => void;

  constructor(
    sendPing: () => void,
    config: Partial<HeartbeatConfig> = {}
  ) {
    this.config = { ...DEFAULT_HEARTBEAT_CONFIG, ...config };
    this.sendPing = sendPing;
  }

  /**
   * Start heartbeat
   */
  start(): void {
    this.stop();
    
    this.intervalId = window.setInterval(() => {
      this.sendPing();
    }, this.config.interval);
  }

  /**
   * Stop heartbeat
   */
  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Check if heartbeat is active
   */
  isActive(): boolean {
    return this.intervalId !== null;
  }

  /**
   * Dispose resources
   */
  dispose(): void {
    this.stop();
  }
}