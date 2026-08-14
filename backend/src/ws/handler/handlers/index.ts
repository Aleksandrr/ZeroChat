// Export all handler functions

// Auth handlers
export { handleAuthMessage, handlePreKeyMessage } from './auth-handlers';

// Presence handlers
export { handleHeartbeat, handlePing, handleTypingMessage, broadcastPresence } from './presence-handlers';

// Message handlers
export { handleAckMessage, handleMessageRetry, handleMarkRead } from './message-handlers';

// Multi-device handlers
export { handleMultiDeviceMessage, handleFavoritesMessage } from './multi-device-handlers';

// Sync handlers (Sesame protocol)
export {
  handleSessionSync,
  handleSyncRequest,
  handleSyncHistory,
  handleSyncAck,
  handleDeviceOnline,
  notifyDeviceOnline,
  handleMessageAck,
  resetStaleDelivering,
  handleClientReady,
  sendPendingMessages
} from './sync-handlers';

// P2P Sync handlers
export {
  handleSyncInvite,
  handleSyncAccept,
  handleSyncCancel,
  handleSyncReject
} from './p2p-sync-handlers';

// Group handlers
export {
  handleGroupMessage,
  handleGroupKeyUpdate,
  handleGroupSync,
  handleSenderKeyDistribution
} from './group-handlers';

// Command Bus handlers
export { handleCommand } from './command-handlers';

// WebRTC Call handlers
export {
  handleCallOffer,
  handleCallAnswer,
  handleCallReject,
  handleCallEnd,
  handleCallIce,
  handleCallBusy,
} from './call-handlers';
