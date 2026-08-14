/**
 * Sync Module
 * 
 * Provides P2P synchronization functionality for multi-device support.
 * Implements the Sesame protocol for secure history sync between devices.
 * 
 * @see docs/signal/sesame.md - Sesame protocol specification
 */

export {
  createP2PSyncManager,
  type HistoryData,
  type P2PSyncConfig,
  P2PSyncManager,
  type SyncStatus,
} from './p2p-sync';
