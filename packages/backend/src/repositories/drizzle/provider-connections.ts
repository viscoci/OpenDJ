import type { Database } from '@opendj/db';
import { schema } from '@opendj/db';
import { and, eq, sql } from 'drizzle-orm';
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

  async delete(id: string): Promise<void> {
    await this.db.delete(schema.providerConnections).where(eq(schema.providerConnections.id, id));
  }
}
