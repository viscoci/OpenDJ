import type { Database } from '@opendj/db';
import { schema } from '@opendj/db';
import { and, eq, sql } from 'drizzle-orm';
import type { QueueSkipVoteRepository } from '../types.js';

/**
 * Drizzle-backed skip-vote ledger. The unique (queue_item_id, guest_id)
 * primary key gives us "one vote per guest per item" for free; we use
 * `ON CONFLICT DO NOTHING` to detect duplicates without throwing, and
 * combine the insert with the queue_items.skip_votes increment so the
 * read-side counter stays consistent.
 *
 * NOTE: this is two statements, not one transaction — for the OSS demo
 * the race window is tiny (one INSERT then one UPDATE) and the counter is
 * idempotent under retries since the dedupe is enforced by the PK. A
 * production hosted deploy would wrap both in a single tx.
 */
export class DrizzleQueueSkipVoteRepository implements QueueSkipVoteRepository {
  constructor(private readonly db: Database) {}

  async recordVote(input: {
    queueItemId: string;
    guestId: string;
  }): Promise<{ inserted: boolean; voteCount: number }> {
    const inserted = await this.db
      .insert(schema.queueSkipVotes)
      .values({ queueItemId: input.queueItemId, guestId: input.guestId })
      .onConflictDoNothing()
      .returning();
    const wasInserted = inserted.length > 0;

    if (!wasInserted) {
      // Read current count; guest already voted, no increment.
      const rows = await this.db
        .select({ skipVotes: schema.queueItems.skipVotes })
        .from(schema.queueItems)
        .where(eq(schema.queueItems.id, input.queueItemId))
        .limit(1);
      return { inserted: false, voteCount: rows[0]?.skipVotes ?? 0 };
    }

    const updated = await this.db
      .update(schema.queueItems)
      .set({ skipVotes: sql`${schema.queueItems.skipVotes} + 1` })
      .where(eq(schema.queueItems.id, input.queueItemId))
      .returning({ skipVotes: schema.queueItems.skipVotes });
    return { inserted: true, voteCount: updated[0]?.skipVotes ?? 0 };
  }

  async hasVoted(input: { queueItemId: string; guestId: string }): Promise<boolean> {
    const rows = await this.db
      .select({ queueItemId: schema.queueSkipVotes.queueItemId })
      .from(schema.queueSkipVotes)
      .where(
        and(
          eq(schema.queueSkipVotes.queueItemId, input.queueItemId),
          eq(schema.queueSkipVotes.guestId, input.guestId),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }
}
