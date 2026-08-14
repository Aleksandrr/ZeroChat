/**
 * Simple event emitter for WebSocket events
 * Provides type-safe event subscription and emission
 */

/**
 * Event callback type
 */
export type EventCallback = (...args: unknown[]) => void;

/**
 * Simple event emitter for WebSocket events
 * Supports subscription, unsubscription, and emission of named events
 */
export class EventEmitter {
  private events = new Map<string, Set<EventCallback>>();

  /**
   * Subscribe to an event
   * @param event - Event name
   * @param callback - Callback function
   * @returns Unsubscribe function
   */
  on(event: string, callback: EventCallback): () => void {
    if (!this.events.has(event)) {
      this.events.set(event, new Set());
    }
    this.events.get(event)!.add(callback);
    
    return () => this.off(event, callback);
  }

  /**
   * Unsubscribe from an event
   * @param event - Event name
   * @param callback - Callback function to remove
   */
  off(event: string, callback: EventCallback): void {
    this.events.get(event)?.delete(callback);
  }

  /**
   * Emit an event to all subscribers
   * @param event - Event name
   * @param args - Arguments to pass to callbacks
   */
  emit(event: string, ...args: unknown[]): void {
    this.events.get(event)?.forEach(callback => callback(...args));
  }

  /**
   * Remove all listeners for an event or all events
   * @param event - Optional event name (if omitted, clears all events)
   */
  removeAllListeners(event?: string): void {
    if (event) {
      this.events.delete(event);
    } else {
      this.events.clear();
    }
  }
}