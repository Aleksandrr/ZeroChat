/**
 * Sync Service - Sesame protocol implementation
 * 
 * Handles vector clock synchronization between devices
 * according to the Sesame protocol specification.
 * 
 * @see docs/signal/sesame.md - Sesame protocol specification
 */

import { prisma } from '../prisma/client';

// ==================== Types ====================

export interface VectorClock {
  [deviceId: string]: number;
}

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
  serverReceivedAt: Date;
}

/**
 * Incoming sync event from client (for push)
 */
export interface IncomingSyncEvent {
  event_id: string;      // UUID
  entity: string;        // 'chat' | 'message' | 'settings' | 'device'
  entity_id: string;     // ID of the entity
  op: string;            // 'upsert' | 'delete' | 'tombstone'
  version: number;       // Version for conflict resolution
  payload: string;       // Base64 encrypted payload
  device_id: string;     // Sender device ID
  seq: number;           // Sequence number (vector clock)
}

export interface SyncRequest {
  vectorClock: VectorClock;
  events?: IncomingSyncEvent[];
}

export interface SyncResponse {
  vectorClock: VectorClock;
  events: SyncEvent[];
}

/**
 * Result of push operation
 */
export interface PushResult {
  accepted: string[];      // Accepted event_ids
  rejected: Array<{
    event_id: string;
    reason: string;
  }>;
}

/**
 * Result of pull operation
 */
export interface PullResult {
  events: SyncEvent[];
  serverVectorClock: VectorClock;
}

// ==================== Constants ====================

const MAX_EVENTS_PER_SYNC = 100;
const MAX_EVENTS_PER_PUSH = 50;
const SYNC_EVENT_RETENTION_DAYS = 30;

// ==================== Service ====================

/**
 * Get current vector clock for user
 * Returns the highest seq for each device
 */
export async function getVectorClock(userId: string): Promise<VectorClock> {
  const events = await prisma.syncEvent.groupBy({
    by: ['deviceId'],
    where: {
      userId,
    },
    _max: {
      seq: true,
    },
  });

  const vectorClock: VectorClock = {};
  events.forEach(event => {
    if (event._max.seq !== null) {
      vectorClock[event.deviceId] = event._max.seq;
    }
  });

  return vectorClock;
}

/**
 * Push sync events from a device
 * 
 * Validates each event and stores in database.
 * Returns list of accepted and rejected events.
 * 
 * @param userId - User ID from JWT
 * @param deviceId - Device ID from JWT (must match event device_id)
 * @param events - Array of incoming sync events
 */
