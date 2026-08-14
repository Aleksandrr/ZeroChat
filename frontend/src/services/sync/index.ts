/**
 * Sync Service Module
 * 
 * Provides synchronization functionality based on the Sesame protocol.
 * Handles vector clock synchronization and conflict resolution.
 * 
 * @see docs/signal/sesame.md - Sesame protocol specification
 */

// Types
export type {
  SyncEvent,
  SyncRequest,
  SyncResponse,
  VectorClock,
} from './types';
export { SyncError } from './types';

// API Functions
export {
  pullEvents,
  pushEvents,
  sync,
} from './api';
