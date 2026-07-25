import type { Database } from '@opendj/db';
import { schema } from '@opendj/db';
import { and, asc, eq } from 'drizzle-orm';
import type { KaraokeClaimRecord, KaraokeClaimRepository } from '../types.js';

function mapClaim(row: typeof schema.karaokeClaims.$inferSelect): KaraokeClaimRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    queueItemId: row.queueItemId,
    guestId: row.guestId,
    displayName: row.displayName,
    createdAt: row.createdAt,
  };
}

/**
 * Drizzle-backed karaoke mic claims. The unique `(queue_item_id, guest_id)`
 * constraint backs "one mic per guest per song" — services run `canClaimMic`
 * before inserting, so a constraint violation here is a lost race and
 * surfaces as a thrown error the route maps like any other claim failure.
 */
export class DrizzleKaraokeClaimRepository implements KaraokeClaimRepository {
  constructor(private readonly db: Database) {}

  async findAllForItem(queueItemId: string): Promise<KaraokeClaimRecord[]> {
    const rows = await this.db
      .select()
      .from(schema.karaokeClaims)
      .where(eq(schema.karaokeClaims.queueItemId, queueItemId))
      .orderBy(asc(schema.karaokeClaims.createdAt));
    return rows.map(mapClaim);
  }

  async findAllForSession(sessionId: string): Promise<KaraokeClaimRecord[]> {
    const rows = await this.db
      .select()
      .from(schema.karaokeClaims)
      .where(eq(schema.karaokeClaims.sessionId, sessionId))
      .orderBy(asc(schema.karaokeClaims.createdAt));
    return rows.map(mapClaim);
  }

  async findByItemAndGuest(
    queueItemId: string,
    guestId: string,
  ): Promise<KaraokeClaimRecord | null> {
    const rows = await this.db
      .select()
      .from(schema.karaokeClaims)
      .where(
        and(
          eq(schema.karaokeClaims.queueItemId, queueItemId),
          eq(schema.karaokeClaims.guestId, guestId),
        ),
      )
      .limit(1);
    return rows[0] ? mapClaim(rows[0]) : null;
  }

  async create(input: {
    sessionId: string;
    queueItemId: string;
    guestId: string;
    displayName: string;
  }): Promise<KaraokeClaimRecord> {
    const rows = await this.db
      .insert(schema.karaokeClaims)
      .values({
        sessionId: input.sessionId,
        queueItemId: input.queueItemId,
        guestId: input.guestId,
        displayName: input.displayName,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('Failed to insert karaoke claim.');
    return mapClaim(row);
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(schema.karaokeClaims).where(eq(schema.karaokeClaims.id, id));
  }
}
