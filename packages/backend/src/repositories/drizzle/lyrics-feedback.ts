import type { Database } from '@opendj/db';
import { schema } from '@opendj/db';
import { and, eq } from 'drizzle-orm';
import type { LyricsFeedbackRecord, LyricsFeedbackRepository } from '../types.js';

function mapFeedback(row: typeof schema.lyricsFeedback.$inferSelect): LyricsFeedbackRecord {
  return {
    id: row.id,
    accountId: row.accountId,
    sessionId: row.sessionId,
    userId: row.userId,
    guestId: row.guestId,
    lyricsCacheId: row.lyricsCacheId,
    providerTrackUri: row.providerTrackUri,
    kind: row.kind,
    lineId: row.lineId,
    comment: row.comment,
    createdAt: row.createdAt,
  };
}

export class DrizzleLyricsFeedbackRepository implements LyricsFeedbackRepository {
  constructor(private readonly db: Database) {}

  async create(input: {
    accountId?: string | null;
    sessionId?: string | null;
    userId?: string | null;
    guestId?: string | null;
    lyricsCacheId?: string | null;
    providerTrackUri?: string | null;
    kind: string;
    lineId?: string | null;
    comment?: string | null;
  }): Promise<LyricsFeedbackRecord> {
    const rows = await this.db
      .insert(schema.lyricsFeedback)
      .values({
        accountId: input.accountId ?? null,
        sessionId: input.sessionId ?? null,
        userId: input.userId ?? null,
        guestId: input.guestId ?? null,
        lyricsCacheId: input.lyricsCacheId ?? null,
        providerTrackUri: input.providerTrackUri ?? null,
        kind: input.kind,
        lineId: input.lineId ?? null,
        comment: input.comment ?? null,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('Failed to insert lyrics feedback.');
    return mapFeedback(row);
  }

  async countForCacheEntry(lyricsCacheId: string, kind?: string): Promise<number> {
    const where = kind
      ? and(
          eq(schema.lyricsFeedback.lyricsCacheId, lyricsCacheId),
          eq(schema.lyricsFeedback.kind, kind),
        )
      : eq(schema.lyricsFeedback.lyricsCacheId, lyricsCacheId);
    const rows = await this.db
      .select({ id: schema.lyricsFeedback.id })
      .from(schema.lyricsFeedback)
      .where(where);
    return rows.length;
  }
}
