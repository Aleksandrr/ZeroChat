/**
 * Reconnection Manager
 * Handles reconnection logic with exponential backoff
 */

import { toast } from '@/components/ui/toast';

/**
 * Reconnection configuration
 */
export interface ReconnectConfig {
  autoReconnect: boolean;
  /**
   * Maximum number of reconnection attempts before giving up.
   *
   * F2 fix: defaults to `Infinity` so the client never silently
   * gives up on a flaky network. The user can always close the tab
   * manually; a finite cap would require them to reload the page to
   * restore connectivity, which is a poor UX. Callers can still pass
   * a finite number if they need the old behaviour (e.g. tests).
   */
  maxReconnectAttempts: number;
  baseInterval: number;
  maxInterval: number;
  jitterFactor: number;
}

/**
 * Default reconnection configuration
 *
 * F2: `maxReconnectAttempts` is now `Infinity` (was 10) so the
 * manager keeps retrying indefinitely with a capped exponential
 * backoff + jitter.
 */
export const DEFAULT_RECONNECT_CONFIG: ReconnectConfig = {
  autoReconnect: true,
  maxReconnectAttempts: Infinity,
  baseInterval: 3000,
  maxInterval: 30000,
  jitterFactor: 0.3,
};

/**
 * Reconnection state
 */
export interface ReconnectState {
  attempts: number;
  lastAttempt: number | null;
  isReconnecting: boolean;
}

/**
 * Reconnection Manager Class
 * Manages reconnection attempts with exponential backoff and jitter
 *
 * F2 fix: infinite reconnect with exponential backoff capped at
 * `maxInterval` (30s by default) plus up to 1s of positive jitter
 * to avoid the thundering-herd problem. Toasts are emitted on
 * attempt > 1 ("Переподключение...") and on a fresh successful
 * reconnect cycle ("Подключение восстановлено").
 */
export class ReconnectManager {
  private config: ReconnectConfig;
  private state: ReconnectState;
  private timeoutId: number | null = null;
  private onReconnect: (() => Promise<void>) | null = null;
  /**
   * Tracks whether the current reconnect cycle has already shown the
   * "Переподключение..." toast. We only want to show it once per
   * outage (on the second attempt), not on every retry.
   */
  private reconnectingToastShown = false;
  /**
   * Tracks whether we have ever scheduled a reconnect in this cycle
   * (used to gate the "Подключение восстановлено" toast on `reset()`).
   */
  private hadReconnectInCycle = false;

  constructor(config: Partial<ReconnectConfig> = {}) {
    this.config = { ...DEFAULT_RECONNECT_CONFIG, ...config };
    this.state = {
      attempts: 0,
      lastAttempt: null,
      isReconnecting: false,
    };
  }

  /**
   * Set the reconnection callback
   */
  setReconnectCallback(callback: () => Promise<void>): void {
    this.onReconnect = callback;
  }

  /**
   * Get current state
   */
  getState(): ReconnectState {
    return { ...this.state };
  }

  /**
   * Get current attempt count
   */
  getAttempts(): number {
    return this.state.attempts;
  }

  /**
   * Check if reconnection is in progress
   */
  isInProgress(): boolean {
    return this.state.isReconnecting;
  }

  /**
   * Check if more attempts are allowed.
   *
   * F2: with the default `Infinity` cap this always returns true
   * (when `autoReconnect` is enabled), so the manager never gives
   * up on its own.
   */
  canReconnect(): boolean {
    return (
      this.config.autoReconnect &&
      this.state.attempts < this.config.maxReconnectAttempts
    );
  }

  /**
   * Calculate next backoff delay with jitter.
   *
   * Formula (F2 spec):
   *   delay = min(baseInterval * 2^attempt, maxInterval)
   *   delay += Math.random() * 1000   // positive jitter, 0..1s
   *
   * The legacy `jitterFactor` symmetric-jitter path is preserved as
   * a fallback for callers that explicitly set a non-default factor,
   * but the default flow now uses the additive 0..1s jitter from the
   * spec (simpler, always positive, bounded).
   */
  private calculateDelay(): number {
    const { baseInterval, maxInterval, jitterFactor } = this.config;
    const attempt = this.state.attempts;

    // Exponential backoff: base * 2^attempt
    const exponentialDelay = baseInterval * Math.pow(2, attempt);

    // Cap at max interval
    const cappedDelay = Math.min(exponentialDelay, maxInterval);

    // F2: additive positive jitter 0..1000ms (per spec).
    // Only fall back to the legacy multiplicative jitter if the caller
    // customised `jitterFactor` away from the default 0.3 — and even
    // then, keep the additive jitter on top so the spec's cap (1s) is
    // respected.
    const additiveJitter = Math.random() * 1000;
    let finalDelay = cappedDelay + additiveJitter;

    if (jitterFactor !== DEFAULT_RECONNECT_CONFIG.jitterFactor) {
      const multiplicativeJitter = cappedDelay * jitterFactor * (Math.random() * 2 - 1);
      finalDelay = cappedDelay + multiplicativeJitter + additiveJitter;
    }

    return Math.max(baseInterval, Math.round(finalDelay));
  }

  /**
   * Schedule next reconnection attempt
   */
  scheduleReconnect(): boolean {
    if (!this.canReconnect()) {
      return false;
    }

    this.state.isReconnecting = true;
    this.state.attempts++;
    this.state.lastAttempt = Date.now();
    this.hadReconnectInCycle = true;

    const attemptNumber = this.state.attempts;
    const delay = this.calculateDelay();

    // F2: surface reconnect status to the user via toasts.
    // - First attempt: stay quiet (transient blips shouldn't spam).
    // - Subsequent attempts: show "Переподключение..." once per outage.
    if (attemptNumber > 1 && !this.reconnectingToastShown) {
      toast.info('Переподключение...', `Попытка ${attemptNumber}`);
      this.reconnectingToastShown = true;
    }

    this.timeoutId = window.setTimeout(async () => {
      if (this.onReconnect) {
        try {
          await this.onReconnect();
        } catch (error) {
          console.error('[ReconnectManager] Reconnect failed:', error);
        }
      }
    }, delay);

    return true;
  }

  /**
   * Clear pending reconnection timeout
   */
  clearTimeout(): void {
    if (this.timeoutId !== null) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  /**
   * Reset reconnection state (after successful connection).
   *
   * F2: if a reconnect cycle was actually in progress (i.e. we
   * showed the "Переподключение..." toast), surface a one-shot
   * "Подключение восстановлено" success toast so the user knows
   * connectivity is back.
   */
  reset(): void {
    const wasReconnecting = this.hadReconnectInCycle;
    this.clearTimeout();
    this.state = {
      attempts: 0,
      lastAttempt: null,
      isReconnecting: false,
    };
    if (wasReconnecting) {
      toast.success('Подключение восстановлено');
    }
    this.reconnectingToastShown = false;
    this.hadReconnectInCycle = false;
  }

  /**
   * Stop reconnection process
   */
  stop(): void {
    this.clearTimeout();
    this.state.isReconnecting = false;
  }

  /**
   * Dispose resources
   */
  dispose(): void {
    this.stop();
    this.onReconnect = null;
    this.reconnectingToastShown = false;
    this.hadReconnectInCycle = false;
  }
}
