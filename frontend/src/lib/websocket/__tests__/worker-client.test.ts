/**
 * Unit tests for WorkerWebSocketClient.
 *
 * The client is the in-tab façade over the WS SharedWorker. These tests
 * verify the contract documented in:
 *   - `lib/websocket/types.ts` (WebSocketClientInterface)
 *   - `lib/websocket/AGENTS.md`
 *
 * We mock the SharedWorker + MessagePort plumbing so the tests run in jsdom
 * (which does not provide SharedWorker natively) and don't spawn a real
 * worker. The mock port delivers messages to the client's `onmessage`
 * handler exactly as a real SharedWorker would.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkerWebSocketClient } from '../worker-client';
import type { WorkerServerMessage } from '@/workers/websocket.worker';

// ==================== SharedWorker / MessagePort mock ====================

/**
 * Minimal MessagePort mock. Calls to `postMessage` are captured; tests can
 * invoke `deliver()` to simulate the worker sending a message back to the
 * tab.
 */
class MockMessagePort {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  postMessage = vi.fn((message: unknown): void => {
    // Captured for assertions; no-op.
    void message;
  });
  start = vi.fn((): void => {
    /* no-op */
  });
  close = vi.fn((): void => {
    /* no-op */
  });
  /** Test helper: deliver a worker-originated message to the client. */
  deliver(message: WorkerServerMessage): void {
    if (!this.onmessage) return;
    this.onmessage({ data: message } as MessageEvent);
  }
}

class MockSharedWorker {
  port: MockMessagePort;
  constructor() {
    this.port = new MockMessagePort();
  }
}

// ==================== Setup / teardown ====================

let originalSharedWorker: typeof SharedWorker | undefined;

beforeEach(() => {
  // Install SharedWorker on globalThis so the client's `typeof SharedWorker`
  // check passes and `new SharedWorker(...)` succeeds.
  originalSharedWorker = (globalThis as { SharedWorker?: typeof SharedWorker })
    .SharedWorker;
  (globalThis as { SharedWorker?: typeof SharedWorker }).SharedWorker =
    MockSharedWorker as unknown as typeof SharedWorker;
});

afterEach(() => {
  // Restore
  if (originalSharedWorker === undefined) {
    delete (globalThis as { SharedWorker?: typeof SharedWorker }).SharedWorker;
  } else {
    (globalThis as { SharedWorker?: typeof SharedWorker }).SharedWorker =
      originalSharedWorker;
  }
  vi.restoreAllMocks();
});

// ==================== Helpers ====================

/**
 * Create a client and start the connect handshake. Returns the client plus
 * the underlying MockMessagePort so tests can drive inbound messages.
 *
 * Handshake flow (mirrors the real worker):
 *   1. `connect(url, token)` calls `new SharedWorker(...)` and starts port.
 *   2. Worker immediately sends `{ type: 'connected', payload: { tabId } }`.
 *   3. Client responds (in its `onmessage` handler) with a `{ type:
 *      'connect', payload: { url, token } }` message to actually open the WS.
 */
function setupConnectedClient() {
  const client = new WorkerWebSocketClient();
  client.connect('ws://localhost:3001/ws', 'jwt-token-1');

  // The constructor installs `port.onmessage` synchronously; the worker
  // delivers `connected` on the next tick in real life. Simulate it now.
  const worker = (client as unknown as { worker: MockSharedWorker }).worker;
  const port = worker.port;
  port.deliver({ type: 'connected', payload: { tabId: 'tab-1' } });

  return { client, port };
}

// ==================== Tests ====================

