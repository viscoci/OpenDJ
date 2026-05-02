import type { Database } from '@opendj/db';
import { schema } from '@opendj/db';
import { and, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import type { AbuseSubjectRecord, AbuseSubjectRepository, AbuseSubjectStatus } from '../types.js';

function mapSubject(row: typeof schema.abuseSubjects.$inferSelect): AbuseSubjectRecord {
  return {
    subjectHash: row.subjectHash,
    accountId: row.accountId,
    sessionId: row.sessionId,
    riskScore: row.riskScore,
    status: row.status as AbuseSubjectStatus,
    reason: row.reason,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    expiresAt: row.expiresAt,
  };
}

export class DrizzleAbuseSubjectRepository implements AbuseSubjectRepository {
  constructor(private readonly db: Database) {}

  async findByHash(subjectHash: string): Promise<AbuseSubjectRecord | null> {
    const rows = await this.db
      .select()
      .from(schema.abuseSubjects)
      .where(eq(schema.abuseSubjects.subjectHash, subjectHash))
      .limit(1);
    return rows[0] ? mapSubject(rows[0]) : null;
  }

  async findActiveForSession(
    sessionId: string,
    statuses?: ReadonlyArray<AbuseSubjectStatus>,
  ): Promise<AbuseSubjectRecord[]> {
    const now = new Date();
    const expiryClause = or(
      isNull(schema.abuseSubjects.expiresAt),
      gt(schema.abuseSubjects.expiresAt, now),
    );
    const where =
      statuses && statuses.length > 0
        ? and(
            eq(schema.abuseSubjects.sessionId, sessionId),
            inArray(schema.abuseSubjects.status, [...statuses]),
            expiryClause,
          )
        : and(eq(schema.abuseSubjects.sessionId, sessionId), expiryClause);
    const rows = await this.db.select().from(schema.abuseSubjects).where(where);
    return rows.map(mapSubject);
  }

  async upsert(input: {
    subjectHash: string;
    accountId?: string | null;
    sessionId?: string | null;
    riskScore?: number;
    status: AbuseSubjectStatus;
    reason?: string | null;
    expiresAt?: Date | null;
  }): Promise<AbuseSubjectRecord> {
    const rows = await this.db
      .insert(schema.abuseSubjects)
      .values({
        subjectHash: input.subjectHash,
        accountId: input.accountId ?? null,
        sessionId: input.sessionId ?? null,
        riskScore: input.riskScore !== undefined ? input.riskScore.toFixed(2) : '0.00',
        status: input.status,
        reason: input.reason ?? null,
        expiresAt: input.expiresAt ?? null,
      })
      .onConflictDoUpdate({
        target: schema.abuseSubjects.subjectHash,
        set: {
          accountId: input.accountId ?? null,
          sessionId: input.sessionId ?? null,
          riskScore:
            input.riskScore !== undefined
              ? input.riskScore.toFixed(2)
              : sql`${schema.abuseSubjects.riskScore}`,
          status: input.status,
          reason: input.reason ?? null,
          lastSeenAt: sql`now()`,
          expiresAt: input.expiresAt ?? null,
        },
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('Failed to upsert abuse subject.');
    return mapSubject(row);
  }

  async delete(subjectHash: string): Promise<void> {
    await this.db
      .delete(schema.abuseSubjects)
      .where(eq(schema.abuseSubjects.subjectHash, subjectHash));
  }
}
