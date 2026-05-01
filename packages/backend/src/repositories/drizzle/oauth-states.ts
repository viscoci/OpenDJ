import type { Database } from '@opendj/db';
import { schema } from '@opendj/db';
import { eq, lte } from 'drizzle-orm';
import type { OAuthStateRecord, OAuthStateRepository } from '../types.js';

function mapState(row: typeof schema.oauthStates.$inferSelect): OAuthStateRecord {
  return {
    state: row.state,
    flowKind: row.flowKind as OAuthStateRecord['flowKind'],
    providerId: row.providerId,
    accountId: row.accountId,
    userId: row.userId,
    redirectTo: row.redirectTo,
    codeVerifier: row.codeVerifier,
    nonce: row.nonce,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

export class DrizzleOAuthStateRepository implements OAuthStateRepository {
  constructor(private readonly db: Database) {}

  async create(input: {
    state: string;
    flowKind: 'login' | 'connect-provider';
    providerId: string;
    accountId?: string | null;
    userId?: string | null;
    redirectTo?: string | null;
    codeVerifier?: string | null;
    nonce?: string | null;
    expiresAt: Date;
  }): Promise<OAuthStateRecord> {
    const rows = await this.db
      .insert(schema.oauthStates)
      .values({
        state: input.state,
        flowKind: input.flowKind,
        providerId: input.providerId,
        accountId: input.accountId ?? null,
        userId: input.userId ?? null,
        redirectTo: input.redirectTo ?? null,
        codeVerifier: input.codeVerifier ?? null,
        nonce: input.nonce ?? null,
        expiresAt: input.expiresAt,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('Failed to insert oauth_state.');
    return mapState(row);
  }

  async findActive(state: string, nowEpochMs: number): Promise<OAuthStateRecord | null> {
    const rows = await this.db
      .select()
      .from(schema.oauthStates)
      .where(eq(schema.oauthStates.state, state))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    if (row.expiresAt.getTime() <= nowEpochMs) return null;
    return mapState(row);
  }

  async delete(state: string): Promise<void> {
    await this.db.delete(schema.oauthStates).where(eq(schema.oauthStates.state, state));
  }

  async pruneExpired(nowEpochMs: number): Promise<number> {
    const rows = await this.db
      .delete(schema.oauthStates)
      .where(lte(schema.oauthStates.expiresAt, new Date(nowEpochMs)))
      .returning({ state: schema.oauthStates.state });
    return rows.length;
  }
}
