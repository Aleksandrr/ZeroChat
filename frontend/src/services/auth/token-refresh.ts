/**
 * TokenRefreshManager - Управление жизненным циклом токенов
 *
 * Функции:
 * - Proactive refresh (обновление до истечения токена)
 * - Очередь запросов при refresh (mutex для предотвращения race conditions)
 * - Интеграция с Broadcast Channel для синхронизации между вкладками
 *
 * SECURITY: Refresh token отправляется через httpOnly cookie (credentials: 'include').
 * JavaScript не имеет доступа к refresh token.
 *
 * @module auth/token-refresh
 */

import { getAccessToken, parseJwtPayload, setAccessToken } from './tokens';
import { AuthError } from './types';

// ==================== Configuration ====================

/**
 * Feature flag для proactive refresh
 */
const PROACTIVE_TOKEN_REFRESH = import.meta.env['VITE_PROACTIVE_TOKEN_REFRESH'] !== 'false';

/**
 * Конфигурация TokenRefreshManager
 */
export interface TokenRefreshManagerConfig {
  /** За сколько секунд до истечения делать refresh (по умолчанию 60) */
  refreshBufferSeconds: number;
  /** Интервал периодической проверки токена в ms (по умолчанию 30000) */
  checkIntervalMs: number;
  /** Включить proactive refresh (по умолчанию true, зависит от feature flag) */
  enableProactiveRefresh: boolean;
}

const DEFAULT_CONFIG: TokenRefreshManagerConfig = {
  refreshBufferSeconds: 60,
  checkIntervalMs: 30000,
  enableProactiveRefresh: PROACTIVE_TOKEN_REFRESH,
};

// ==================== Types ====================

/**
 * Обработчики событий TokenRefreshManager
 */
export interface TokenRefreshHandlers {
  /** Вызывается при успешном обновлении токена */
  onTokenRefreshed?: (newToken: string) => void;
  /** Вызывается при ошибке обновления токена */
  onRefreshFailed?: (error: Error) => void;
  /** Вызывается при необходимости редиректа на логин */
  onRedirectToLogin?: () => void;
}

/**
 * Результат refresh операции
 */
export interface RefreshResult {
  success: boolean;
  accessToken?: string;
  error?: Error;
}

// ==================== TokenRefreshManager Class ====================

/**
 * TokenRefreshManager - Singleton класс для управления обновлением токенов
 *
 * Использование:
 * ```typescript
 * const manager = TokenRefreshManager.getInstance();
 *
 * // Установка обработчиков
 * manager.setHandlers({
 *   onTokenRefreshed: (token) => console.log('Token refreshed'),
 *   onRefreshFailed: (error) => console.error('Refresh failed', error),
 * });
 *
 * // Запуск proactive refresh
 * manager.start();
 *
 * // Остановка при логауте
 * manager.stop();
 * ```
 */
export class TokenRefreshManager {
  private static instance: TokenRefreshManager | null = null;

  private config: TokenRefreshManagerConfig;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private checkInterval: ReturnType<typeof setInterval> | null = null;

  // Mutex для предотвращения race conditions
  private isRefreshing = false;
  private refreshQueue: {
    resolve: (token: string) => void;
    reject: (error: Error) => void;
  }[] = [];

  // Обработчики событий
  private handlers: TokenRefreshHandlers = {};

  // Broadcast Channel для синхронизации между вкладками
  private broadcastChannel: BroadcastChannel | null = null;
  private tabId: string;

  // Флаг инициализации
  private isStarted = false;

  // Защита от повторного refresh (React StrictMode)
  private lastRefreshStartTime = 0;  // Время начала последнего запроса
  private lastRefreshSuccessTime = 0;  // Время последнего успешного refresh
  private readonly MIN_REFRESH_INTERVAL_MS = 5000; // 5 секунд минимальный интервал

  private constructor(config?: Partial<TokenRefreshManagerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.tabId = crypto.randomUUID();

    // Инициализация Broadcast Channel
    this.initBroadcastChannel();
  }

  /**
   * Получить singleton instance
   */
  public static getInstance(config?: Partial<TokenRefreshManagerConfig>): TokenRefreshManager {
    if (!TokenRefreshManager.instance) {
      TokenRefreshManager.instance = new TokenRefreshManager(config);
    }
    return TokenRefreshManager.instance;
  }

  /**
   * Сбросить singleton (для тестов)
   */
  public static resetInstance(): void {
    if (TokenRefreshManager.instance) {
      TokenRefreshManager.instance.stop();
      TokenRefreshManager.instance = null;
    }
  }

  // ==================== Public API ====================

