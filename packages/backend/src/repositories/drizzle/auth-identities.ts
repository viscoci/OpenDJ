import type { Database } from '@opendj/db';
import { schema } from '@opendj/db';
import { and, eq } from 'drizzle-orm';
import type { AuthIdentityRecord, AuthIdentityRepository } from '../types.js';

function mapIdentity(row: typeof schema.authIdentities.$inferSelect): AuthIdentityRecord {
  return {
    id: row.id,
    userId: row.userId,
    providerId: row.providerId,
    providerSubject: row.providerSubject,
    email: row.email,
    emailVerified: row.emailVerified,
    rawProfile: row.rawProfile,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class DrizzleAuthIdentityRepository implements AuthIdentityRepository {
  constructor(private readonly db: Database) {}

  async findByProvider(
    providerId: string,
    providerSubject: string,
  ): Promise<AuthIdentityRecord | null> {
    const rows = await this.db
      .select()
      .from(schema.authIdentities)
      .where(
        and(
          eq(schema.authIdentities.providerId, providerId),
          eq(schema.authIdentities.providerSubject, providerSubject),
        ),
      )
      .limit(1);
    return rows[0] ? mapIdentity(rows[0]) : null;
  }

  async create(input: {
    userId: string;
    providerId: string;
    providerSubject: string;
    email?: string | null;
    emailVerified?: boolean;
    rawProfile?: unknown;
  }): Promise<AuthIdentityRecord> {
    const rows = await this.db
      .insert(schema.authIdentities)
      .values({
        userId: input.userId,
        providerId: input.providerId,
        providerSubject: input.providerSubject,
        email: input.email ?? null,
        emailVerified: input.emailVerified ?? false,
        rawProfile: input.rawProfile ?? null,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('Failed to insert auth identity.');
    return mapIdentity(row);
  }
}
