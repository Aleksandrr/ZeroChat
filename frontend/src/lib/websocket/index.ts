/**
 * WebSocket Library
 * Re-exports for WebSocket connection management
 */

// Main connection class
export type { ConnectionState, PendingMessage,WSConfig } from './connection';
export { WebSocketConnection } from './connection';
export { DEFAULT_WS_CONFIG } from './connection';

// Types (including unified interface)
export type { WebSocketClientInterface } from './types';

// Event emitter
export type { EventCallback } from './event-emitter';
export { EventEmitter } from './event-emitter';

// Reconnection manager
export type { ReconnectConfig, ReconnectState } from './reconnect';
export { DEFAULT_RECONNECT_CONFIG,ReconnectManager } from './reconnect';

// Message sender
export { MessageSender } from './message-sender';

// Heartbeat manager
export type { HeartbeatConfig } from './heartbeat';
export { DEFAULT_HEARTBEAT_CONFIG,HeartbeatManager } from './heartbeat';

// Shared Worker client (Phase 3)
export { 
  createWorkerClient,
  type WorkerClientMessage,
  type ConnectionState as WorkerConnectionState,
  type WorkerServerMessage,
  WorkerWebSocketClient, 
} from './worker-client';

// Shared Worker hook and feature flag (Phase 3)
export {
  destroySharedWorkerClient,
  shouldUseSharedWorker,
  USE_SHARED_WORKER,
  useSharedWorker,
  type UseSharedWorkerResult,
  useWorkerEvent,
} from './use-shared-worker';