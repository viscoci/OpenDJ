import type { Database } from '@opendj/db';
import { schema } from '@opendj/db';
import { asc, eq, sql } from 'drizzle-orm';
import type { QueueItemRecord, QueueItemRepository, QueueItemStatus } from '../types.js';

function mapItem(row: typeof schema.queueItems.$inferSelect): QueueItemRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    guestId: row.guestId,
    trackUri: row.trackUri,
    trackName: row.trackName,
    artistName: row.artistName,
    albumArtUrl: row.albumArtUrl,
    durationMs: row.durationMs,
    status: row.status as QueueItemStatus,
    skipVotes: row.skipVotes,
    createdAt: row.createdAt,
    decidedAt: row.decidedAt,
  };
}

export class DrizzleQueueItemRepository implements QueueItemRepository {
  constructor(private readonly db: Database) {}

  async findById(id: string): Promise<QueueItemRecord | null> {
    const rows = await this.db
      .select()
      .from(schema.queueItems)
      .where(eq(schema.queueItems.id, id))
      .limit(1);
    return rows[0] ? mapItem(rows[0]) : null;
  }

  async findAllForSession(sessionId: string): Promise<QueueItemRecord[]> {
    const rows = await this.db
      .select()
      .from(schema.queueItems)
      .where(eq(schema.queueItems.sessionId, sessionId))
      .orderBy(asc(schema.queueItems.createdAt));
    return rows.map(mapItem);
  }

  async create(input: {
    sessionId: string;
    guestId: string;
    trackUri: string;
    trackName: string;
    artistName: string;
    albumArtUrl?: string | null;
    durationMs?: number | null;
    status?: QueueItemStatus;
  }): Promise<QueueItemRecord> {
    const rows = await this.db
      .insert(schema.queueItems)
      .values({
        sessionId: input.sessionId,
        guestId: input.guestId,
        trackUri: input.trackUri,
        trackName: input.trackName,
        artistName: input.artistName,
        albumArtUrl: input.albumArtUrl ?? null,
        durationMs: input.durationMs ?? null,
        status: input.status ?? 'pending',
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('Failed to insert queue item.');
    return mapItem(row);
  }

  async setStatus(input: {
    id: string;
    status: QueueItemStatus;
    decidedAt?: Date | null;
  }): Promise<QueueItemRecord | null> {
    const set: Record<string, unknown> = { status: input.status };
    if (input.decidedAt !== undefined) set['decidedAt'] = input.decidedAt;
    const rows = await this.db
      .update(schema.queueItems)
      .set(set)
      .where(eq(schema.queueItems.id, input.id))
      .returning();
    return rows[0] ? mapItem(rows[0]) : null;
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(schema.queueItems).where(eq(schema.queueItems.id, id));
  }

  async incrementSkipVotes(id: string): Promise<number> {
    const rows = await this.db
      .update(schema.queueItems)
      .set({ skipVotes: sql`${schema.queueItems.skipVotes} + 1` })
      .where(eq(schema.queueItems.id, id))
      .returning({ skipVotes: schema.queueItems.skipVotes });
    return rows[0]?.skipVotes ?? 0;
  }
}
