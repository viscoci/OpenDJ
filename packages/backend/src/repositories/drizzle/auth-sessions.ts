import type { Claim } from '@opendj/auth';
import type { Database } from '@opendj/db';
import { schema } from '@opendj/db';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { AuthSessionRecord, AuthSessionRepository } from '../types.js';

function mapSession(row: typeof schema.authSessions.$inferSelect): AuthSessionRecord {
  return {
    id: row.id,
    userId: row.userId,
    currentAccountId: row.currentAccountId,
    sessionHash: row.sessionHash,
    claimsSnapshot: row.claimsSnapshot as Claim[],
    ipHash: row.ipHash,
    userAgentHash: row.userAgentHash,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
  };
}

export class DrizzleAuthSessionRepository implements AuthSessionRepository {
  constructor(private readonly db: Database) {}

  async create(input: {
    userId: string;
    currentAccountId: string | null;
    sessionHash: string;
    claimsSnapshot: Claim[];
    ipHash?: string | null;
    userAgentHash?: string | null;
    expiresAt: Date;
  }): Promise<AuthSessionRecord> {
    const rows = await this.db
      .insert(schema.authSessions)
      .values({
        userId: input.userId,
        currentAccountId: input.currentAccountId,
        sessionHash: input.sessionHash,
        claimsSnapshot: input.claimsSnapshot,
        ipHash: input.ipHash ?? null,
        userAgentHash: input.userAgentHash ?? null,
        expiresAt: input.expiresAt,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('Failed to insert auth session.');
    return mapSession(row);
  }

  async findActiveByHash(
    sessionHash: string,
    nowEpochMs: number,
  ): Promise<AuthSessionRecord | null> {
    const rows = await this.db
      .select()
      .from(schema.authSessions)
      .where(
        and(
          eq(schema.authSessions.sessionHash, sessionHash),
          isNull(schema.authSessions.revokedAt),
          gt(schema.authSessions.expiresAt, new Date(nowEpochMs)),
        ),
      )
      .limit(1);
    return rows[0] ? mapSession(rows[0]) : null;
  }

  async touch(id: string, nowEpochMs: number): Promise<void> {
    await this.db
      .update(schema.authSessions)
      .set({ lastSeenAt: new Date(nowEpochMs) })
      .where(eq(schema.authSessions.id, id));
  }

  async revoke(id: string, nowEpochMs: number): Promise<void> {
    await this.db
      .update(schema.authSessions)
      .set({ revokedAt: new Date(nowEpochMs) })
      .where(eq(schema.authSessions.id, id));
  }

  async updateClaimsSnapshot(id: string, claims: Claim[]): Promise<void> {
    await this.db
      .update(schema.authSessions)
      .set({ claimsSnapshot: claims })
      .where(eq(schema.authSessions.id, id));
  }

  async updateCurrentAccount(id: string, accountId: string | null): Promise<void> {
    await this.db
      .update(schema.authSessions)
      .set({ currentAccountId: accountId })
      .where(eq(schema.authSessions.id, id));
  }
}
