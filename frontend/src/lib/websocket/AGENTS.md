# WebSocket Module AGENTS.md

## Overview

Модульный WebSocket клиент для ZeroChat-TS с разделением ответственности. Обеспечивает надежное соединение с автоматическим переподключением, heartbeat механизмом и очередью сообщений.

**Ключевые особенности:**
- Модульная архитектура с четким разделением ответственности
- Автоматическое переподключение с exponential backoff
- Keep-alive через heartbeat/ping-pong (30 секунд)
- Очередь сообщений с подтверждением (ACK)
- Типизированные события через EventEmitter
- Поддержка Shared Worker для multi-tab синхронизации
- Интеграция с Signal Protocol для E2E шифрования

---

## Core Modules

### index.ts - Главный экспорт

**Расположение:** [`frontend/src/lib/websocket/index.ts`](index.ts)

Главный файл экспорта модуля WebSocket. Объединяет все компоненты и предоставляет единый интерфейс для использования.

**Экспорты:**

```typescript
// Main connection class
export { WebSocketConnection } from './connection';
export type { ConnectionState, WSConfig, PendingMessage } from './connection';
export { DEFAULT_WS_CONFIG } from './connection';

// Unified interface
export type { WebSocketClientInterface } from './types';

// Event emitter
export { EventEmitter } from './event-emitter';
export type { EventCallback } from './event-emitter';

// Reconnection manager
export { ReconnectManager, DEFAULT_RECONNECT_CONFIG } from './reconnect';
export type { ReconnectConfig, ReconnectState } from './reconnect';

// Message sender
export { MessageSender } from './message-sender';

// Heartbeat manager
export { HeartbeatManager, DEFAULT_HEARTBEAT_CONFIG } from './heartbeat';
export type { HeartbeatConfig } from './heartbeat';

// Shared Worker support
export { 
  WorkerWebSocketClient, 
  createWorkerClient,
  type WorkerClientMessage,
  type WorkerServerMessage,
} from './worker-client';

export {
  USE_SHARED_WORKER,
  shouldUseSharedWorker,
  useSharedWorker,
  destroySharedWorkerClient,
  type UseSharedWorkerResult,
} from './use-shared-worker';
```

---

### types.ts - TypeScript типы

**Расположение:** [`frontend/src/lib/websocket/types.ts`](types.ts)

Содержит все TypeScript типы и интерфейсы для WebSocket модуля.

**Основные типы:**

| Тип | Описание |
|-----|----------|
| `ConnectionState` | Состояние соединения (isConnected, isConnecting, lastError, reconnectAttempts) |
| `WSConfig` | Конфигурация WebSocket (url, token, autoReconnect, intervals) |
| `PendingMessage` | Сообщение в очереди ожидания |
| `WebSocketClientInterface` | Унифицированный интерфейс клиента (используется и WebSocketConnection, и WorkerWebSocketClient) |

```typescript
export interface ConnectionState {
  isConnected: boolean;
  isConnecting: boolean;
  lastError: Error | null;
  reconnectAttempts: number;
}

export interface WSConfig {
  url: string;
  token: string;
  autoReconnect: boolean;
  reconnectInterval: number;
  maxReconnectAttempts: number;
  heartbeatInterval: number;
  getToken?: () => Promise<string>; // Для обновления токена при переподключении
}

export interface WebSocketClientInterface {
  getState(): ConnectionState;
  subscribeToState(listener: (state: ConnectionState) => void): () => void;
  connect(url?: string, token?: string): Promise<void> | void;
  disconnect(): void;
  sendMessage(m: { type: string; payload: unknown }): Promise<void>;
  send(type: string, data: unknown): void;
  sendTyping(chatId: string, isTyping: boolean): void;
  sendMarkRead(chatId: string, messageIds?: string[]): void;
  // ... и другие методы
}
```

---

### connection.ts - Управление соединением

**Расположение:** [`frontend/src/lib/websocket/connection.ts`](connection.ts)

**Класс:** `WebSocketConnection`

Главный класс WebSocket клиента, координирующий все компоненты. Реализует интерфейс `WebSocketClientInterface`.

**Архитектура:**

