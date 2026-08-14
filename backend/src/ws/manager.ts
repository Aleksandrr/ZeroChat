// ==================== WebSocket Client Interface ====================

export interface WSClient {
  getUserId(): string;
  getDeviceId(): string;
  getSignalDeviceId(): number; // Signal Protocol device ID
  send(data: unknown): boolean; // Returns true if sent, false if socket closed
  close(code?: number, reason?: string): void;
  isOpen(): boolean;
}

// ==================== Connection Info ====================

export interface ConnectionInfo {
  client: WSClient;
  connectedAt: Date;
  lastActivity: Date;
  messageCount: number;
}

// ==================== WebSocket Manager ====================

export class WebSocketManager {
  // Хранение клиентов по deviceId
  private clients: Map<string, WSClient> = new Map();
  
  // Хранение клиентов по userId (может быть несколько устройств)
  private userConnections: Map<string, Set<string>> = new Map();
  
  // Дополнительная информация о соединениях
  private connectionInfo: Map<string, ConnectionInfo> = new Map();

  /**
   * Добавляет нового клиента в менеджер
   */
  addClient(client: WSClient): void {
    const deviceId = client.getDeviceId();
    const userId = client.getUserId();

    // Добавляем в clients map
    this.clients.set(deviceId, client);

    // Добавляем в userConnections (множество deviceId для пользователя)
    if (!this.userConnections.has(userId)) {
      this.userConnections.set(userId, new Set());
    }
    this.userConnections.get(userId)!.add(deviceId);

    // Сохраняем метаданные соединения
    this.connectionInfo.set(deviceId, {
      client,
      connectedAt: new Date(),
      lastActivity: new Date(),
      messageCount: 0
    });

    console.log(`Клиент добавлен: deviceId=${deviceId}, userId=${userId}, всего=${this.clients.size}`);
  }

  /**
   * Удаляет клиента из менеджера
   * RC-5 FIX: Optional expectedClient parameter prevents ghost disconnect
   * from deleting a newer connection that replaced the old one.
   */
  removeClient(deviceId: string, expectedClient?: WSClient): void {
    const stored = this.clients.get(deviceId);
    
    if (!stored) return;

    // If expectedClient provided, only remove if it's the same object
    // This prevents ghost disconnect from old socket deleting new connection
    if (expectedClient && stored !== expectedClient) {
      console.log(`[Manager] removeClient: skipped — deviceId ${deviceId} replaced by newer connection`);
      return;
    }

    const userId = stored.getUserId();

    // Удаляем из userConnections
    const userDevices = this.userConnections.get(userId);
    if (userDevices) {
      userDevices.delete(deviceId);
      if (userDevices.size === 0) {
        this.userConnections.delete(userId);
      }
    }

    // Удаляем connection info
    this.connectionInfo.delete(deviceId);

    // Удаляем из clients
    this.clients.delete(deviceId);

    console.log(`Клиент удалён: deviceId=${deviceId}, userId=${userId}`);
  }

  /**
   * Обновляет информацию о клиенте (например, после re-auth)
   */
  updateClient(client: WSClient): void {
    const deviceId = client.getDeviceId();
    
    if (this.clients.has(deviceId)) {
      this.clients.set(deviceId, client);
      
      // Обновляем connection info
      const info = this.connectionInfo.get(deviceId);
      if (info) {
        info.client = client;
        info.lastActivity = new Date();
      }
    }
  }

  /**
   * Получает клиента по deviceId
   */
  getClient(deviceId: string): WSClient | undefined {
    return this.clients.get(deviceId);
  }

  /**
   * Получает всех клиентов пользователя по userId
   */
  getClientsByUserId(userId: string): WSClient[] {
    const deviceIds = this.userConnections.get(userId);
    if (!deviceIds) {
      return [];
    }
    
    return Array.from(deviceIds)
      .map(deviceId => this.clients.get(deviceId))
      .filter((client): client is WSClient => client !== undefined);
  }

  /**
   * Получает первого доступного клиента пользователя
   */
  getClientByUserId(userId: string): WSClient | undefined {
    const clients = this.getClientsByUserId(userId);
    return clients.length > 0 ? clients[0] : undefined;
  }

  /**
   * Проверяет, находится ли пользователь онлайн
   */
  isUserOnline(userId: string): boolean {
    return this.userConnections.has(userId) && this.userConnections.get(userId)!.size > 0;
  }

  /**
   * Получает количество активных соединений
   */
  getConnectionCount(): number {
    return this.clients.size;
  }

  /**
   * Получает количество онлайн пользователей
   */
  getOnlineUserCount(): number {
    return this.userConnections.size;
  }

  /**
   * Обновляет время активности соединения
   */
  updateActivity(deviceId: string): void {
    const info = this.connectionInfo.get(deviceId);
    if (info) {
      info.lastActivity = new Date();
      info.messageCount++;
    }
  }

  /**
   * Отправляет сообщение конкретному клиенту
   */
  sendToDevice(deviceId: string, data: unknown): boolean {
    const client = this.clients.get(deviceId);
    
    // RC-2 fix: send() returns boolean, no need for separate isOpen() check
    if (client && client.send(data)) {
      this.updateActivity(deviceId);
      return true;
    }
    
    return false;
  }

  /**
   * Отправляет сообщение всем устройствам пользователя
   */
  sendToUser(userId: string, data: unknown): number {
    const clients = this.getClientsByUserId(userId);
    let sentCount = 0;

    for (const client of clients) {
      // RC-2 fix: send() returns boolean
      if (client.send(data)) {
        this.updateActivity(client.getDeviceId());
        sentCount++;
      }
    }

    return sentCount;
  }

  /**
   * Отправляет сообщение всем онлайн клиентам (broadcast)
   */
  broadcast(data: unknown): number {
    let sentCount = 0;

    for (const [deviceId, client] of this.clients) {
      client.send(data);
      this.updateActivity(deviceId);
      sentCount++;
    }

    return sentCount;
  }

  /**
   * Получает информацию о соединении
   */
  getConnectionInfo(deviceId: string): ConnectionInfo | undefined {
    return this.connectionInfo.get(deviceId);
  }

  /**
   * Получает статистику менеджера
   */
  getStats(): { totalConnections: number; onlineUsers: number } {
    return {
      totalConnections: this.clients.size,
      onlineUsers: this.userConnections.size
    };
  }

  /**
   * Очищает все соединения (для тестирования)
   */
  clear(): void {
    this.clients.clear();
    this.userConnections.clear();
    this.connectionInfo.clear();
  }
}

// NOTE: previously this file also exported `export const wsManager = new WebSocketManager();`
// creating a SECOND singleton distinct from the one in `ws/index.ts`.
// Files importing from `../ws/manager` directly would get the unused one.
// Removed — callers should import `wsManager` from `../ws` instead.
