/**
 * Shared Worker for WebSocket Connection
 * 
 * Provides a single WebSocket connection shared across all browser tabs.
 * This reduces server load and ensures consistent real-time data.
 * 
 * Architecture:
 * - One WebSocket connection per browser (shared across tabs)
 * - MessagePort-based communication with each tab
 * - BroadcastChannel for cross-tab events
 * - Automatic cleanup when all tabs disconnect
 */

// ==================== Types ====================

/**
 * Message from tab to worker
 */
export type WorkerClientMessage =
  | { type: 'connect'; payload: { token: string; url: string } }
  | { type: 'disconnect' }
  | { type: 'send'; payload: { type: string; data: unknown } }
  | { type: 'subscribe'; payload: { eventTypes: string[] } }
  | { type: 'unsubscribe'; payload: { eventTypes: string[] } }
  | { type: 'get-state' }
  | { type: 'set-device-id'; payload: { deviceId: string } }
  // Шаг 5 lifecycle: update token without full reconnect (e.g. on token refresh)
  | { type: 'update-token'; payload: { token: string } };

/**
 * Message from worker to tab
 */
export type WorkerServerMessage =
  | { type: 'connected'; payload: { tabId: string } }
  | { type: 'disconnected'; payload: { reason?: string } }
  | { type: 'message'; payload: unknown }
  | { type: 'error'; payload: { code: string; message: string } }
  | { type: 'state'; payload: ConnectionState }
  | { type: 'reconnecting'; payload: { attempt: number; delay: number } };

/**
 * Connection state
 */
export interface ConnectionState {
  isConnected: boolean;
  isConnecting: boolean;
  lastError: Error | null;
  reconnectAttempts: number;
  deviceId: string | null;
}

/**
 * Tab connection info
 */
interface TabConnection {
  port: MessagePort;
  tabId: string;
  subscriptions: Set<string>;
}

// ==================== Constants ====================

const RECONNECT_CONFIG = {
  maxAttempts: 10,
  baseDelay: 1000,
  maxDelay: 30000,
  jitter: 0.1,
};

const HEARTBEAT_INTERVAL = 30000; // 30 seconds

// Message buffer configuration for race condition fix
const MESSAGE_BUFFER_SIZE = 50;
const MESSAGE_BUFFER_TTL = 5000; // 5 seconds

// ==================== Global State ====================

let ws: WebSocket | null = null;
let connectionState: ConnectionState = {
  isConnected: false,
  isConnecting: false,
  lastError: null,
  reconnectAttempts: 0,
  deviceId: null,
};

const tabs = new Map<string, TabConnection>();
const broadcastChannel = new BroadcastChannel('zerochat-ws-worker');

let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
let currentToken: string | null = null;
let currentUrl: string | null = null;
let explicitDisconnect = false;

// Message buffer for race condition fix
interface BufferedMessage {
  eventType: string;
  data: unknown;
  timestamp: number;
}
let messageBuffer: BufferedMessage[] = [];

// ==================== Outgoing Queue (Шаг 3) ====================
//
// Serialize outgoing WS messages so that even if multiple tabs call `send`
// concurrently (their postMessage calls arrive in the worker's event loop in
// arbitrary order), the actual `ws.send()` calls are flushed in FIFO order
// and never overlap. This is defense-in-depth: JS in the worker is single-
// threaded so concurrent ws.send() cannot corrupt frames, but a queue gives
// us a clear place to add backpressure / batching / drop-on-disconnect
// semantics later. It also ensures that messages queued while the WS is in
// CONNECTING state are flushed once OPEN, so a tab that calls `send` right
// after `connect` does not silently lose its message.
interface QueuedOutgoing {
  type: string;
  data: unknown;
}
let outgoingQueue: QueuedOutgoing[] = [];
let isFlushing = false;

function enqueueOutgoing(type: string, data: unknown): void {
  outgoingQueue.push({ type, data });
  if (!isFlushing) {
    flushOutgoing();
  }
}

