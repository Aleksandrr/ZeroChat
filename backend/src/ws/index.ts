import { FastifyInstance } from 'fastify';
import { WebSocketHandler, WebSocketClient } from './handler';
import { WebSocketManager } from './manager';
import { config } from '../config';

// Экспортируем WebSocketManager для использования в других сервисах
export let wsManager: WebSocketManager;
export let wsHandler: WebSocketHandler;

/**
 * C7 (connection limits):
 *  - Global cap: config.websocket.maxConnections (default 1000).
 *    Prevents a single backend instance from being DoSed by socket
 *    floods. Pre-auth check — sockets over the cap are closed with
 *    1013 (Try Again Later) before we spend CPU on auth.
 *  - Per-user cap: config.websocket.maxDevicesPerUser (default 10).
 *    Prevents one account from exhausting the global pool. Post-auth
 *    check — enforced in the onClientCreated callback (after we know
 *    the userId).
 */
const MAX_DEVICES_PER_USER = config.websocket.maxDevicesPerUser;

export async function setupWebSocketRoutes(
  fastify: FastifyInstance
): Promise<void> {
  wsManager = new WebSocketManager();
  wsHandler = new WebSocketHandler(wsManager);

  // Декорируем Fastify инстанс для доступа к wsManager в роутах
  fastify.decorate('wsManager', wsManager);

  // Храним маппинг socket -> client
  const socketClients = new Map<any, WebSocketClient>();

  // Храним буферы сообщений для сокетов в процессе аутентификации
  const socketBuffers = new Map<any, { buffer: string[]; isAuthenticated: boolean }>();

  fastify.get(
    '/ws',
    {
      websocket: true,
      handler: async (socket: any, request: any) => {
        // C7: Global connection limit. Pre-auth check — if the
        // server already holds `maxConnections` active managed
        // clients, reject immediately with 1013 so the client can
        // retry against another backend instance. We intentionally
        // use the managed-clients count (not raw socket count) so
        // half-open probes that never authenticate don't bump the
        // counter.
        if (wsManager.getConnectionCount() >= config.websocket.maxConnections) {
          try {
            socket.close(1013, 'Maximum connections reached');
          } catch {
            // socket may already be closed
          }
          return;
        }

        // RACE CONDITION FIX: Create buffer immediately when socket connects
        // This ensures no messages are lost during authentication
        socketBuffers.set(socket, { buffer: [], isAuthenticated: false });

        // CRITICAL: Register message handler BEFORE handleConnection to avoid race condition
        // handleConnection sends handshake_ack, then client immediately sends 'ready'
        // If we register handler after handleConnection, 'ready' message is lost
        socket.on('message', (message: string) => {
          const socketData = socketBuffers.get(socket);
          const clientForMessage = socketClients.get(socket);

          // If authenticated, process message directly
          if (socketData?.isAuthenticated && clientForMessage) {
            wsHandler.handleMessage(message, clientForMessage);
          } else if (socketData) {
            // Buffer message until authentication completes
            socketData.buffer.push(message);
            console.log(`[WS] Buffered message during auth (total: ${socketData.buffer.length})`);
          } else {
            console.warn('[WS] Message received but socket not tracked');
          }
        });

        socket.on('close', async () => {
          const clientForDisconnect = socketClients.get(socket);
          if (clientForDisconnect) {
            await wsHandler.handleDisconnect(clientForDisconnect);
            socketClients.delete(socket);
          }
          // Cleanup buffer
          socketBuffers.delete(socket);
        });

        socket.on('error', (error: Error) => {
          console.error('WebSocket ошибка:', error);
        });

        // Обработка нового соединения
        // Pass a callback to immediately register client when created (before async operations)
        await wsHandler.handleConnection(socket, request, (c: WebSocketClient) => {
          // C7: Per-user device limit. handleConnection has already
          // added the client to the manager at this point, so the
          // count includes the just-added device. If it exceeds the
          // cap, close the socket — the 'close' handler will then
          // call handleDisconnect which removes the client from the
          // manager.
          const userId = c.getUserId();
          const userDeviceCount = wsManager.getClientsByUserId(userId).length;
          if (userDeviceCount > MAX_DEVICES_PER_USER) {
            console.warn(
              `[WS] Per-user device limit exceeded: user=${userId} devices=${userDeviceCount} (max=${MAX_DEVICES_PER_USER})`,
            );
            try {
              c.close(1013, 'Too many devices for this user');
            } catch {
              // socket may already be closed
            }
            return;
          }

          socketClients.set(socket, c);

          // RACE CONDITION FIX: Mark as authenticated and process buffered messages
          const socketData = socketBuffers.get(socket);
          if (socketData) {
            socketData.isAuthenticated = true;

            if (socketData.buffer.length > 0) {
              console.log(`[WS] Processing ${socketData.buffer.length} buffered messages after auth`);
              for (const bufferedMessage of socketData.buffer) {
                wsHandler.handleMessage(bufferedMessage, c);
              }
              socketData.buffer = []; // Clear buffer after processing
            }
          }
        });
      },
    }
  );
}
