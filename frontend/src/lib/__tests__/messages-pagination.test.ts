/**
 * Message pagination tests — exercises lib/messages/db.ts against a
 * realistic in-memory IndexedDB (fake-indexeddb).
 *
 * Verifies the cursor-based pagination flow used by `useMessages` hook:
 *
 *   1. `getRecentMessages(chatId, limit)` — initial load returns up to
 *      `limit` most recent messages in chronological (oldest-first) order
 *   2. `getOlderMessagesWithCursor(chatId, cursorMessageId, limit)` —
 *      loads the next page of older messages
 *   3. `getChatMessagesPaginated(chatId, limit, beforeTimestamp)` —
 *      timestamp-based pagination (alternative API)
 *   4. `getOlderMessages(chatId, beforeTimestamp, limit, maxTimestamp?)` —
 *      timestamp-based pagination with optional cutoff (used for
 *      pagination-isolation from real-time arrivals)
 *
 * Edge cases:
 *   - empty chat returns []
 *   - missing cursor message returns []
 *   - chat with fewer messages than `limit` returns everything
 *   - messages from other chats don't bleed into the result
 *   - descending → ascending reversal preserves chronological order
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import 'fake-indexeddb/auto';

import {
  initMessagesDB,
  storeMessage,
  storeMessages,
  getMessage,
  getChatMessages,
  getChatMessagesPaginated,
  getRecentMessages,
  getOlderMessages,
  getOlderMessagesWithCursor,
  clearAllMessages,
  MESSAGE_STORES,
  type StoredMessage,
} from '@/lib/messages/db';

// Helper: build a StoredMessage with sensible defaults.
function makeMessage(
  id: string,
  chatId: string,
  timestamp: number,
  overrides: Partial<StoredMessage> = {},
): StoredMessage {
  return {
    id,
    chatId,
    senderId: 'user-1',
    senderUsername: 'alice',
    senderDeviceId: 1,
    content: `Message ${id}`,
    timestamp,
    createdAt: timestamp,
    messageType: 2,
    isOutgoing: false,
    status: 'delivered',
    ...overrides,
  };
}

// Helper: insert N messages into chat `chatId` with timestamps 1..N.
async function seedChatMessages(
  chatId: string,
  count: number,
  startTimestamp = 1_000_000,
): Promise<StoredMessage[]> {
  const msgs: StoredMessage[] = [];
  for (let i = 0; i < count; i++) {
    msgs.push(
      makeMessage(`${chatId}-msg-${String(i).padStart(3, '0')}`, chatId, startTimestamp + i * 1000),
    );
  }
  await storeMessages(msgs);
  return msgs;
}

describe('messages pagination — getRecentMessages (initial load)', () => {
  beforeEach(async () => {
    await initMessagesDB();
    await clearAllMessages();
  });

  it('returns the most recent N messages in chronological (oldest-first) order', async () => {
    const seeded = await seedChatMessages('chat-1', 50);
    const recent = await getRecentMessages('chat-1', 10);
    expect(recent).toHaveLength(10);
    // Should be the 10 most recent (msg-040..msg-049), oldest-first.
    expect(recent[0]!.id).toBe('chat-1-msg-040');
    expect(recent[9]!.id).toBe('chat-1-msg-049');
    // Chronological order: timestamps ascending.
    for (let i = 1; i < recent.length; i++) {
      expect(recent[i]!.timestamp).toBeGreaterThan(recent[i - 1]!.timestamp);
    }
    void seeded;
  });

  it('returns all messages when fewer than `limit` exist', async () => {
    await seedChatMessages('chat-2', 5);
    const recent = await getRecentMessages('chat-2', 30);
    expect(recent).toHaveLength(5);
    expect(recent[0]!.id).toBe('chat-2-msg-000');
    expect(recent[4]!.id).toBe('chat-2-msg-004');
  });

  it('returns an empty array for an empty chat', async () => {
    const recent = await getRecentMessages('chat-empty', 30);
    expect(recent).toEqual([]);
  });

  it('returns an empty array for a non-existent chat', async () => {
    await seedChatMessages('chat-A', 10);
    const recent = await getRecentMessages('chat-B', 30);
    expect(recent).toEqual([]);
  });

  it('does NOT leak messages from other chats', async () => {
    await seedChatMessages('chat-A', 10);
    await seedChatMessages('chat-B', 10);
    const recent = await getRecentMessages('chat-A', 100);
    expect(recent).toHaveLength(10);
    expect(recent.every(m => m.chatId === 'chat-A')).toBe(true);
  });

  it('default limit is 30', async () => {
    await seedChatMessages('chat-1', 50);
    const recent = await getRecentMessages('chat-1');
    expect(recent).toHaveLength(30);
  });
});

describe('messages pagination — getOlderMessagesWithCursor (cursor-based)', () => {
  beforeEach(async () => {
    await initMessagesDB();
    await clearAllMessages();
  });

  it('loads the next page of older messages using the cursor message ID', async () => {
    await seedChatMessages('chat-1', 50);
    // Cursor = msg-040 (oldest from the first page of 10).
    const older = await getOlderMessagesWithCursor('chat-1', 'chat-1-msg-040', 10);
    expect(older).toHaveLength(10);
    // Should be msg-030..msg-039, oldest-first.
    expect(older[0]!.id).toBe('chat-1-msg-030');
    expect(older[9]!.id).toBe('chat-1-msg-039');
  });

  it('returns fewer than `limit` when at the start of history', async () => {
    await seedChatMessages('chat-1', 50);
    // Cursor = msg-005 → only 5 older messages (msg-000..msg-004).
    const older = await getOlderMessagesWithCursor('chat-1', 'chat-1-msg-005', 10);
    expect(older).toHaveLength(5);
    expect(older[0]!.id).toBe('chat-1-msg-000');
    expect(older[4]!.id).toBe('chat-1-msg-004');
  });

  it('returns an empty array when the cursor is the oldest message', async () => {
    await seedChatMessages('chat-1', 50);
    const older = await getOlderMessagesWithCursor('chat-1', 'chat-1-msg-000', 10);
    expect(older).toEqual([]);
  });

  it('returns an empty array when the cursor message does not exist', async () => {
    await seedChatMessages('chat-1', 50);
    const older = await getOlderMessagesWithCursor('chat-1', 'non-existent-msg', 10);
    expect(older).toEqual([]);
  });

  it('does NOT include the cursor message itself in the result', async () => {
    await seedChatMessages('chat-1', 50);
    const older = await getOlderMessagesWithCursor('chat-1', 'chat-1-msg-040', 10);
    expect(older.find(m => m.id === 'chat-1-msg-040')).toBeUndefined();
  });

  it('multi-page iteration walks through the entire history', async () => {
    await seedChatMessages('chat-1', 100);
    const pageSize = 25;

    // Page 1: most recent 25 messages (msg-075..msg-099).
    let page = await getRecentMessages('chat-1', pageSize);
    expect(page).toHaveLength(pageSize);
    expect(page[0]!.id).toBe('chat-1-msg-075');
    expect(page[pageSize - 1]!.id).toBe('chat-1-msg-099');

    // Page 2: cursor = oldest from page 1 = msg-075.
    page = await getOlderMessagesWithCursor('chat-1', page[0]!.id, pageSize);
    expect(page).toHaveLength(pageSize);
    expect(page[0]!.id).toBe('chat-1-msg-050');
    expect(page[pageSize - 1]!.id).toBe('chat-1-msg-074');

    // Page 3: cursor = msg-050.
    page = await getOlderMessagesWithCursor('chat-1', page[0]!.id, pageSize);
    expect(page).toHaveLength(pageSize);
    expect(page[0]!.id).toBe('chat-1-msg-025');
    expect(page[pageSize - 1]!.id).toBe('chat-1-msg-049');

    // Page 4: cursor = msg-025.
    page = await getOlderMessagesWithCursor('chat-1', page[0]!.id, pageSize);
    expect(page).toHaveLength(pageSize);
    expect(page[0]!.id).toBe('chat-1-msg-000');
    expect(page[pageSize - 1]!.id).toBe('chat-1-msg-024');

    // Page 5: cursor = msg-000 → no older messages.
    page = await getOlderMessagesWithCursor('chat-1', page[0]!.id, pageSize);
    expect(page).toEqual([]);
  });
});

describe('messages pagination — getChatMessagesPaginated (timestamp-based)', () => {
  beforeEach(async () => {
    await initMessagesDB();
    await clearAllMessages();
  });

  it('returns the most recent N messages when no beforeTimestamp is given', async () => {
    await seedChatMessages('chat-1', 50);
    const page = await getChatMessagesPaginated('chat-1', 10);
    expect(page).toHaveLength(10);
    expect(page[0]!.id).toBe('chat-1-msg-040');
    expect(page[9]!.id).toBe('chat-1-msg-049');
  });

  it('returns messages older than beforeTimestamp', async () => {
    await seedChatMessages('chat-1', 50);
    // Cursor = timestamp of msg-040.
    const cursor = 1_000_000 + 40 * 1000;
    const page = await getChatMessagesPaginated('chat-1', 10, cursor);
    expect(page).toHaveLength(10);
    // Should be msg-030..msg-039 (strictly older than msg-040).
    expect(page[0]!.id).toBe('chat-1-msg-030');
    expect(page[9]!.id).toBe('chat-1-msg-039');
  });

  it('returns all messages older than beforeTimestamp when fewer than limit exist', async () => {
    await seedChatMessages('chat-1', 50);
    const cursor = 1_000_000 + 5 * 1000; // msg-005 timestamp
    const page = await getChatMessagesPaginated('chat-1', 10, cursor);
    expect(page).toHaveLength(5); // msg-000..msg-004
    expect(page[0]!.id).toBe('chat-1-msg-000');
    expect(page[4]!.id).toBe('chat-1-msg-004');
  });

  it('returns an empty array when no messages are older than beforeTimestamp', async () => {
    await seedChatMessages('chat-1', 50);
    const cursor = 1_000_000; // before any message
    const page = await getChatMessagesPaginated('chat-1', 10, cursor);
    expect(page).toEqual([]);
  });
});

describe('messages pagination — getOlderMessages (with optional maxTimestamp)', () => {
  beforeEach(async () => {
    await initMessagesDB();
    await clearAllMessages();
  });

  it('loads older messages without maxTimestamp', async () => {
    await seedChatMessages('chat-1', 50);
    const beforeTs = 1_000_000 + 40 * 1000;
    const older = await getOlderMessages('chat-1', beforeTs, 10);
    expect(older).toHaveLength(10);
    expect(older[0]!.id).toBe('chat-1-msg-030');
    expect(older[9]!.id).toBe('chat-1-msg-039');
  });

  it('maxTimestamp caps the upper bound (pagination isolation)', async () => {
    await seedChatMessages('chat-1', 50);
    // beforeTs = msg-045 timestamp, maxTimestamp = msg-040 timestamp.
    // Should return messages older than msg-040 (msg-030..msg-039).
    const beforeTs = 1_000_000 + 45 * 1000;
    const maxTs = 1_000_000 + 40 * 1000;
    const older = await getOlderMessages('chat-1', beforeTs, 10, maxTs);
    expect(older).toHaveLength(10);
    expect(older[0]!.id).toBe('chat-1-msg-030');
    expect(older[9]!.id).toBe('chat-1-msg-039');
  });

  it('maxTimestamp = beforeTimestamp behaves identically to no maxTimestamp', async () => {
    await seedChatMessages('chat-1', 50);
    const ts = 1_000_000 + 40 * 1000;
    const withoutMax = await getOlderMessages('chat-1', ts, 10);
    const withMax = await getOlderMessages('chat-1', ts, 10, ts);
    expect(withoutMax.map(m => m.id)).toEqual(withMax.map(m => m.id));
  });
});

describe('messages pagination — getChatMessages (full chat, no limit)', () => {
  beforeEach(async () => {
    await initMessagesDB();
    await clearAllMessages();
  });

  it('returns all messages in the chat in chronological order', async () => {
    await seedChatMessages('chat-1', 25);
    const all = await getChatMessages('chat-1');
    expect(all).toHaveLength(25);
    expect(all[0]!.id).toBe('chat-1-msg-000');
    expect(all[24]!.id).toBe('chat-1-msg-024');
    for (let i = 1; i < all.length; i++) {
      expect(all[i]!.timestamp).toBeGreaterThanOrEqual(all[i - 1]!.timestamp);
    }
  });

  it('returns an empty array for an empty chat', async () => {
    const all = await getChatMessages('chat-empty');
    expect(all).toEqual([]);
  });
});

describe('messages pagination — getMessage (single fetch)', () => {
  beforeEach(async () => {
    await initMessagesDB();
    await clearAllMessages();
  });

  it('returns the message by ID', async () => {
    await seedChatMessages('chat-1', 10);
    const msg = await getMessage('chat-1-msg-005');
    expect(msg).toBeDefined();
    expect(msg!.id).toBe('chat-1-msg-005');
    expect(msg!.chatId).toBe('chat-1');
  });

  it('returns undefined for a non-existent message ID', async () => {
    await seedChatMessages('chat-1', 10);
    const msg = await getMessage('non-existent');
    expect(msg).toBeUndefined();
  });
});

describe('messages pagination — storeMessage / storeMessages', () => {
  beforeEach(async () => {
    await initMessagesDB();
    await clearAllMessages();
  });

  it('storeMessage inserts a single message that is retrievable', async () => {
    const msg = makeMessage('test-1', 'chat-1', Date.now());
    await storeMessage(msg);
    const fetched = await getMessage('test-1');
    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe('test-1');
    expect(fetched!.content).toBe('Message test-1');
  });

  it('storeMessages batch-inserts multiple messages', async () => {
    const msgs = [
      makeMessage('batch-1', 'chat-1', Date.now()),
      makeMessage('batch-2', 'chat-1', Date.now() + 1),
      makeMessage('batch-3', 'chat-1', Date.now() + 2),
    ];
    await storeMessages(msgs);
    expect(await getMessage('batch-1')).toBeDefined();
    expect(await getMessage('batch-2')).toBeDefined();
    expect(await getMessage('batch-3')).toBeDefined();
  });

  it('storeMessage skips insertion if a message with the same ID already exists (no upsert)', async () => {
    // The implementation logs "Message already exists, skipping" — storeMessage
    // does NOT overwrite existing records. This is by design: a stored message
    // is treated as authoritative once persisted.
    const msg = makeMessage('upsert-1', 'chat-1', Date.now(), { content: 'v1' });
    await storeMessage(msg);
    await storeMessage({ ...msg, content: 'v2' });
    const fetched = await getMessage('upsert-1');
    expect(fetched!.content).toBe('v1'); // original content preserved
  });
});
