/**
 * Sync Service Types
 * 
 * Types for synchronization API and protocol.
 * 
 * @see backend/src/services/sync.ts - Sync service implementation
 */

// ==================== Vector Clock ====================

export type VectorClock = Record<string, number>;

// ==================== Sync Event ====================

export interface SyncEvent {
  id: string;
  userId: string;
  deviceId: string;
  seq: number;
  entity: string;
  entityId: string;
  op: 'upsert' | 'delete' | 'tombstone';
  version: number;
  payloadCiphertext: string;
  serverReceivedAt: string;
}

// ==================== Sync Request ====================

export interface SyncRequest {
  vectorClock: VectorClock;
  events?: SyncEvent[];
}

// ==================== Sync Response ====================

export interface SyncResponse {
  success: boolean;
  vectorClock: VectorClock;
  events: SyncEvent[];
}

// ==================== Error Types ====================

export class SyncError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode?: number
  ) {
    super(message);
    this.name = 'SyncError';
  }
}
