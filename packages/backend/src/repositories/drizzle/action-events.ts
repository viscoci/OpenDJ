import type { Database } from '@opendj/db';
import { schema } from '@opendj/db';
import { and, eq, gte, sql } from 'drizzle-orm';
import type { ActionEventRecord, ActionEventRepository } from '../types.js';

function mapEvent(row: typeof schema.actionEvents.$inferSelect): ActionEventRecord {
  return {
    id: row.id,
    accountId: row.accountId,
    sessionId: row.sessionId,
    userId: row.userId,
    guestId: row.guestId,
    eventKind: row.eventKind,
    subjectHash: row.subjectHash,
    riskScore: row.riskScore,
    meta: row.meta,
    createdAt: row.createdAt,
  };
}

export class DrizzleActionEventRepository implements ActionEventRepository {
  constructor(private readonly db: Database) {}

  async create(input: {
    accountId?: string | null;
    sessionId?: string | null;
    userId?: string | null;
    guestId?: string | null;
    eventKind: string;
    subjectHash?: string | null;
    riskScore?: number | null;
    meta?: unknown;
  }): Promise<ActionEventRecord> {
    const rows = await this.db
      .insert(schema.actionEvents)
      .values({
        accountId: input.accountId ?? null,
        sessionId: input.sessionId ?? null,
        userId: input.userId ?? null,
        guestId: input.guestId ?? null,
        eventKind: input.eventKind,
        subjectHash: input.subjectHash ?? null,
        riskScore:
          input.riskScore !== undefined && input.riskScore !== null
            ? input.riskScore.toFixed(2)
            : null,
        meta: input.meta ?? null,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('Failed to insert action event.');
    return mapEvent(row);
  }

  async countByKindSince(
    sessionId: string,
    since: Date,
  ): Promise<Array<{ eventKind: string; count: number }>> {
    const rows = await this.db
      .select({
        eventKind: schema.actionEvents.eventKind,
        count: sql<number>`count(*)::int`,
      })
      .from(schema.actionEvents)
      .where(
        and(
          eq(schema.actionEvents.sessionId, sessionId),
          gte(schema.actionEvents.createdAt, since),
        ),
      )
      .groupBy(schema.actionEvents.eventKind);
    return rows.map((r) => ({ eventKind: r.eventKind, count: Number(r.count) }));
  }
}