function flushOutgoing(): void {
  if (isFlushing) return;
  isFlushing = true;
  try {
    while (outgoingQueue.length > 0) {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        // WS not open — drop pending messages to avoid unbounded growth.
        // (Tab-side retry / command-bus already handles lost commands.)
        outgoingQueue.length = 0;
        break;
      }
      const msg = outgoingQueue.shift()!;
      ws.send(JSON.stringify({
        type: msg.type,
        payload: msg.data,
        timestamp: Date.now(),
        messageId: `${msg.type}-${crypto.randomUUID()}`,
      }));
    }
  } finally {
    isFlushing = false;
  }
}

// ==================== Utility Functions ====================

function generateTabId(): string {
  return `tab-${crypto.randomUUID()}`;
}

// ==================== Message Buffer ====================

/**
 * Add a message to the buffer
 */
function addToBuffer(eventType: string, data: unknown): void {
  const now = Date.now();
  
  // Add new message
  messageBuffer.push({
    eventType,
    data,
    timestamp: now,
  });
  
  // Clean up old messages (TTL)
  messageBuffer = messageBuffer.filter(
    (msg) => now - msg.timestamp < MESSAGE_BUFFER_TTL
  );
  
  // Enforce size limit (keep most recent)
  if (messageBuffer.length > MESSAGE_BUFFER_SIZE) {
    messageBuffer = messageBuffer.slice(-MESSAGE_BUFFER_SIZE);
  }
}

/**
 * Get buffered messages matching the specified event types
 */
function getBufferedMessages(eventTypes: string[]): WorkerServerMessage[] {
  const now = Date.now();
  
  return messageBuffer
    .filter((msg) => {
      // Check TTL
      if (now - msg.timestamp >= MESSAGE_BUFFER_TTL) {
        return false;
      }
      // Check if event type matches requested subscriptions
      return eventTypes.includes(msg.eventType) || eventTypes.includes('*');
    })
    .map((msg) => ({
      type: 'message' as const,
      payload: msg.data,
    }));
}

function broadcast(message: WorkerServerMessage): void {
  tabs.forEach((tab) => {
    try {
      tab.port.postMessage(message);
    } catch (error) {
      console.error('[SharedWorker] Failed to send message to tab:', error);
      tabs.delete(tab.tabId);
    }
  });
}

function broadcastToSubscribers(eventType: string, data: unknown): void {
  // Add to buffer for new subscribers (race condition fix)
  addToBuffer(eventType, data);
  
  tabs.forEach((tab) => {
    if (tab.subscriptions.has(eventType) || tab.subscriptions.has('*')) {
      try {
        // Send the original message structure from server directly
        // data is already { type, payload, timestamp, ... } from server
        tab.port.postMessage({
          type: 'message',
          payload: data,
        });
      } catch (error) {
        console.error('[SharedWorker] Failed to send to subscriber:', error);
        tabs.delete(tab.tabId);
      }
    }
  });
}

function updateState(updates: Partial<ConnectionState>): void {
  connectionState = { ...connectionState, ...updates };
  broadcast({ type: 'state', payload: connectionState });
}

// ==================== WebSocket Management ====================

  function startHeartbeat(): void {
    if (heartbeatInterval) return;

    heartbeatInterval = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'ping',
          timestamp: Date.now(),
          id: `ping-${crypto.randomUUID()}`,
        }));
      }
    }, HEARTBEAT_INTERVAL);
  }