```
┌─────────────────────────────────────────────────────────────────┐
│                    WebSocketConnection                          │
│  Главный класс, координирующий все компоненты                   │
└───────────────────────────┬─────────────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        │                   │                   │
        ▼                   ▼                   ▼
┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│ ReconnectMana │   │ HeartbeatMana │   │ MessageSender │
│ ger           │   │ ger           │   │               │
│ (reconnect.ts)│   │ (heartbeat.ts)│   │ (message-     │
│               │   │               │   │ sender.ts)    │
│ Exponential   │   │ Ping/Pong     │   │ Queue + ACK   │
│ backoff       │   │ 30s interval  │   │ handling      │
└───────────────┘   └───────────────┘   └───────────────┘
        │                   │                   │
        └───────────────────┼───────────────────┘
                            │
                            ▼
                   ┌───────────────┐
                   │ EventEmitter  │
                   │ (event-       │
                   │ emitter.ts)   │
                   │               │
                   │ Pub/Sub events│
                   └───────────────┘
```

**Основные методы:**

| Метод | Описание |
|-------|----------|
| `connect(url?, token?)` | Установка WebSocket соединения с handshake |
| `disconnect()` | Явное отключение с очисткой ресурсов |
| `reconnect()` | Принудительное переподключение |
| `sendMessage()` | Отправка сообщения через MessageSender |
| `sendTyping()` | Отправка индикатора набора текста |
| `sendMarkRead()` | Отправка подтверждения прочтения |
| `sendMultiDeviceMessage()` | Отправка multi-device сообщения |
| `sendGroupMessage()` | Отправка группового сообщения |
| `on(event, callback)` | Подписка на события |
| `subscribeToState()` | Подписка на изменения состояния |

**Handshake процесс:**

```typescript
this.ws.onopen = () => {
  const sendHandshake = () => {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'handshake',
        payload: { token: authToken },
        timestamp: Date.now(),
        messageId: this.messageSender.generateMessageId(),
      }));
    } else {
      setTimeout(sendHandshake, 10);
    }
  };
  sendHandshake();
};
```

---

### event-emitter.ts - Pub/Sub событий

**Расположение:** [`frontend/src/lib/websocket/event-emitter.ts`](event-emitter.ts)

**Класс:** `EventEmitter`

Простая реализация паттерна Observer для типизированных событий WebSocket.

**Методы:**

| Метод | Описание |
|-------|----------|
| `on(event, callback)` | Подписка на событие, возвращает функцию отписки |
| `off(event, callback)` | Отписка от события |
| `emit(event, ...args)` | Эмиссия события всем подписчикам |
| `removeAllListeners(event?)` | Удаление всех слушателей |

**Пример использования:**

```typescript
const unsubscribe = emitter.on('message', (data) => {
  console.log('Received:', data);
});
// Позже:
unsubscribe();
```

---

### heartbeat.ts - Keep-alive механизм

**Расположение:** [`frontend/src/lib/websocket/heartbeat.ts`](heartbeat.ts)

**Класс:** `HeartbeatManager`

Управляет keep-alive соединением через периодические ping/pong сообщения.

**Конфигурация по умолчанию:**

```typescript
export const DEFAULT_HEARTBEAT_CONFIG: HeartbeatConfig = {
  interval: 30000, // 30 секунд
};
```

**Методы:**

| Метод | Описание |
|-------|----------|
| `start()` | Запуск интервала ping |
| `stop()` | Остановка heartbeat |
| `isActive()` | Проверка активности |

**Интеграция с WebSocketConnection:**

```typescript
this.heartbeatManager = new HeartbeatManager(
  () => this.sendPing(),
  { interval: this.config.heartbeatInterval }
);
```

---

### message-sender.ts - Очередь сообщений

**Расположение:** [`frontend/src/lib/websocket/message-sender.ts`](message-sender.ts)

**Класс:** `MessageSender`

Управляет отправкой сообщений, очередью pending сообщений и обработкой ACK.

**Генерация ID сообщений:**

```typescript
generateMessageId(): string {
  return `${Date.now()}-${++this.messageIdCounter}-${Math.random().toString(36).substr(2, 9)}`;
}
```

**Методы отправки:**

