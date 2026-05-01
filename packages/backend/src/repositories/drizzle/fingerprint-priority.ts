import type { Database } from '@opendj/db';
import { schema } from '@opendj/db';
import { and, eq, gt, sql } from 'drizzle-orm';
import type { FingerprintPriorityRecord, FingerprintPriorityRepository } from '../types.js';

function mapPriority(
  row: typeof schema.fingerprintPriority.$inferSelect,
): FingerprintPriorityRecord {
  return {
    fingerprintHash: row.fingerprintHash,
    sessionId: row.sessionId,
    releasedAt: row.releasedAt,
    expiresAt: row.expiresAt,
  };
}

export class DrizzleFingerprintPriorityRepository implements FingerprintPriorityRepository {
  constructor(private readonly db: Database) {}

  async find(
    sessionId: string,
    fingerprintHash: string,
    nowEpochMs: number,
  ): Promise<FingerprintPriorityRecord | null> {
    const rows = await this.db
      .select()
      .from(schema.fingerprintPriority)
      .where(
        and(
          eq(schema.fingerprintPriority.sessionId, sessionId),
          eq(schema.fingerprintPriority.fingerprintHash, fingerprintHash),
          gt(schema.fingerprintPriority.expiresAt, new Date(nowEpochMs)),
        ),
      )
      .limit(1);
    return rows[0] ? mapPriority(rows[0]) : null;
  }

  async upsert(input: {
    sessionId: string;
    fingerprintHash: string;
    expiresAt: Date;
  }): Promise<FingerprintPriorityRecord> {
    const rows = await this.db
      .insert(schema.fingerprintPriority)
      .values({
        sessionId: input.sessionId,
        fingerprintHash: input.fingerprintHash,
        expiresAt: input.expiresAt,
      })
      .onConflictDoUpdate({
        target: [schema.fingerprintPriority.fingerprintHash, schema.fingerprintPriority.sessionId],
        set: {
          releasedAt: sql`now()`,
          expiresAt: input.expiresAt,
        },
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('Failed to upsert fingerprint priority.');
    return mapPriority(row);
  }

  async delete(sessionId: string, fingerprintHash: string): Promise<void> {
    await this.db
      .delete(schema.fingerprintPriority)
      .where(
        and(
          eq(schema.fingerprintPriority.sessionId, sessionId),
          eq(schema.fingerprintPriority.fingerprintHash, fingerprintHash),
        ),
      );
  }
}