function stopHeartbeat(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

function scheduleReconnect(attempt: number): void {
  if (attempt >= RECONNECT_CONFIG.maxAttempts) {
    broadcast({
      type: 'error',
      payload: {
        code: 'RECONNECT_FAILED',
        message: 'Max reconnect attempts reached',
      },
    });
    return;
  }

  const delay = Math.min(
    RECONNECT_CONFIG.baseDelay * Math.pow(2, attempt),
    RECONNECT_CONFIG.maxDelay
  );

  const jitteredDelay = delay * (1 + RECONNECT_CONFIG.jitter * Math.random());

  updateState({ reconnectAttempts: attempt + 1 });
  broadcast({
    type: 'reconnecting',
    payload: { attempt: attempt + 1, delay: jitteredDelay },
  });

  reconnectTimeout = setTimeout(() => {
    if (currentToken && currentUrl && !explicitDisconnect) {
      connectWebSocket(currentUrl, currentToken);
    }
  }, jitteredDelay);
}

function connectWebSocket(url: string, token: string): void {
  if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) {
    return;
  }

  explicitDisconnect = false;
  currentToken = token;
  currentUrl = url;

  updateState({ isConnecting: true, lastError: null });

  const wsUrl = `${url}?token=${token}`;

  try {
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      // Send handshake
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'handshake',
          payload: { token },
          timestamp: Date.now(),
          messageId: `handshake-${crypto.randomUUID()}`,
        }));
      }
      // Шаг 3: flush any messages that were queued while WS was CONNECTING.
      // This is called opportunistically; handshake_ack handler will also
      // call flushOutgoing() once the connection is fully established.
      flushOutgoing();
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        // Handle handshake acknowledgment
        if (data.type === 'handshake_ack' && data.success) {
          updateState({
            isConnected: true,
            isConnecting: false,
            lastError: null,
            reconnectAttempts: 0,
          });
          startHeartbeat();
          // Шаг 3: now that the connection is fully open, flush any messages
          // that were queued by tabs during the connecting phase.
          flushOutgoing();
          return;
        }

        // Handle pong
        if (data.type === 'pong') {
          return;
        }

        // Handle ack
        if (data.type === 'ack' && data.messageId) {
          broadcastToSubscribers('ack', data);
          return;
        }

        // Handle errors
        if (data.type === 'error') {
          if (data.payload?.code === 'SIGNAL_DEVICE_NOT_READY') {
            const error = new Error('SIGNAL_DEVICE_NOT_READY');
            updateState({
              lastError: error,
              isConnecting: false,
            });
            broadcastToSubscribers('signal_not_ready', data);
            return;
          }
        }

        // Broadcast to subscribers
        broadcastToSubscribers(data.type, data);

      } catch (error) {
        console.error('[SharedWorker] Failed to parse message:', error);
      }
    };

    ws.onclose = (event) => {
      stopHeartbeat();
      
      updateState({
        isConnected: false,
        isConnecting: false,
      });

      broadcast({
        type: 'disconnected',
        payload: { reason: event.reason || `Code: ${event.code}` },
      });

      // Handle specific close codes
      if (event.code === 4003 || event.reason?.includes('SIGNAL_DEVICE_NOT_READY')) {
        updateState({ lastError: new Error('SIGNAL_DEVICE_NOT_READY') });
        return;
      }

      // Don't reconnect on explicit disconnect or normal closure
      if (explicitDisconnect || event.code === 1000) {
        return;
      }

      // Schedule reconnect
      if (tabs.size > 0) {
        scheduleReconnect(connectionState.reconnectAttempts);
      }
    };

    ws.onerror = () => {
      console.error('[SharedWorker] WebSocket error');
      updateState({ lastError: new Error('WebSocket error') });
      broadcast({
        type: 'error',
        payload: { code: 'WS_ERROR', message: 'WebSocket connection error' },
      });
    };

  } catch (error) {
    console.error('[SharedWorker] Failed to create WebSocket:', error);
    updateState({
      isConnecting: false,
      lastError: error instanceof Error ? error : new Error('Unknown error'),
    });
  }
}

function disconnectWebSocket(): void {
  explicitDisconnect = true;
  stopHeartbeat();

  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }

  // Шаг 3: drop any pending outgoing messages on explicit disconnect.
  outgoingQueue.length = 0;
  isFlushing = false;

  if (ws) {
    ws.close(1000, 'Client disconnect');
    ws = null;
  }

  currentToken = null;
  currentUrl = null;

  updateState({
    isConnected: false,
    isConnecting: false,
    reconnectAttempts: 0,
  });
}

// ==================== Message Handlers ====================