| Метод | Описание |
|-------|----------|
| `sendChatMessage()` | Отправка шифрованного сообщения |
| `sendHandshake()` | Отправка handshake с токеном |
| `sendAck()` | Подтверждение получения сообщения |
| `sendTyping()` | Индикатор набора текста |
| `sendPresence()` | Статус онлайн/офлайн |
| `sendSessionSync()` | Синхронизация сессии (multi-device) |
| `sendMessageRetryRequest()` | Запрос повторной отправки |
| `sendMarkRead()` | Пометить как прочитанное |
| `sendMultiDeviceMessage()` | Отправка multi-device сообщения |
| `sendGroupMessage()` | Отправка группового сообщения |

**Pending messages (ненадежная доставка):**

```typescript
private storePending(message: WSMessage): void {
  this.pendingMessages.set(message.messageId, {
    message,
    timestamp: Date.now(),
  });
}
```

**Повторная отправка при восстановлении соединения:**

```typescript
resendPendingMessages(): void {
  const ws = this.getWebSocket();
  if (ws?.readyState === WebSocket.OPEN) {
    this.pendingMessages.forEach(({ message }) => {
      ws.send(JSON.stringify(message));
    });
  }
}
```

---

### reconnect.ts - Логика переподключения

**Расположение:** [`frontend/src/lib/websocket/reconnect.ts`](reconnect.ts)

**Класс:** `ReconnectManager`

Управляет автоматическим переподключением с exponential backoff и jitter.

**Конфигурация по умолчанию:**

```typescript
export const DEFAULT_RECONNECT_CONFIG: ReconnectConfig = {
  autoReconnect: true,
  maxReconnectAttempts: 10,
  baseInterval: 3000,    // 3 секунды
  maxInterval: 30000,    // 30 секунд
  jitterFactor: 0.3,     // 30% случайного отклонения
};
```

**Exponential backoff с jitter:**

```typescript
private calculateDelay(): number {
  const { baseInterval, maxInterval, jitterFactor } = this.config;
  const attempt = this.state.attempts;
  
  // Exponential backoff: base * 2^attempt
  const exponentialDelay = baseInterval * Math.pow(2, attempt);
  
  // Cap at max interval
  const cappedDelay = Math.min(exponentialDelay, maxInterval);
  
  // Add jitter to prevent thundering herd
  const jitter = cappedDelay * jitterFactor * (Math.random() * 2 - 1);
  const finalDelay = Math.round(cappedDelay + jitter);
  
  return Math.max(baseInterval, finalDelay);
}
```

**Пример задержек:**
- Попытка 1: ~3s (3000 + jitter)
- Попытка 2: ~6s (6000 + jitter)
- Попытка 3: ~12s (12000 + jitter)
- Попытка 4: ~24s (24000 + jitter)
- Попытка 5+: ~30s (capped)

---

## Shared Worker (Multi-Tab Support)

Модуль поддерживает два режима работы:
- **Direct WebSocket** - каждая вкладка имеет своё соединение
- **Shared Worker** - одно соединение на все вкладки

### Feature Flag

```typescript
// use-shared-worker.ts
export const USE_SHARED_WORKER = true; // Enabled: 2026-02-22
```

### use-shared-worker.ts - Hook для Shared Worker

**Расположение:** [`frontend/src/lib/websocket/use-shared-worker.ts`](use-shared-worker.ts)

React hook и утилиты для работы с Shared Worker.

**Экспорты:**

| Экспорт | Описание |
|---------|----------|
| `USE_SHARED_WORKER` | Feature flag (true/false) |
| `shouldUseSharedWorker()` | Проверка доступности SharedWorker API |
| `useSharedWorker()` | React hook для использования Shared Worker |
| `useWorkerEvent()` | Hook для подписки на события воркера |
| `destroySharedWorkerClient()` | Уничтожение клиента воркера |

**Fallback:**

Если `SharedWorker` API недоступен (например, Safari), автоматически используется прямой WebSocket:

```typescript
export function shouldUseSharedWorker(): boolean {
  if (typeof SharedWorker === 'undefined') {
    console.log('[SharedWorker] SharedWorker API not available');
    return false;
  }
  return USE_SHARED_WORKER;
}
```

### worker-client.ts - Клиент для воркера