  /**
   * Запуск мониторинга токена
   */
  public start(): void {
    if (this.isStarted) {
      return;
    }

    this.isStarted = true;

    if (this.config.enableProactiveRefresh) {
      this.scheduleProactiveRefresh();
      this.startPeriodicCheck();
    }
  }

  /**
   * Остановка мониторинга
   */
  public stop(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }

    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }

    this.isStarted = false;
    this.isRefreshing = false;
    this.refreshQueue = [];
    // Note: Не сбрасываем lastRefreshTime, чтобы защититься от повторного refresh
    // при быстром remount (React StrictMode)
  }

  /**
   * Установка обработчиков событий
   */
  public setHandlers(handlers: TokenRefreshHandlers): void {
    this.handlers = { ...this.handlers, ...handlers };
  }

  /**
   * Сброс времени последнего refresh (вызывать при логине)
   */
  public resetLastRefreshTime(): void {
    this.lastRefreshStartTime = 0;
    this.lastRefreshSuccessTime = 0;
  }

  /**
   * Ожидание завершения текущего refresh
   * Возвращает Promise, который резолвится с новым токеном
   * или реджектится с ошибкой
   */
  public async waitForRefresh(): Promise<string> {
    // Если refresh не идёт, возвращаем текущий токен
    if (!this.isRefreshing) {
      const token = getAccessToken();
      if (token) return token;
      throw new AuthError('No access token available', 'NO_ACCESS_TOKEN');
    }

    // Иначе добавляем в очередь
    return new Promise((resolve, reject) => {
      this.refreshQueue.push({ resolve, reject });
    });
  }

  /**
   * Принудительный refresh токена
   * Используется при 401 ошибках
   */
  public async forceRefresh(): Promise<RefreshResult> {
    try {
      const newToken = await this.doRefresh();
      return { success: true, accessToken: newToken };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      return { success: false, error: err };
    }
  }

  /**
   * Проверка, нужно ли обновить токен
   */
  public shouldRefreshToken(): boolean {
    const token = getAccessToken();
    if (!token) return false;

    const payload = parseJwtPayload(token);
    const exp = payload?.['exp'];
    if (!payload || typeof exp !== 'number') return true;

    const expiresAt = exp * 1000;
    const refreshAt = expiresAt - (this.config.refreshBufferSeconds * 1000);
    const now = Date.now();

    return now >= refreshAt;
  }

  /**
   * Получить время до истечения токена в секундах
   */
  public getTimeUntilExpiry(): number | null {
    const token = getAccessToken();
    if (!token) return null;

    const payload = parseJwtPayload(token);
    const exp = payload?.['exp'];
    if (!payload || typeof exp !== 'number') return null;

    const expiresAt = exp * 1000;
    const now = Date.now();

    return Math.max(0, Math.floor((expiresAt - now) / 1000));
  }

  // ==================== Private Methods ====================

  /**
   * Инициализация Broadcast Channel
   */
  private initBroadcastChannel(): void {
    try {
      this.broadcastChannel = new BroadcastChannel('auth:token-refresh');

      this.broadcastChannel.onmessage = (event) => {
        const { type, sourceTabId, payload } = event.data;

        // Игнорируем события от своей вкладки
        if (sourceTabId === this.tabId) return;

        switch (type) {
          case 'auth:token-refreshed':
            // Токен обновлён в другой вкладке
            this.handlers.onTokenRefreshed?.(payload.newToken);
            break;

          case 'auth:refresh-failed':
            // Refresh не удался в другой вкладке
            this.handlers.onRefreshFailed?.(new Error(payload.error));
            this.handlers.onRedirectToLogin?.();
            break;
        }
      };
    } catch {
      // BroadcastChannel not supported, will use localStorage fallback
    }
  }

  /**
   * Отправка события через Broadcast Channel
   */
  private broadcast(type: string, payload: unknown): void {
    if (!this.broadcastChannel) return;

    this.broadcastChannel.postMessage({
      type,
      sourceTabId: this.tabId,
      payload,
      timestamp: Date.now(),
    });
  }

  /**
   * Запланировать proactive refresh
   */
  private scheduleProactiveRefresh(): void {
    const token = getAccessToken();
    if (!token) {
      return;
    }

    const payload = parseJwtPayload(token);
    const exp = payload?.['exp'];
    if (!payload || typeof exp !== 'number') {
      return;
    }

    const expiresAt = exp * 1000;
    const refreshAt = expiresAt - (this.config.refreshBufferSeconds * 1000);
    const now = Date.now();

    if (refreshAt <= now) {
      // Токен уже нужно обновлять
      this.doProactiveRefresh();
      return;
    }

    const delay = refreshAt - now;

    this.refreshTimer = setTimeout(() => {
      this.doProactiveRefresh();
    }, delay);
  }

  /**
   * Выполнить proactive refresh
   */
  private async doProactiveRefresh(): Promise<void> {
    if (this.isRefreshing) {
      return;
    }

    // Защита от повторного refresh (React StrictMode double-invoke)
    // Проверяем время начала последнего запроса, а не успешного завершения
    const timeSinceLastStart = Date.now() - this.lastRefreshStartTime;
    if (this.lastRefreshStartTime > 0 && timeSinceLastStart < this.MIN_REFRESH_INTERVAL_MS) {
      return;
    }

    // Записываем время начала запроса ДО самого запроса
    this.lastRefreshStartTime = Date.now();

    try {
      const newToken = await this.doRefresh();

      // Уведомляем обработчики
      this.handlers.onTokenRefreshed?.(newToken);

      // Уведомляем другие вкладки
      this.broadcast('auth:token-refreshed', { newToken });

      // Планируем следующий refresh
      if (this.isStarted && this.config.enableProactiveRefresh) {
        this.scheduleProactiveRefresh();
      }
    } catch (error) {
      console.error('[TokenRefreshManager] Proactive refresh failed:', error);

      const err = error instanceof Error ? error : new Error(String(error));

      // Уведомляем обработчики
      this.handlers.onRefreshFailed?.(err);

      // Уведомляем другие вкладки
      this.broadcast('auth:refresh-failed', { error: err.message });
    }
  }

  /**
   * Выполнить refresh с очередью
   */
  private async doRefresh(): Promise<string> {
    // Если уже обновляем - ждём в очереди
    if (this.isRefreshing) {
      return new Promise((resolve, reject) => {
        this.refreshQueue.push({ resolve, reject });
      });
    }

    this.isRefreshing = true;

    try {
      const newToken = await this.callRefreshApi();

      // Обновляем время последнего успешного refresh
      this.lastRefreshSuccessTime = Date.now();

      // Разрешаем все ожидающие промисы
      this.refreshQueue.forEach(({ resolve }) => resolve(newToken));
      this.refreshQueue = [];

      return newToken;
    } catch (error) {
      // Отклоняем все ожидающие промисы
      const err = error instanceof Error ? error : new Error(String(error));
      this.refreshQueue.forEach(({ reject }) => reject(err));
      this.refreshQueue = [];

      throw error;
    } finally {
      this.isRefreshing = false;
    }
  }

  /**
   * Вызов API для refresh токена
   * SECURITY: Refresh token отправляется через httpOnly cookie (credentials: 'include')
   */
  private async callRefreshApi(): Promise<string> {
    const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001/api';
    const url = `${API_BASE_URL}/auth/refresh`;

    // Refresh token is sent via httpOnly cookie automatically
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
      credentials: 'include',
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const errorMessage = errorData.message || `Token refresh failed with status ${response.status}`;
      throw new AuthError(errorMessage, 'REFRESH_FAILED', response.status);
    }

    const data = await response.json() as {
      success: boolean;
      data?: {
        accessToken: string;
        expiresIn: number;
        tokenId: string;
      };
    };

    if (!data.success || !data.data?.accessToken) {
      throw new AuthError('Invalid refresh response', 'INVALID_REFRESH_RESPONSE');
    }

    // Сохраняем новый access token (refresh token в httpOnly cookie)
    setAccessToken(data.data.accessToken);

    return data.data.accessToken;
  }

  /**
   * Периодическая проверка токена
   */
  private startPeriodicCheck(): void {
    this.checkInterval = setInterval(() => {
      const token = getAccessToken();

      if (!token) {
        return;
      }

      const payload = parseJwtPayload(token);
      const exp = payload?.['exp'];
      if (!payload || typeof exp !== 'number') {
        return;
      }

      const expiresAt = exp * 1000;
      const now = Date.now();

      // Проверяем, истёк ли токен
      if (now >= expiresAt - 30000) { // 30s buffer
        this.doProactiveRefresh();
      }
    }, this.config.checkIntervalMs);
  }
}

// ==================== Convenience Functions ====================

/**
 * Получить singleton instance TokenRefreshManager
 */
export function getTokenRefreshManager(): TokenRefreshManager {
  return TokenRefreshManager.getInstance();
}

/**
 * Запустить proactive token refresh
 */
export function startProactiveRefresh(config?: Partial<TokenRefreshManagerConfig>): void {
  const manager = TokenRefreshManager.getInstance(config);
  manager.start();
}

/**
 * Остановить proactive token refresh
 */
export function stopProactiveRefresh(): void {
  const manager = TokenRefreshManager.getInstance();
  manager.stop();
}