function handleMessage(port: MessagePort, message: WorkerClientMessage, tabId: string): void {
  switch (message.type) {
    case 'connect':
      connectWebSocket(message.payload.url, message.payload.token);
      break;

    case 'disconnect': {
      // Шаг 3 / Шаг 5 — multi-tab: only this tab is going away. Remove it
      // from the tabs map. The shared WS is closed ONLY when the last tab
      // exits (cleanupIfEmpty), so logging out in one tab does NOT kill
      // the connection for the other tabs. If this was the last tab,
      // disconnectWebSocket() tears down the WS, heartbeat, reconnect
      // timer, and outgoing queue.
      const tab = tabs.get(tabId);
      if (tab) {
        try {
          tab.port.postMessage({ type: 'disconnected', payload: { reason: 'client disconnect' } });
        } catch {
          /* port may already be closed */
        }
        tabs.delete(tabId);
      }
      cleanupIfEmpty();
      break;
    }

      case 'send':
        // Шаг 3: enqueue instead of ws.send directly. This guarantees FIFO
        // ordering across tabs and flushes when the WS becomes OPEN.
        enqueueOutgoing(message.payload.type, message.payload.data);
        // If WS is already OPEN, flush immediately (otherwise it will be
        // flushed on handshake_ack / onopen).
        if (ws?.readyState === WebSocket.OPEN) {
          flushOutgoing();
        }
        break;

    case 'subscribe': {
      const tab = tabs.get(tabId);
      if (tab) {
        message.payload.eventTypes.forEach((eventType) => {
          tab.subscriptions.add(eventType);
        });
        
        // Only send buffered messages if tab doesn't have wildcard (wildcard tabs already received full buffer on connect)
        if (!tab.subscriptions.has('*')) {
          const bufferedMessages = getBufferedMessages(message.payload.eventTypes);
          bufferedMessages.forEach((msg) => {
            try {
              tab.port.postMessage(msg);
            } catch (error) {
              console.error('[SharedWorker] Failed to send buffered message:', error);
            }
          });
        }
      }
      break;
    }

    case 'unsubscribe': {
      const tab = tabs.get(tabId);
      if (tab) {
        message.payload.eventTypes.forEach((eventType) => {
          tab.subscriptions.delete(eventType);
        });
      }
      break;
    }

    case 'get-state':
      port.postMessage({ type: 'state', payload: connectionState });
      break;

    case 'set-device-id':
      updateState({ deviceId: message.payload.deviceId });
      break;

    case 'update-token': {
      // Шаг 5 lifecycle: a tab just received a fresh JWT (token refresh).
      // Store it so the next reconnect attempt uses the new token. If the
      // current WS is dead and we were waiting for a fresh token, kick a
      // reconnect immediately.
      currentToken = message.payload.token;
      // If we're connected, no action needed (server will accept old token
      // until it expires; we'll reconnect with new one on next drop). If
      // we're disconnected but have URL + token and tabs still exist, try
      // to reconnect now.
      if (
        !ws &&
        currentUrl &&
        currentToken &&
        !explicitDisconnect &&
        tabs.size > 0
      ) {
        connectWebSocket(currentUrl, currentToken);
      }
      break;
    }
  }
}

// ==================== Connection Handler ====================

// SharedWorkerGlobalScope onconnect handler
// @ts-expect-error - SharedWorker global scope
self.onconnect = (event: MessageEvent) => {
  const port = event.ports[0];
  
  if (!port) {
    console.error('[SharedWorker] No port in connect event');
    return;
  }
  
  const tabId = generateTabId();

  tabs.set(tabId, {
    port,
    tabId,
    subscriptions: new Set(['*']),  // Wildcard: receive all messages by default
  });

  // Handle messages from tab FIRST (before sending any messages)
  port.onmessage = (e: MessageEvent) => {
    const message = e.data as WorkerClientMessage;
    handleMessage(port, message, tabId);
  };

  port.onmessageerror = () => {
    console.error('[SharedWorker] Message error from tab:', tabId);
    tabs.delete(tabId);
    cleanupIfEmpty();
  };

  // Send tab ID and current state
  port.postMessage({ type: 'connected', payload: { tabId } });
  port.postMessage({ type: 'state', payload: connectionState });

  // Send buffered messages immediately on connect (race condition fix for wildcard)
  const bufferedMessages = getBufferedMessages(['*']);
  bufferedMessages.forEach((msg) => {
    try {
      port.postMessage(msg);
    } catch (error) {
      console.error('[SharedWorker] Failed to send buffered message on connect:', error);
    }
  });
};

function cleanupIfEmpty(): void {
  if (tabs.size === 0) {
    disconnectWebSocket();
  }
}

// ==================== Broadcast Channel ====================

broadcastChannel.onmessage = (event: MessageEvent) => {
  // Handle cross-tab broadcast messages if needed
};
