import type { Database } from '@opendj/db';
import { schema } from '@opendj/db';
import { eq } from 'drizzle-orm';
import { lte, or, isNotNull } from 'drizzle-orm';
import type { EmailVerificationTokenRecord, EmailVerificationTokenRepository } from '../types.js';

function mapRow(
  row: typeof schema.emailVerificationTokens.$inferSelect,
): EmailVerificationTokenRecord {
  return {
    tokenHash: row.tokenHash,
    userId: row.userId,
    email: row.email,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
  };
}

export class DrizzleEmailVerificationTokenRepository implements EmailVerificationTokenRepository {
  constructor(private readonly db: Database) {}

  async create(input: {
    tokenHash: string;
    userId: string;
    email: string;
    expiresAt: Date;
  }): Promise<EmailVerificationTokenRecord> {
    const [row] = await this.db
      .insert(schema.emailVerificationTokens)
      .values({
        tokenHash: input.tokenHash,
        userId: input.userId,
        email: input.email,
        expiresAt: input.expiresAt,
      })
      .returning();
    if (!row) throw new Error('emailVerificationTokens.create: insert returned no row');
    return mapRow(row);
  }

  async findActiveByHash(
    tokenHash: string,
    nowEpochMs: number,
  ): Promise<EmailVerificationTokenRecord | null> {
    const rows = await this.db
      .select()
      .from(schema.emailVerificationTokens)
      .where(eq(schema.emailVerificationTokens.tokenHash, tokenHash))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    if (row.consumedAt) return null;
    if (row.expiresAt.getTime() <= nowEpochMs) return null;
    return mapRow(row);
  }

  async consume(tokenHash: string, nowEpochMs: number): Promise<void> {
    await this.db
      .update(schema.emailVerificationTokens)
      .set({ consumedAt: new Date(nowEpochMs) })
      .where(eq(schema.emailVerificationTokens.tokenHash, tokenHash));
  }

  async pruneExpired(nowEpochMs: number): Promise<number> {
    const result = await this.db
      .delete(schema.emailVerificationTokens)
      .where(
        or(
          lte(schema.emailVerificationTokens.expiresAt, new Date(nowEpochMs)),
          isNotNull(schema.emailVerificationTokens.consumedAt),
        ),
      )
      .returning({ tokenHash: schema.emailVerificationTokens.tokenHash });
    return result.length;
  }
}
