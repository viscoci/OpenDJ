import type { Database } from '@opendj/db';
import { schema } from '@opendj/db';
import { eq, sql } from 'drizzle-orm';
import type { UserRecord, UserRepository } from '../types.js';

function mapUser(row: typeof schema.users.$inferSelect): UserRecord {
  return {
    id: row.id,
    publicUserId: row.publicUserId,
    displayName: row.displayName,
    primaryEmail: row.primaryEmail,
    emailVerified: row.emailVerified,
    avatarUrl: row.avatarUrl,
    status: row.status as UserRecord['status'],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class DrizzleUserRepository implements UserRepository {
  constructor(private readonly db: Database) {}

  async findById(id: string): Promise<UserRecord | null> {
    const rows = await this.db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1);
    return rows[0] ? mapUser(rows[0]) : null;
  }

  async findByPrimaryEmail(email: string): Promise<UserRecord | null> {
    const rows = await this.db
      .select()
      .from(schema.users)
      .where(sql`lower(${schema.users.primaryEmail}) = lower(${email})`)
      .limit(1);
    return rows[0] ? mapUser(rows[0]) : null;
  }

  async create(input: {
    primaryEmail?: string | null;
    displayName?: string | null;
    avatarUrl?: string | null;
    emailVerified?: boolean;
  }): Promise<UserRecord> {
    const rows = await this.db
      .insert(schema.users)
      .values({
        primaryEmail: input.primaryEmail ?? null,
        displayName: input.displayName ?? null,
        avatarUrl: input.avatarUrl ?? null,
        emailVerified: input.emailVerified ?? false,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('Failed to insert user.');
    return mapUser(row);
  }

  async setEmailVerified(userId: string): Promise<void> {
    await this.db
      .update(schema.users)
      .set({ emailVerified: true, updatedAt: new Date() })
      .where(eq(schema.users.id, userId));
  }
}
