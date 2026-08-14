/**
 * Chat List Coordinator
 *
 * Prevents multiple tabs from simultaneously fetching the chat list.
 * Uses BroadcastChannel for cross-tab communication and localStorage for leader election.
 *
 * Pattern:
 * 1. First tab to request chats becomes the leader.
 * 2. Other tabs request data from the leader.
 * 3. Leader either responds with cached data (if fresh) or fetches and broadcasts.
 *
 * This reduces server load when multiple tabs are opened simultaneously.
 */

import { chatService } from '@/services/chat';
import type { Chat } from '@/types';

const CHANNEL_NAME = 'zerochat:chats';
const LEADER_KEY = 'zerochat:chats:leader';
const LEADER_TIMEOUT = 30_000; // 30 seconds to consider leader dead
const FETCH_TIMEOUT = 15_000; // 15 seconds max wait for leader

interface BaseMessage {
  sourceTabId: string;
  timestamp: number;
}

interface ChatUpdateMessage extends BaseMessage {
  type: 'chats:update';
  chats: Chat[];
}

interface LeaderHeartbeatMessage extends BaseMessage {
  type: 'leader:heartbeat';
}

interface ChatRequestMessage {
  type: 'chats:request';
  sourceTabId: string;
  timestamp: number;
}

type BroadcastMessage = ChatUpdateMessage | LeaderHeartbeatMessage | ChatRequestMessage;

