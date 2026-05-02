import type { Database } from '@opendj/db';
import { schema } from '@opendj/db';
import { eq, isNotNull, lte, or } from 'drizzle-orm';
import type { PasswordResetTokenRecord, PasswordResetTokenRepository } from '../types.js';

function mapRow(row: typeof schema.passwordResetTokens.$inferSelect): PasswordResetTokenRecord {
  return {
    tokenHash: row.tokenHash,
    userId: row.userId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
    requestedFromIpHash: row.requestedFromIpHash,
  };
}

export class DrizzlePasswordResetTokenRepository implements PasswordResetTokenRepository {
  constructor(private readonly db: Database) {}

  async create(input: {
    tokenHash: string;
    userId: string;
    expiresAt: Date;
    requestedFromIpHash?: string | null;
  }): Promise<PasswordResetTokenRecord> {
    const [row] = await this.db
      .insert(schema.passwordResetTokens)
      .values({
        tokenHash: input.tokenHash,
        userId: input.userId,
        expiresAt: input.expiresAt,
        requestedFromIpHash: input.requestedFromIpHash ?? null,
      })
      .returning();
    if (!row) throw new Error('passwordResetTokens.create: insert returned no row');
    return mapRow(row);
  }

  async findActiveByHash(
    tokenHash: string,
    nowEpochMs: number,
  ): Promise<PasswordResetTokenRecord | null> {
    const rows = await this.db
      .select()
      .from(schema.passwordResetTokens)
      .where(eq(schema.passwordResetTokens.tokenHash, tokenHash))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    if (row.consumedAt) return null;
    if (row.expiresAt.getTime() <= nowEpochMs) return null;
    return mapRow(row);
  }

  async consume(tokenHash: string, nowEpochMs: number): Promise<void> {
    await this.db
      .update(schema.passwordResetTokens)
      .set({ consumedAt: new Date(nowEpochMs) })
      .where(eq(schema.passwordResetTokens.tokenHash, tokenHash));
  }

  async pruneExpired(nowEpochMs: number): Promise<number> {
    const result = await this.db
      .delete(schema.passwordResetTokens)
      .where(
        or(
          lte(schema.passwordResetTokens.expiresAt, new Date(nowEpochMs)),
          isNotNull(schema.passwordResetTokens.consumedAt),
        ),
      )
      .returning({ tokenHash: schema.passwordResetTokens.tokenHash });
    return result.length;
  }
}