**Расположение:** [`frontend/src/lib/websocket/worker-client.ts`](worker-client.ts)

**Класс:** `WorkerWebSocketClient`

Клиент для взаимодействия с Shared Worker. Реализует тот же `WebSocketClientInterface`, что и `WebSocketConnection`.

**Преимущества Shared Worker:**

1. **Одно WebSocket соединение** — независимо от количества вкладок
2. **Централизованная обработка** — все вкладки получают одинаковые события
3. **Экономия ресурсов** — меньше соединений на сервере
4. **Прозрачность** — API идентичен прямому WebSocket

### workers/ws-worker.ts - Сам воркер

**Расположение:** [`frontend/src/workers/websocket.worker.ts`](../../workers/websocket.worker.ts)

Shared Worker реализация, которая:
- Создает единое WebSocket соединение
- Управляет подключениями от multiple tabs (ports)
- Рассылает события всем подключенным вкладкам
- Обрабатывает переподключение централизованно

---

## Integration with Contexts

### WebSocketContext.tsx - React контекст

**Расположение:** [`frontend/src/contexts/WebSocketContext.tsx`](../../contexts/WebSocketContext.tsx)

Предоставляет WebSocket состояние и методы React компонентам. Поддерживает оба режима работы (Direct и Shared Worker).

```typescript
export interface WebSocketContextType {
  isConnected: boolean;
  isConnecting: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
  send: (type: string, payload: unknown) => Promise<void>;
  subscribe: (type: string, handler: MessageHandler) => () => void;
  sendTyping: (chatId: string, isTyping: boolean) => void;
  sendMarkRead: (chatId: string, messageIds?: string[]) => void;
  sendMultiDeviceMessage: (...) => Promise<string>;
  sendGroupMessage: (...) => Promise<string>;
  // Event subscriptions
  onMessage: (callback: (data: unknown) => void) => () => void;
  onNewMessage: (callback: (data: WSNewMessagePayload) => void) => () => void;
  onMessageDelivered: (callback: (data: WSMessageStatusPayload) => void) => () => void;
  onMessageRead: (callback: (data: WSMessageStatusPayload) => void) => () => void;
  onUserOnline: (callback: (data: { userId: string }) => void) => () => void;
  onUserOffline: (callback: (data: { userId: string }) => void) => () => void;
  // P2P Sync
  p2pSyncManager: P2PSyncManager | null;
  syncStatus: SyncStatus;
  requestSync: () => Promise<void>;
  // ... и другие методы
}
```

**Использование в компонентах:**

```typescript
import { useWebSocket } from '@/contexts/WebSocketContext';

function ChatComponent() {
  const { 
    isConnected, 
    sendTyping, 
    onNewMessage,
  } = useWebSocket();

  useEffect(() => {
    const unsub = onNewMessage((data) => {
      console.log('New message:', data);
    });
    return unsub;
  }, [onNewMessage]);

  const handleTyping = (isTyping: boolean) => {
    sendTyping(chatId, isTyping);
  };
}
```

### Интеграция с AuthContext

WebSocketContext зависит от AuthContext для:
- Получения токена аутентификации
- Обновления токена при истечении
- Отключения при разлогине

```typescript
const { isAuthenticated, user } = useAuth();
const wsUrl = import.meta.env.VITE_WS_URL || 'ws://localhost:3001/ws';

// Автоматическое подключение при аутентификации
useEffect(() => {
  if (isAuthenticated && isSignalReady) {
    connect();
  }
}, [isAuthenticated, isSignalReady]);
```

### Интеграция с ChatContext

WebSocketContext интегрируется с ChatContext для:
- Получения новых сообщений
- Отправки сообщений
- Обновления статусов (доставлено, прочитано)
- Индикаторов набора текста

---

## Message Types

### Базовый тип сообщения

**Расположение:** [`frontend/src/types/websocket.ts`](../../types/websocket.ts)

```typescript
export interface WSMessage {
  type: WSMessageType;
  payload: unknown;
  timestamp: number;
  messageId: string;
}
```

### Типы сообщений