function generateTabId(): string {
  return `tab-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Singleton coordinator for chat list fetching across tabs.
 */
export class ChatListCoordinator {
  private static instance: ChatListCoordinator | null = null;

  private tabId: string;
  private channel: BroadcastChannel;
  private isLeader = false;
  private leaderTabId: string | null = null;
  private fetchResolve: ((chats: Chat[]) => void) | null = null;
  private fetchReject: ((error: Error) => void) | null = null;
  private cachedChats: Chat[] | null = null;
  private cacheTimestamp = 0;
  private readonly STALE_TIME = 60_000; // 1 minute
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private pendingResolvers = new Set<(chats: Chat[]) => void>();

  private constructor() {
    this.tabId = generateTabId();
    this.channel = new BroadcastChannel(CHANNEL_NAME);
    this.channel.onmessage = this.handleMessage.bind(this);

    // Clean up on page unload (using pagehide as unload is deprecated)
    window.addEventListener('pagehide', () => {
      this.destroy();
    });
  }

  static getInstance(): ChatListCoordinator {
    if (!ChatListCoordinator.instance) {
      ChatListCoordinator.instance = new ChatListCoordinator();
    }
    return ChatListCoordinator.instance;
  }

  /**
   * Get chat list, coordinating with other tabs to avoid duplicate fetches.
   * @param forceRefresh - If true, bypass cache and force a fresh fetch.
   */
  async getChats(forceRefresh = false): Promise<Chat[]> {
    // Return fresh cache if available and not forcing refresh
    const now = Date.now();
    if (!forceRefresh && this.cachedChats && (now - this.cacheTimestamp < this.STALE_TIME)) {
      return this.cachedChats;
    }

    // Check if another tab is already the leader
    const existingLeader = this.getCurrentLeader();

    if (existingLeader && existingLeader !== this.tabId) {
      // Another tab is leading, request data and wait for broadcast
      return this.requestFromLeader(forceRefresh);
    }

    // Become the leader
    this.becomeLeader();

    // If we already have fresh data and not forcing, just broadcast and return
    if (!forceRefresh && this.cachedChats && (now - this.cacheTimestamp < this.STALE_TIME)) {
      this.broadcastUpdate(this.cachedChats);
      return this.cachedChats;
    }

    // Perform the fetch
    return this.fetchAsLeader();
  }

  /**
   * Force a refresh regardless of cache state.
   */
  async forceRefresh(): Promise<Chat[]> {
    return this.getChats(true);
  }

  /**
   * Request data from the current leader and wait for response.
   */
  private requestFromLeader(_forceRefresh: boolean): Promise<Chat[]> {
    // _forceRefresh is used in the setTimeout callback below (fallback to leader)
    return new Promise<Chat[]>((resolve, reject) => {
      // Send request to leader
      this.channel.postMessage({
        type: 'chats:request',
        sourceTabId: this.tabId,
        timestamp: Date.now(),
      } as ChatRequestMessage);

      // Set timeout
      const timeout = setTimeout(() => {
        // Remove from pending set
        this.pendingResolvers.delete(resolve);
        // Leader not responding, try to become leader ourselves
        localStorage.removeItem(LEADER_KEY);
        this.isLeader = false;
        this.leaderTabId = null;
        // Retry as leader
        this.getChats(_forceRefresh)
          .then(resolve)
          .catch(reject);
      }, FETCH_TIMEOUT);

      // Wrap resolve to clear timeout and pending set
      const wrappedResolve = (chats: Chat[]) => {
        clearTimeout(timeout);
        this.pendingResolvers.delete(wrappedResolve);
        resolve(chats);
      };

      this.pendingResolvers.add(wrappedResolve);
    });
  }

  /**
   * Check if there's a current leader in localStorage.
   */
  private getCurrentLeader(): string | null {
    const leader = localStorage.getItem(LEADER_KEY);
    if (!leader) return null;

    // Check if leader is still alive (has recent heartbeat)
    const heartbeatKey = `${LEADER_KEY}:heartbeat:${leader}`;
    const lastHeartbeat = parseInt(localStorage.getItem(heartbeatKey) || '0', 10);
    if (Date.now() - lastHeartbeat > LEADER_TIMEOUT) {
      // Leader is stale, take over
      localStorage.removeItem(LEADER_KEY);
      return null;
    }

    return leader;
  }

  /**
   * Become the leader by setting the lock.
   */
  private becomeLeader(): void {
    localStorage.setItem(LEADER_KEY, this.tabId);
    this.isLeader = true;
    this.leaderTabId = this.tabId;
    this.startHeartbeat();
  }

  /**
   * Start sending periodic heartbeats.
   */
  private startHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    this.heartbeatInterval = setInterval(() => {
      if (this.isLeader) {
        this.channel.postMessage({
          type: 'leader:heartbeat',
          sourceTabId: this.tabId,
          timestamp: Date.now(),
        } as LeaderHeartbeatMessage);
      }
    }, 5000);
  }

  /**
   * Fetch chats as the leader and broadcast results.
   */
  private async fetchAsLeader(): Promise<Chat[]> {
    try {
      const chats = await chatService.getChats();
      this.cachedChats = chats;
      this.cacheTimestamp = Date.now();

      // Broadcast to other tabs
      this.broadcastUpdate(chats);

      // Resolve any waiting tabs (from our own getChats call)
      if (this.fetchResolve) {
        this.fetchResolve(chats);
        this.fetchResolve = null;
        this.fetchReject = null;
      }

      return chats;
    } catch (error) {
      // Clear leader state so another tab can take over
      this.isLeader = false;
      this.leaderTabId = null;
      localStorage.removeItem(LEADER_KEY);
      if (this.fetchReject) {
        this.fetchReject(error instanceof Error ? error : new Error('Failed to fetch chats'));
        this.fetchResolve = null;
        this.fetchReject = null;
      }
      throw error;
    }
  }

  /**
   * Broadcast chat update to all tabs.
   */
  private broadcastUpdate(chats: Chat[]): void {
    const message: ChatUpdateMessage = {
      type: 'chats:update',
      chats,
      sourceTabId: this.tabId,
      timestamp: Date.now(),
    };
    this.channel.postMessage(message);
  }

  /**
   * Handle incoming broadcast messages.
   */
  private handleMessage(event: MessageEvent): void {
    const message = event.data as BroadcastMessage;

    // Ignore messages from self
    if (message.sourceTabId === this.tabId) {
      return;
    }

    switch (message.type) {
      case 'chats:update':
        this.handleChatUpdate(message);
        break;
      case 'leader:heartbeat':
        this.handleHeartbeat(message);
        break;
      case 'chats:request':
        this.handleChatRequest(message);
        break;
    }
  }

  /**
   * Handle chat update from leader.
   */
  private handleChatUpdate(message: ChatUpdateMessage): void {
    this.cachedChats = message.chats;
    this.cacheTimestamp = message.timestamp;

    // Resolve all pending waiters
    this.pendingResolvers.forEach(resolve => resolve(message.chats));
    this.pendingResolvers.clear();
  }

  /**
   * Handle heartbeat from leader.
   */
  private handleHeartbeat(message: LeaderHeartbeatMessage): void {
    this.leaderTabId = message.sourceTabId;
    // Update leader's heartbeat in localStorage
    const heartbeatKey = `${LEADER_KEY}:heartbeat:${message.sourceTabId}`;
    localStorage.setItem(heartbeatKey, message.timestamp.toString());
  }

  /**
   * Handle chat data request from a follower.
   */
  private handleChatRequest(_message: ChatRequestMessage): void {
    if (!this.isLeader) return;

    // If we have fresh data, broadcast immediately
    const now = Date.now();
    if (this.cachedChats && (now - this.cacheTimestamp < this.STALE_TIME)) {
      this.broadcastUpdate(this.cachedChats);
    } else if (!this.fetchResolve) {
      // Not fresh and not already fetching, start a fetch
      // We don't await; it will broadcast when done
      this.fetchAsLeader().catch(console.error);
    }
    // If already fetching, the broadcast will happen when fetch completes
  }

  /**
   * Clean up resources.
   */
  destroy(): void {
    if (this.isLeader) {
      localStorage.removeItem(LEADER_KEY);
    }
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    this.channel.close();
    if (this.fetchReject) {
      this.fetchReject(new Error('Coordinator destroyed'));
      this.fetchResolve = null;
      this.fetchReject = null;
    }
    // Reject all pending waiters
    this.pendingResolvers.forEach(resolve => {
      resolve([]); // Or could reject, but resolve with empty to avoid unhandled rejections
    });
    this.pendingResolvers.clear();
  }
}

// Export singleton instance
export const chatListCoordinator = ChatListCoordinator.getInstance();
