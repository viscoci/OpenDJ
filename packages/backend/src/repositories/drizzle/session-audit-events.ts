import type { Database } from '@opendj/db';
import { schema } from '@opendj/db';
import { and, desc, eq, lt } from 'drizzle-orm';
import type { SessionAuditEventRecord, SessionAuditEventRepository } from '../types.js';

function rowToRecord(row: typeof schema.sessionAuditEvents.$inferSelect): SessionAuditEventRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    actorKind: row.actorKind as 'host' | 'guest' | 'system',
    actorId: row.actorId,
    actorLabel: row.actorLabel,
    action: row.action,
    details: (row.details ?? {}) as Record<string, unknown>,
    createdAt: row.createdAt,
  };
}

export class DrizzleSessionAuditEventRepository implements SessionAuditEventRepository {
  constructor(private readonly db: Database) {}

  async record(input: {
    sessionId: string;
    actorKind: 'host' | 'guest' | 'system';
    actorId?: string | null;
    actorLabel?: string | null;
    action: string;
    details?: Record<string, unknown>;
  }): Promise<SessionAuditEventRecord> {
    const [row] = await this.db
      .insert(schema.sessionAuditEvents)
      .values({
        sessionId: input.sessionId,
        actorKind: input.actorKind,
        actorId: input.actorId ?? null,
        actorLabel: input.actorLabel ?? null,
        action: input.action,
        details: input.details ?? {},
      })
      .returning();
    if (!row) throw new Error('insert audit event returned no row');
    return rowToRecord(row);
  }

  async listForSession(
    sessionId: string,
    options?: { limit?: number; before?: Date },
  ): Promise<SessionAuditEventRecord[]> {
    const limit = options?.limit ?? 200;
    const where = options?.before
      ? and(
          eq(schema.sessionAuditEvents.sessionId, sessionId),
          lt(schema.sessionAuditEvents.createdAt, options.before),
        )
      : eq(schema.sessionAuditEvents.sessionId, sessionId);
    const rows = await this.db
      .select()
      .from(schema.sessionAuditEvents)
      .where(where)
      .orderBy(desc(schema.sessionAuditEvents.createdAt))
      .limit(limit);
    return rows.map(rowToRecord);
  }
}