| Тип | Описание |
|-----|----------|
| `handshake` | Аутентификация при подключении |
| `handshake_ack` | Подтверждение аутентификации |
| `message` | Шифрованное сообщение |
| `ack` | Подтверждение получения сообщения |
| `typing` | Индикатор набора текста |
| `presence` | Статус онлайн/офлайн |
| `ping` / `pong` | Keep-alive механизм |
| `error` | Ошибка |
| `mark_read` | Пометить как прочитанное |
| `read` | Событие прочтения |
| `read_ack` | Подтверждение прочтения |

### Чат сообщения (message)

```typescript
// Шифрованное сообщение
interface WSChatMessage {
  type: 'message';
  payload: {
    chatId: string;
    senderId: string;
    senderDeviceId: number;
    content: string;           // base64-encoded encrypted
    messageType: number;       // 2 = SignalMessage, 3 = PreKeySignalMessage
  };
  timestamp: number;
  messageId: string;
}
```

### Индикаторы набора (typing)

```typescript
interface WSTypingMessage {
  type: 'typing';
  payload: {
    chatId: string;
    userId: string;
    isTyping: boolean;
  };
  timestamp: number;
  messageId: string;
}
```

### Подтверждения (ack)

```typescript
interface WSAckMessage {
  type: 'ack';
  payload: {
    messageId: string;
    status: 'delivered' | 'read';
  };
  timestamp: number;
  messageId: string;
}
```

### Статус онлайн (presence)

```typescript
interface WSPresenceMessage {
  type: 'presence';
  payload: {
    userId: string;
    status: 'online' | 'offline';
    lastSeen?: string;
  };
  timestamp: number;
  messageId: string;
}
```

### Синхронизация (sync_*)

```typescript
// Запрос синхронизации
interface WSSyncRequestMessage {
  type: 'sync_request';
  payload: {
    requestingDeviceId: string;
    requestingSignalDeviceId?: number;
    targetDeviceId?: string;
    vectorClock: Record<string, number>;
  };
}

// Передача истории
interface WSSyncHistoryMessage {
  type: 'sync_history';
  payload: {
    targetDeviceId: string;
    senderDeviceId: string;
    senderSignalDeviceId?: number;
    encryptedHistory: string;
    vectorClock: Record<string, number>;
  };
}

// Приглашение к синхронизации (two-phase)
interface WSSyncInviteMessage {
  type: 'sync_invite';
  payload: {
    invitingDeviceId: string;
    invitingDeviceName?: string;
    timestamp: number;
  };
}

// Принятие синхронизации
interface WSSyncAcceptMessage {
  type: 'sync_accept';
  payload: {
    acceptingDeviceId: string;
    targetDeviceId: string;
    timestamp: number;
  };
}
```

### Signal Message Types

При отправке шифрованных сообщений используется `messageType`:

| Тип | Описание |
|-----|----------|
| 2 | `SignalMessage` - существующая сессия (Double Ratchet) |
| 3 | `PreKeySignalMessage` - новая сессия (X3DH/PQXDH) |

---

## Usage Examples

### Подключение и аутентификация

```typescript
import { WebSocketConnection } from '@/lib/websocket';

const ws = new WebSocketConnection({
  url: 'ws://localhost:3001/ws',
  token: 'jwt-token',
  autoReconnect: true,
  maxReconnectAttempts: 10,
});

// Подключение с handshake
await ws.connect('ws://localhost:3001/ws', 'jwt-token');

// Подписка на подключение
ws.onConnected(() => {
  console.log('WebSocket connected!');
});
```

### Отправка сообщений

```typescript
// Отправка шифрованного сообщения
const messageId = await ws.sendChatMessage(
  'chat-123',           // chatId
  'base64-encrypted',   // encryptedContent
  'user-456',           // recipientId
  1,                    // recipientDeviceId
  3                     // messageType (PreKey = 3, Signal = 2)
);

// Индикатор набора текста
ws.sendTyping('chat-123', true);

// Пометить как прочитанное
ws.sendMarkRead('chat-123', ['msg-1', 'msg-2']);

// Multi-device сообщение
await ws.sendMultiDeviceMessage(
  'chat-123',
  'recipient-id',
  [
    { deviceId: 1, content: 'encrypted-for-device-1', messageType: 2 },
    { deviceId: 2, content: 'encrypted-for-device-2', messageType: 2 },
  ]
);

// Групповое сообщение (Sender Keys)
await ws.sendGroupMessage(
  'group-chat-123',
  'sender-user-id',
  'sender-device-id',
  'encrypted-content',
  'message-id',
  'sender-key-id',
  undefined, // replyTo
  undefined, // attachments
  'sender-key-distribution-message' // SKDM для новых участников
);
```

