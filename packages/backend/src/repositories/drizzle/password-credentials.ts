import type { Database } from '@opendj/db';
import { schema } from '@opendj/db';
import { eq, sql } from 'drizzle-orm';
import type { PasswordCredentialRecord, PasswordCredentialRepository } from '../types.js';

function mapCredential(
  row: typeof schema.passwordCredentials.$inferSelect,
): PasswordCredentialRecord {
  return {
    userId: row.userId,
    passwordHash: row.passwordHash,
    hashAlgorithm: row.hashAlgorithm,
    passwordUpdatedAt: row.passwordUpdatedAt,
    failedAttempts: row.failedAttempts,
    lockedUntil: row.lockedUntil,
  };
}

export class DrizzlePasswordCredentialRepository implements PasswordCredentialRepository {
  constructor(private readonly db: Database) {}

  async findByUser(userId: string): Promise<PasswordCredentialRecord | null> {
    const rows = await this.db
      .select()
      .from(schema.passwordCredentials)
      .where(eq(schema.passwordCredentials.userId, userId))
      .limit(1);
    return rows[0] ? mapCredential(rows[0]) : null;
  }

  async upsert(input: {
    userId: string;
    passwordHash: string;
    hashAlgorithm: string;
  }): Promise<PasswordCredentialRecord> {
    const rows = await this.db
      .insert(schema.passwordCredentials)
      .values({
        userId: input.userId,
        passwordHash: input.passwordHash,
        hashAlgorithm: input.hashAlgorithm,
      })
      .onConflictDoUpdate({
        target: schema.passwordCredentials.userId,
        set: {
          passwordHash: input.passwordHash,
          hashAlgorithm: input.hashAlgorithm,
          passwordUpdatedAt: sql`now()`,
          failedAttempts: 0,
          lockedUntil: null,
        },
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('Failed to upsert password credential.');
    return mapCredential(row);
  }

  async recordFailedAttempt(userId: string, lockUntil: Date | null): Promise<void> {
    await this.db
      .update(schema.passwordCredentials)
      .set({
        failedAttempts: sql`${schema.passwordCredentials.failedAttempts} + 1`,
        lockedUntil: lockUntil,
      })
      .where(eq(schema.passwordCredentials.userId, userId));
  }

  async resetFailedAttempts(userId: string): Promise<void> {
    await this.db
      .update(schema.passwordCredentials)
      .set({ failedAttempts: 0, lockedUntil: null })
      .where(eq(schema.passwordCredentials.userId, userId));
  }
}