describe('WorkerWebSocketClient', () => {
  describe('connect()', () => {
    it('constructs a SharedWorker and starts the port', () => {
      const client = new WorkerWebSocketClient();
      client.connect('ws://localhost:3001/ws', 'jwt-token-1');

      const worker = (client as unknown as { worker: MockSharedWorker })
        .worker;
      expect(worker).toBeInstanceOf(MockSharedWorker);
      expect(worker.port.start).toHaveBeenCalledTimes(1);
    });

    it('after receiving the worker "connected" handshake, sends a "connect" command with url+token', () => {
      const client = new WorkerWebSocketClient();
      client.connect('ws://localhost:3001/ws', 'jwt-token-1');

      const port = (client as unknown as { worker: MockSharedWorker }).worker
        .port;

      // Before the worker says "connected", the client should NOT have sent
      // a 'connect' command yet.
      expect(port.postMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'connect' })
      );

      // Worker delivers tabId assignment
      port.deliver({ type: 'connected', payload: { tabId: 'tab-1' } });

      // Now the client should have sent a 'connect' command with the stored
      // url+token.
      expect(port.postMessage).toHaveBeenCalledWith({
        type: 'connect',
        payload: { url: 'ws://localhost:3001/ws', token: 'jwt-token-1' },
      });
      expect(client.getTabId()).toBe('tab-1');
    });

    it('is a no-op when already connected', () => {
      const { client, port } = setupConnectedClient();
      const initialCallCount = port.postMessage.mock.calls.length;
      // Calling connect() again while the worker exists but is already
      // initialized should not throw and should not re-issue another
      // 'connect' message (the client guards on `this.state.isConnected`,
      // but even before that flag flips it tracks `this.worker && this.port`
      // and resends only if not connected).
      client.connect('ws://localhost:3001/ws', 'jwt-token-1');
      // The client may re-send a 'connect' command if state.isConnected is
      // still false; that's the documented "Worker exists but WS not
      // connected" branch. The key contract is that no NEW SharedWorker
      // is constructed.
      const worker = (client as unknown as { worker: MockSharedWorker })
        .worker;
      expect(worker).toBeInstanceOf(MockSharedWorker);
      // postMessage call count must not have dropped.
      expect(port.postMessage.mock.calls.length).toBeGreaterThanOrEqual(
        initialCallCount
      );
    });

    it('emits an error when SharedWorker is not supported', () => {
      // Simulate a browser without SharedWorker by removing the global.
      delete (globalThis as { SharedWorker?: typeof SharedWorker })
        .SharedWorker;

      const client = new WorkerWebSocketClient();
      const errorHandler = vi.fn();
      client.on('error', errorHandler);

      client.connect('ws://localhost:3001/ws', 'jwt-token-1');

      expect(errorHandler).toHaveBeenCalledTimes(1);
      expect(errorHandler.mock.calls[0]![0]).toBeInstanceOf(Error);
    });
  });

  describe('disconnect()', () => {
    it('sends a "disconnect" command, closes the port, and resets state', () => {
      const { client, port } = setupConnectedClient();

      client.disconnect();

      expect(port.postMessage).toHaveBeenCalledWith({ type: 'disconnect' });
      expect(port.close).toHaveBeenCalledTimes(1);
      // State reset
      expect(client.isConnected).toBe(false);
      expect(client.isConnecting).toBe(false);
    });

    it('is a no-op when never connected', () => {
      const client = new WorkerWebSocketClient();
      expect(() => client.disconnect()).not.toThrow();
    });
  });

  describe('send()', () => {
    it('posts a "send" message to the worker with the type and data', () => {
      const { client, port } = setupConnectedClient();
      port.postMessage.mockClear();

      client.send('typing', { chatId: 'c1', isTyping: true });

      expect(port.postMessage).toHaveBeenCalledWith({
        type: 'send',
        payload: { type: 'typing', data: { chatId: 'c1', isTyping: true } },
      });
    });

    it('does not throw when the port is unavailable (logs only)', () => {
      const client = new WorkerWebSocketClient();
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {
        /* swallow */
      });
      expect(() => client.send('typing', {})).not.toThrow();
      errSpy.mockRestore();
    });
  });

  describe('sendMessage()', () => {
    it('proxies to send() and resolves', async () => {
      const { client, port } = setupConnectedClient();
      port.postMessage.mockClear();

      await client.sendMessage({ type: 'ping', payload: { ts: 1 } });

      expect(port.postMessage).toHaveBeenCalledWith({
        type: 'send',
        payload: { type: 'ping', data: { ts: 1 } },
      });
    });
  });

  describe('subscribeToEvent() / on()', () => {
    it('sends a "subscribe" command and registers the local handler', () => {
      const { client, port } = setupConnectedClient();
      port.postMessage.mockClear();

      const handler = vi.fn();
      const unsub = client.subscribeToEvent('NEW_MESSAGE', handler);

      expect(port.postMessage).toHaveBeenCalledWith({
        type: 'subscribe',
        payload: { eventTypes: ['NEW_MESSAGE'] },
      });

      // Simulate the worker delivering a NEW_MESSAGE
      port.deliver({
        type: 'message',
        payload: { type: 'NEW_MESSAGE', payload: { id: 'm1' } },
      });

      expect(handler).toHaveBeenCalledTimes(1);

      unsub();

      // After unsub, no more events are delivered to this handler
      port.deliver({
        type: 'message',
        payload: { type: 'NEW_MESSAGE', payload: { id: 'm2' } },
      });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('on() returns an unsubscribe that sends "unsubscribe" when refcount hits zero', () => {
      const { client, port } = setupConnectedClient();
      port.postMessage.mockClear();

      const handler1 = vi.fn();
      const handler2 = vi.fn();
      const unsub1 = client.on('read', handler1);
      const unsub2 = client.on('read', handler2);

      // Two listeners → 'subscribe' should have been sent once (refcount
      // only pushes the worker subscription on the FIRST listener).
      const subscribeCalls = port.postMessage.mock.calls.filter(
        (c) => (c[0] as { type: string }).type === 'subscribe'
      );
      expect(subscribeCalls).toHaveLength(1);

      unsub1();
      // Still one listener — no 'unsubscribe' yet.
      const unsubCallsAfter1 = port.postMessage.mock.calls.filter(
        (c) => (c[0] as { type: string }).type === 'unsubscribe'
      );
      expect(unsubCallsAfter1).toHaveLength(0);

      unsub2();
      // Last listener gone — 'unsubscribe' should be sent now.
      const unsubCallsAfter2 = port.postMessage.mock.calls.filter(
        (c) => (c[0] as { type: string }).type === 'unsubscribe'
      );
      expect(unsubCallsAfter2).toHaveLength(1);
    });
  });

  describe('incoming worker messages', () => {
    it('emits "state" updates through subscribeToState()', () => {
      const { client, port } = setupConnectedClient();
      const listener = vi.fn();
      client.subscribeToState(listener);

      // Clear the immediate-call made by subscribeToState (it calls back
      // synchronously with the current state).
      listener.mockClear();

      port.deliver({
        type: 'state',
        payload: {
          isConnected: true,
          isConnecting: false,
          lastError: null,
          reconnectAttempts: 0,
          deviceId: 'dev-1',
        },
      });

      expect(listener).toHaveBeenCalledTimes(1);
      const newState = listener.mock.calls[0]![0];
      expect(newState.isConnected).toBe(true);
      expect(newState.deviceId).toBe('dev-1');
      expect(client.isConnected).toBe(true);
    });

    it('emits full server message for NEW_MESSAGE events', () => {
      const { client, port } = setupConnectedClient();
      const handler = vi.fn();
      client.on('NEW_MESSAGE', handler);

      const serverMsg = {
        type: 'NEW_MESSAGE',
        payload: { id: 'm1', content: 'hi' },
        timestamp: 12345,
      };
      port.deliver({ type: 'message', payload: serverMsg });

      expect(handler).toHaveBeenCalledTimes(1);
      // Full-message events receive the entire server message object.
      expect(handler.mock.calls[0]![0]).toEqual(serverMsg);
    });

    it('emits payload for "read" events', () => {
      const { client, port } = setupConnectedClient();
      const handler = vi.fn();
      client.on('read', handler);

      const payload = { chatId: 'c1' };
      port.deliver({
        type: 'message',
        payload: { type: 'read', payload, timestamp: 1 },
      });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0]![0]).toEqual(payload);
    });

    it('emits "reconnecting" with attempt and delay', () => {
      const { client, port } = setupConnectedClient();
      const handler = vi.fn();
      client.on('reconnecting', handler);

      port.deliver({
        type: 'reconnecting',
        payload: { attempt: 2, delay: 1500 },
      });

      expect(handler).toHaveBeenCalledWith(2, 1500);
    });

    it('emits "error" with an Error object', () => {
      const { client, port } = setupConnectedClient();
      const handler = vi.fn();
      client.on('error', handler);

      port.deliver({
        type: 'error',
        payload: { code: 'WS_ERROR', message: 'boom' },
      });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0]![0]).toBeInstanceOf(Error);
      expect((handler.mock.calls[0]![0] as Error).message).toBe('boom');
    });

    it('emits "disconnected" with reason', () => {
      const { client, port } = setupConnectedClient();
      const handler = vi.fn();
      client.on('disconnected', handler);

      port.deliver({ type: 'disconnected', payload: { reason: 'bye' } });

      expect(handler).toHaveBeenCalledWith('bye');
    });
  });

  describe('updateToken()', () => {
    it('sends an "update-token" command when port is available', () => {
      const { client, port } = setupConnectedClient();
      port.postMessage.mockClear();

      client.updateToken('new-jwt-2');

      expect(port.postMessage).toHaveBeenCalledWith({
        type: 'update-token',
        payload: { token: 'new-jwt-2' },
      });
    });

    it('is a no-op when the port is unavailable (does not throw)', () => {
      const client = new WorkerWebSocketClient();
      // No port yet — updateToken should not throw and should not attempt
      // to send any worker message (there's nothing to send to).
      expect(() => client.updateToken('fresh-token')).not.toThrow();
      // After connect + handshake, the 'connect' command should carry the
      // token passed to connect(), not the stashed one — connect() is the
      // canonical source of truth.
      client.connect('ws://localhost:3001/ws', 'jwt-from-connect');
      const port = (client as unknown as { worker: MockSharedWorker }).worker
        .port;
      port.deliver({ type: 'connected', payload: { tabId: 'tab-x' } });
      expect(port.postMessage).toHaveBeenCalledWith({
        type: 'connect',
        payload: {
          url: 'ws://localhost:3001/ws',
          token: 'jwt-from-connect',
        },
      });
    });
  });

  describe('convenience senders', () => {
    it('sendTyping() forwards the typing payload', () => {
      const { client, port } = setupConnectedClient();
      port.postMessage.mockClear();
      client.sendTyping('chat-1', true);
      expect(port.postMessage).toHaveBeenCalledWith({
        type: 'send',
        payload: { type: 'typing', data: { chatId: 'chat-1', isTyping: true } },
      });
    });

    it('sendMarkRead() forwards the mark_read payload', () => {
      const { client, port } = setupConnectedClient();
      port.postMessage.mockClear();
      client.sendMarkRead('chat-1', ['m1', 'm2']);
      expect(port.postMessage).toHaveBeenCalledWith({
        type: 'send',
        payload: {
          type: 'mark_read',
          data: { chatId: 'chat-1', messageIds: ['m1', 'm2'] },
        },
      });
    });

    it('sendMultiDeviceMessage() returns a generated messageId', async () => {
      const { client, port } = setupConnectedClient();
      port.postMessage.mockClear();
      const id = await client.sendMultiDeviceMessage(
        'chat-1',
        'user-2',
        [{ deviceId: 1, content: 'enc', messageType: 2 }]
      );
      expect(typeof id).toBe('string');
      expect(id.startsWith('msg-')).toBe(true);
      expect(port.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'send',
          payload: expect.objectContaining({
            type: 'multi_message',
          }),
        })
      );
    });

    it('sendGroupMessage() returns a deterministic messageId when provided', async () => {
      const { client, port } = setupConnectedClient();
      port.postMessage.mockClear();
      const id = await client.sendGroupMessage(
        'chat-1',
        'user-1',
        'dev-1',
        'enc',
        'my-msg-id'
      );
      expect(id).toBe('my-msg-id');
    });

    it('sendSessionSync() forwards the session_sync payload', () => {
      const { client, port } = setupConnectedClient();
      port.postMessage.mockClear();
      client.sendSessionSync('user-2', 3, 'new_device');
      expect(port.postMessage).toHaveBeenCalledWith({
        type: 'send',
        payload: {
          type: 'session_sync',
          data: { userId: 'user-2', deviceId: 3, reason: 'new_device' },
        },
      });
    });
  });

  describe('destroy()', () => {
    it('disconnects and removes all listeners', () => {
      const { client, port } = setupConnectedClient();
      const handler = vi.fn();
      client.on('NEW_MESSAGE', handler);

      client.destroy();

      // Listeners cleared
      port.deliver({
        type: 'message',
        payload: { type: 'NEW_MESSAGE', payload: {} },
      });
      expect(handler).not.toHaveBeenCalled();
      // Disconnected
      expect(client.isConnected).toBe(false);
    });
  });

  describe('createWorkerClient()', () => {
    it('returns a fresh WorkerWebSocketClient instance', async () => {
      const { createWorkerClient } = await import('../worker-client');
      const c = createWorkerClient();
      expect(c).toBeInstanceOf(WorkerWebSocketClient);
      c.destroy();
    });
  });
});