### Подписка на события

```typescript
// Новые сообщения
const unsubMessage = ws.onNewMessage((data) => {
  console.log('New message:', data);
});

// Статус доставки
const unsubDelivered = ws.onMessageDelivered((data) => {
  console.log('Message delivered:', data.messageId);
});

// Статус прочтения
const unsubRead = ws.onMessageRead((data) => {
  console.log('Message read:', data.messageId);
});

// Статус набора
const unsubTyping = ws.onTyping((data) => {
  console.log(`${data.userId} is typing in ${data.chatId}`);
});

// Статус пользователя (онлайн/офлайн)
const unsubPresence = ws.onPresence((data) => {
  console.log(`${data.userId} is ${data.status}`);
});

// Синхронизация сессии
const unsubSync = ws.onSessionSync((data) => {
  console.log('Session sync:', data);
});

// Запрос синхронизации (P2P)
const unsubSyncRequest = ws.onSyncRequest((data) => {
  console.log('Sync requested by:', data.requestingDeviceId);
});

// Отписка от всех событий
unsubMessage();
unsubDelivered();
unsubRead();
unsubTyping();
unsubPresence();
unsubSync();
unsubSyncRequest();
```

### Переподключение

```typescript
// Принудительное переподключение
await ws.reconnect();

// Подписка на разрыв соединения
ws.onDisconnected(({ code, reason }) => {
  console.log(`Disconnected: ${code} - ${reason}`);
});

// Обработка ошибки Signal не готов
ws.onSignalNotReady((error) => {
  console.warn('Signal not ready:', error);
  // Инициализировать Signal Protocol заново
  initializeSignal(userId, deviceId);
});
```

### Управление состоянием

```typescript
// Получение текущего состояния
const state = ws.getState();
console.log('Connected:', state.isConnected);
console.log('Connecting:', state.isConnecting);
console.log('Reconnect attempts:', state.reconnectAttempts);
console.log('Last error:', state.lastError);

// Подписка на изменения состояния
const unsubState = ws.subscribeToState((state) => {
  console.log('State changed:', state);
});

// Отключение
ws.disconnect();
```

---

## Events Reference

### События EventEmitter

| Событие | Payload | Описание |
|---------|---------|----------|
| `connected` | `{}` | Соединение установлено |
| `disconnected` | `{ code, reason }` | Соединение разорвано |
| `error` | `Error` | Ошибка WebSocket |
| `message` | `WSMessage` | Входящее сообщение |
| `acked` | `messageId` | Сообщение подтверждено |
| `pong` | `WSMessage` | Ответ на ping |
| `signal_not_ready` | `Error` | Signal не инициализирован |
| `outgoing` | `WSMessage` | Исходящее сообщение |
| `typing` | `{ userId, chatId }` | Индикатор набора |
| `presence` | `{ userId, status }` | Статус пользователя |
| `NEW_MESSAGE` | `WSNewMessagePayload` | Новое сообщение (сервер) |
| `MESSAGE_DELIVERED` | `WSMessageStatusPayload` | Доставлено (сервер) |
| `MESSAGE_READ` | `WSMessageStatusPayload` | Прочитано (сервер) |
| `USER_ONLINE` | `{ userId }` | Пользователь онлайн |
| `USER_OFFLINE` | `{ userId }` | Пользователь офлайн |
| `SESSION_SYNC` | `{ userId, deviceId, reason }` | Синхронизация сессии |
| `MESSAGE_RETRY` | `{ originalMessageId, chatId, senderId, senderDeviceId }` | Запрос повтора |
| `read` | `WSReadEventPayload` | Событие прочтения |
| `read_ack` | `WSReadAckPayload` | Подтверждение прочтения |
| `sync_request` | `WSSyncRequestPayload` | Запрос синхронизации |
| `sync_history` | `WSSyncHistoryPayload` | Передача истории |
| `device_online` | `WSDeviceOnlinePayload` | Устройство онлайн |
| `sync_invite` | `WSSyncInvitePayload` | Приглашение к синхронизации |
| `sync_accept` | `WSSyncAcceptPayload` | Принятие синхронизации |
| `sync_cancel` | `WSSyncCancelPayload` | Отмена синхронизации |
| `sync_reject` | `WSSyncRejectPayload` | Отклонение синхронизации |

