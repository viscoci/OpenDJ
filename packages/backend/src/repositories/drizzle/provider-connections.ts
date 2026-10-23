import type { Database } from '@opendj/db';
import { schema } from '@opendj/db';
import { and, eq, sql } from 'drizzle-orm';
import type { ProviderQuotaGroup } from '../../providers/streaming/ProviderCooldowns.js';
import type { ProviderConnectionRecord, ProviderConnectionRepository } from '../types.js';

function mapConnection(
  row: typeof schema.providerConnections.$inferSelect,
): ProviderConnectionRecord {
  return {
    id: row.id,
    accountId: row.accountId,
    connectedByUserId: row.connectedByUserId,
    providerId: row.providerId,
    providerAccountId: row.providerAccountId,
    displayName: row.displayName,
    accessToken: row.accessToken,
    refreshToken: row.refreshToken,
    expiresAt: row.expiresAt,
    scopes: row.scopes,
    tokenType: row.tokenType,
    rateLimitedUntil: row.rateLimitedUntil,
    searchRateLimitedUntil: row.searchRateLimitedUntil,
    rateLimitedClientId: row.rateLimitedClientId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class DrizzleProviderConnectionRepository implements ProviderConnectionRepository {
  constructor(private readonly db: Database) {}

  async findByAccountAndProvider(
    accountId: string,
    providerId: string,
  ): Promise<ProviderConnectionRecord | null> {
    const rows = await this.db
      .select()
      .from(schema.providerConnections)
      .where(
        and(
          eq(schema.providerConnections.accountId, accountId),
          eq(schema.providerConnections.providerId, providerId),
        ),
      )
      .limit(1);
    return rows[0] ? mapConnection(rows[0]) : null;
  }

  async findAllForAccount(accountId: string): Promise<ProviderConnectionRecord[]> {
    const rows = await this.db
      .select()
      .from(schema.providerConnections)
      .where(eq(schema.providerConnections.accountId, accountId));
    return rows.map(mapConnection);
  }

  async upsert(input: {
    accountId: string;
    connectedByUserId?: string | null;
    providerId: string;
    providerAccountId?: string | null;
    displayName?: string | null;
    accessToken: string | null;
    refreshToken?: string | null;
    expiresAt?: Date | null;
    scopes?: string[] | null;
    tokenType?: string | null;
  }): Promise<ProviderConnectionRecord> {
    const rows = await this.db
      .insert(schema.providerConnections)
      .values({
        accountId: input.accountId,
        connectedByUserId: input.connectedByUserId ?? null,
        providerId: input.providerId,
        providerAccountId: input.providerAccountId ?? null,
        displayName: input.displayName ?? null,
        accessToken: input.accessToken,
        refreshToken: input.refreshToken ?? null,
        expiresAt: input.expiresAt ?? null,
        scopes: input.scopes ?? null,
        tokenType: input.tokenType ?? null,
      })
      .onConflictDoUpdate({
        target: [schema.providerConnections.accountId, schema.providerConnections.providerId],
        set: {
          connectedByUserId: input.connectedByUserId ?? null,
          providerAccountId: input.providerAccountId ?? null,
          displayName: input.displayName ?? null,
          accessToken: input.accessToken,
          refreshToken: input.refreshToken ?? null,
          expiresAt: input.expiresAt ?? null,
          scopes: input.scopes ?? null,
          tokenType: input.tokenType ?? null,
          updatedAt: sql`now()`,
        },
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('Failed to upsert provider connection.');
    return mapConnection(row);
  }

  async updateTokens(input: {
    id: string;
    accessToken: string;
    refreshToken?: string | null;
    expiresAt?: Date | null;
    tokenType?: string | null;
  }): Promise<void> {
    const set: Record<string, unknown> = {
      accessToken: input.accessToken,
      updatedAt: sql`now()`,
    };
    if (input.refreshToken !== undefined) set['refreshToken'] = input.refreshToken;
    if (input.expiresAt !== undefined) set['expiresAt'] = input.expiresAt;
    if (input.tokenType !== undefined) set['tokenType'] = input.tokenType;
    await this.db
      .update(schema.providerConnections)
      .set(set)
      .where(eq(schema.providerConnections.id, input.id));
  }

  async extendRateLimitedUntil(input: {
    accountId: string;
    providerId: string;
    group: ProviderQuotaGroup;
    until: Date;
    clientId: string | null;
  }): Promise<boolean> {
    // Update only (never inserts a token-less row); GREATEST so a late,
    // shorter write can't cut a longer deadline. `updated_at` stays put:
    // a cooldown is not a credential change. NULL is ignored by GREATEST.
    // Deadlines recorded under another client id belong to another app's
    // quota: replace them (this group) or drop them (the other group).
    // Every SET expression reads the pre-update row.
    const table = schema.providerConnections;
    const [target, other] =
      input.group === 'search'
        ? ([table.searchRateLimitedUntil, table.rateLimitedUntil] as const)
        : ([table.rateLimitedUntil, table.searchRateLimitedUntil] as const);
    const targetKey = input.group === 'search' ? 'searchRateLimitedUntil' : 'rateLimitedUntil';
    const otherKey = input.group === 'search' ? 'rateLimitedUntil' : 'searchRateLimitedUntil';
    const until = input.until.toISOString();
    const sameClient = sql`${table.rateLimitedClientId} IS NOT DISTINCT FROM ${input.clientId}::text`;
    const rows = await this.db
      .update(table)
      .set({
        [targetKey]: sql`CASE WHEN ${sameClient} THEN GREATEST(${target}, ${until}::timestamptz) ELSE ${until}::timestamptz END`,
        [otherKey]: sql`CASE WHEN ${sameClient} THEN ${other} ELSE NULL END`,
        rateLimitedClientId: input.clientId,
      })
      .where(and(eq(table.accountId, input.accountId), eq(table.providerId, input.providerId)))
      .returning({ id: schema.providerConnections.id });
    return rows.length > 0;
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(schema.providerConnections).where(eq(schema.providerConnections.id, id));
  }
}