export async function pushEvents(
  userId: string,
  deviceId: string,
  events: IncomingSyncEvent[]
): Promise<PushResult> {
  const accepted: string[] = [];
  const rejected: Array<{ event_id: string; reason: string }> = [];

  // Limit events per push
  if (events.length > MAX_EVENTS_PER_PUSH) {
    return {
      accepted: [],
      rejected: events.map(e => ({
        event_id: e.event_id,
        reason: `Too many events in single push (max ${MAX_EVENTS_PER_PUSH})`,
      })),
    };
  }

  // Get current max seq for device
  const maxSeqResult = await prisma.syncEvent.aggregate({
    where: {
      userId,
      deviceId,
    },
    _max: {
      seq: true,
    },
  });
  const currentMaxSeq = maxSeqResult._max.seq || 0;

  // Process each event
  for (const event of events) {
    try {
      // Validate device_id matches JWT
      if (event.device_id !== deviceId) {
        rejected.push({
          event_id: event.event_id,
          reason: 'Device ID mismatch - event device_id must match authenticated device',
        });
        continue;
      }

      // Validate operation
      const validOps = ['upsert', 'delete', 'tombstone'];
      if (!validOps.includes(event.op)) {
        rejected.push({
          event_id: event.event_id,
          reason: `Invalid operation '${event.op}'. Must be one of: ${validOps.join(', ')}`,
        });
        continue;
      }

      // Validate seq is greater than current max
      if (event.seq <= currentMaxSeq && currentMaxSeq > 0) {
        rejected.push({
          event_id: event.event_id,
          reason: `Invalid sequence number ${event.seq}. Must be greater than current max ${currentMaxSeq}`,
        });
        continue;
      }

      // Check for duplicate event_id
      const existingEvent = await prisma.syncEvent.findFirst({
        where: {
          userId,
          id: event.event_id,
        },
      });

      if (existingEvent) {
        rejected.push({
          event_id: event.event_id,
          reason: 'Event with this ID already exists',
        });
        continue;
      }

      // Store the event
      await prisma.syncEvent.create({
        data: {
          id: event.event_id,
          userId,
          deviceId,
          seq: event.seq,
          entity: event.entity,
          entityId: event.entity_id,
          op: event.op,
          version: event.version,
          payloadCiphertext: event.payload,
        },
      });

      accepted.push(event.event_id);
    } catch (error) {
      rejected.push({
        event_id: event.event_id,
        reason: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  return { accepted, rejected };
}

/**
 * Pull sync events for a device based on vector clock
 * 
 * Returns all events from other devices that the requesting device
 * hasn't seen yet (based on vector clock comparison).
 * 
 * @param userId - User ID from JWT
 * @param deviceId - Device ID from JWT (exclude own events)
 * @param vectorClock - Client's current vector clock
 */
export async function pullEvents(
  userId: string,
  deviceId: string,
  vectorClock: VectorClock
): Promise<PullResult> {
  // Build query to find events not yet seen by client
  // Events from other devices where seq > client's known seq for that device
  
  // Get all events for user, excluding current device
  const allDeviceEvents = await prisma.syncEvent.findMany({
    where: {
      userId,
      NOT: {
        deviceId, // Exclude events from current device
      },
    },
    orderBy: [
      { deviceId: 'asc' },
      { seq: 'asc' },
    ],
  });

  // Filter events based on vector clock
  // An event should be included if:
  // - Its device is not in the vector clock (new device to client)
  // - Its seq is greater than the vector clock entry for its device
  const filteredEvents = allDeviceEvents.filter(event => {
    const clientSeq = vectorClock[event.deviceId];
    // If device not in vector clock or seq > client's known seq
    return clientSeq === undefined || event.seq > clientSeq;
  });

  // Sort by server received time for consistent ordering
  const sortedEvents = filteredEvents
    .sort((a, b) => a.serverReceivedAt.getTime() - b.serverReceivedAt.getTime())
    .slice(0, MAX_EVENTS_PER_SYNC);

  // Get updated server vector clock
  const serverVectorClock = await getVectorClock(userId);

  return {
    events: sortedEvents.map(event => ({
      ...event,
      op: event.op as 'upsert' | 'delete' | 'tombstone',
    })),
    serverVectorClock,
  };
}

/**
 * Perform a full sync (push + pull)
 * 
 * @deprecated Use pushEvents and pullEvents separately for better control
 */
export async function sync(userId: string, deviceId: string, request: SyncRequest): Promise<SyncResponse> {
  // Push events if provided
  if (request.events && request.events.length > 0) {
    await pushEvents(userId, deviceId, request.events);
  }

  // Pull events
  const pullResult = await pullEvents(userId, deviceId, request.vectorClock);

  return {
    vectorClock: pullResult.serverVectorClock,
    events: pullResult.events,
  };
}

/**
 * Clean old sync events (retention policy)
 * 
 * Removes events older than specified days.
 * Should be called periodically (e.g., via cron job).
 * 
 * @param userId - User ID (optional, if not provided cleans for all users)
 * @param maxAgeDays - Maximum age in days (default: 30)
 */
export async function cleanOldEvents(
  userId?: string,
  maxAgeDays: number = SYNC_EVENT_RETENTION_DAYS
): Promise<number> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - maxAgeDays);

  const whereClause = userId
    ? { userId, serverReceivedAt: { lt: cutoffDate } }
    : { serverReceivedAt: { lt: cutoffDate } };

  const result = await prisma.syncEvent.deleteMany({
    where: whereClause,
  });

  return result.count;
}

/**
 * Create a system sync event
 * 
 * Used for server-initiated sync events (e.g., device removal notifications)
 * 
 * Uses atomic transaction with retry on unique constraint violation to prevent
 * race conditions when multiple events are created simultaneously for the same device.
 */
export async function createSystemEvent(
  userId: string,
  deviceId: string,
  entity: string,
  entityId: string,
  op: 'upsert' | 'delete' | 'tombstone',
  payloadCiphertext: string
): Promise<SyncEvent> {
  // Retry loop for handling race conditions
  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Use transaction to ensure atomic seq generation
      const event = await prisma.$transaction(async (tx) => {
        // Lock the row for this device to prevent concurrent inserts
        // Using raw query with FOR UPDATE to acquire advisory lock
        const maxSeqResult = await tx.$queryRaw<Array<{ max_seq: bigint | null }>>`
          SELECT MAX(seq) as max_seq 
          FROM "sync_events" 
          WHERE "deviceId" = ${deviceId}
          FOR UPDATE
        `;
        
        const nextSeq = (Number(maxSeqResult[0]?.max_seq) || 0) + 1;

        return tx.syncEvent.create({
          data: {
            id: crypto.randomUUID(),
            userId,
            deviceId,
            seq: nextSeq,
            entity,
            entityId,
            op,
            version: 0,
            payloadCiphertext,
          },
        });
      });

      return {
        ...event,
        op: event.op as 'upsert' | 'delete' | 'tombstone',
      };
    } catch (error: any) {
      // P2002 is Prisma's unique constraint violation error
      // This can happen if another transaction inserted with the same seq
      if (error.code === 'P2002' && attempt < maxRetries - 1) {
        console.warn(`[Sync] Seq collision for device ${deviceId}, retrying (attempt ${attempt + 1})`);
        // Small delay before retry to reduce collision probability
        await new Promise(resolve => setTimeout(resolve, 10 * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }
  
  throw new Error('Failed to create sync event after max retries');
}

/**
 * Get sync statistics for a user
 */
export async function getSyncStats(userId: string): Promise<{
  totalEvents: number;
  devices: Array<{
    deviceId: string;
    eventCount: number;
    lastEventAt: Date | null;
  }>;
  oldestEventAt: Date | null;
}> {
  const totalEvents = await prisma.syncEvent.count({
    where: { userId },
  });

  const deviceStats = await prisma.syncEvent.groupBy({
    by: ['deviceId'],
    where: { userId },
    _count: { id: true },
    _max: { serverReceivedAt: true },
  });

  const oldestEvent = await prisma.syncEvent.findFirst({
    where: { userId },
    orderBy: { serverReceivedAt: 'asc' },
    select: { serverReceivedAt: true },
  });

  return {
    totalEvents,
    devices: deviceStats.map(stat => ({
      deviceId: stat.deviceId,
      eventCount: stat._count.id,
      lastEventAt: stat._max.serverReceivedAt,
    })),
    oldestEventAt: oldestEvent?.serverReceivedAt || null,
  };
}