---

## Troubleshooting

### Частые проблемы

#### 1. WebSocket not OPEN yet

**Симптом:** Сообщения не отправляются сразу после connect()

**Решение:** Использовать callback `onConnected()` или проверить `isConnected`:

```typescript
// Неправильно
await ws.connect();
ws.sendChatMessage(...); // Может быть слишком рано

// Правильно
await ws.connect();
ws.onConnected(() => {
  ws.sendChatMessage(...);
});
```

#### 2. SIGNAL_DEVICE_NOT_READY

**Симптом:** Соединение закрывается с кодом 4003

**Причина:** Signal Protocol не инициализирован на устройстве

**Решение:**

```typescript
ws.onSignalNotReady((error) => {
  // Инициализировать Signal Protocol
  signal.initialize(userId, deviceId);
  // Затем переподключиться
  ws.reconnect();
});
```

#### 3. Превышено количество попыток переподключения

**Симптом:** После 10 попыток переподключение прекращается

**Решение:**

```typescript
// Увеличить лимит при создании
const ws = new WebSocketConnection({
  maxReconnectAttempts: 20,
  reconnectInterval: 2000,
});

// Или вручную переподключиться
ws.onDisconnected(({ code, reason }) => {
  if (code !== 1000) {
    ws.reconnect();
  }
});
```

#### 4. Сообщения теряются при разрыве

**Симптом:** Отправленные сообщения не доходят

**Причина:** Сообщения в pending queue не были подтверждены

**Решение:**

```typescript
// Проверить pending сообщения
const pending = ws.getPendingMessages();
console.log('Pending messages:', pending.length);

// Очистить при необходимости
ws.clearPendingMessages();
```

### Debug логирование

Модуль использует `console.log` с префиксом `[WebSocket]`:

```
[WebSocket] Connecting, token: eyJhbGciOiJIUzI1NiI...
[WebSocket] Connecting to: ws://localhost:3001/ws?token=...
[WebSocket] DEBUG onopen triggered, readyState: 1
[WebSocket] Sending handshake with token
[WebSocket] Handshake acknowledged, setting isConnected=true
[ReconnectManager] Reset
```

---

## Related Documentation

| Документ | Путь | Описание |
|----------|------|----------|
| WebSocket Types | [`frontend/src/types/websocket.ts`](../../types/websocket.ts) | Типы сообщений |
| WebSocketContext | [`frontend/src/contexts/WebSocketContext.tsx`](../../contexts/WebSocketContext.tsx) | React интеграция |
| Signal Protocol | [`frontend/src/lib/signal/AGENTS.md`](../signal/AGENTS.md) | Шифрование |
| Multi-Tab Sync | [`docs/architecture/multi-tab-sync/README.md`](../../../../docs/architecture/multi-tab-sync/README.md) | Архитектура multi-tab |
| Backend WebSocket | [`backend/src/ws/`](../../../../backend/src/ws/) | Серверная часть |
| Fastify WS Guide | [`docs/fastify-websocket.md`](../../../../docs/fastify-websocket.md) | Документация Fastify WebSocket |

---

## Quick Reference

### Конфигурация по умолчанию

```typescript
const DEFAULT_WS_CONFIG = {
  url: '',
  token: '',
  autoReconnect: true,
  reconnectInterval: 3000,     // 3s
  maxReconnectAttempts: 10,
  heartbeatInterval: 30000,    // 30s
};

const DEFAULT_RECONNECT_CONFIG = {
  autoReconnect: true,
  maxReconnectAttempts: 10,
  baseInterval: 3000,          // 3s
  maxInterval: 30000,          // 30s
  jitterFactor: 0.3,           // 30%
};

const DEFAULT_HEARTBEAT_CONFIG = {
  interval: 30000,             // 30s
};
```

---

*Last updated: 2026-03-02*
