import type { Claim } from '@opendj/auth';
import type { Database } from '@opendj/db';
import { schema } from '@opendj/db';
import { and, eq } from 'drizzle-orm';
import type { MembershipRecord, MembershipRepository } from '../types.js';

function mapMembership(row: typeof schema.accountMemberships.$inferSelect): MembershipRecord {
  return {
    accountId: row.accountId,
    userId: row.userId,
    status: row.status as MembershipRecord['status'],
    role: row.role as MembershipRecord['role'],
    claims: row.claims as Claim[],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class DrizzleMembershipRepository implements MembershipRepository {
  constructor(private readonly db: Database) {}

  async find(accountId: string, userId: string): Promise<MembershipRecord | null> {
    const rows = await this.db
      .select()
      .from(schema.accountMemberships)
      .where(
        and(
          eq(schema.accountMemberships.accountId, accountId),
          eq(schema.accountMemberships.userId, userId),
        ),
      )
      .limit(1);
    return rows[0] ? mapMembership(rows[0]) : null;
  }

  async findAllForUser(userId: string): Promise<MembershipRecord[]> {
    const rows = await this.db
      .select()
      .from(schema.accountMemberships)
      .where(eq(schema.accountMemberships.userId, userId));
    return rows.map(mapMembership);
  }
}
