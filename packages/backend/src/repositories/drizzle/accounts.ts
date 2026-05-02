import type { Database } from '@opendj/db';
import { schema } from '@opendj/db';
import { eq } from 'drizzle-orm';
import type { AccountRecord, AccountRepository } from '../types.js';

function mapAccount(row: typeof schema.accounts.$inferSelect): AccountRecord {
  return {
    id: row.id,
    displayName: row.displayName,
    slug: row.slug,
    plan: row.plan as AccountRecord['plan'],
    createdAt: row.createdAt,
  };
}

export class DrizzleAccountRepository implements AccountRepository {
  constructor(private readonly db: Database) {}

  async findById(id: string): Promise<AccountRecord | null> {
    const rows = await this.db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, id))
      .limit(1);
    return rows[0] ? mapAccount(rows[0]) : null;
  }

  async findBySlug(slug: string): Promise<AccountRecord | null> {
    const rows = await this.db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.slug, slug))
      .limit(1);
    return rows[0] ? mapAccount(rows[0]) : null;
  }

  async create(input: {
    displayName: string;
    slug: string;
    plan?: AccountRecord['plan'];
  }): Promise<AccountRecord> {
    const [row] = await this.db
      .insert(schema.accounts)
      .values({
        displayName: input.displayName,
        slug: input.slug,
        plan: input.plan ?? 'oss',
      })
      .returning();
    if (!row) throw new Error('accounts.create: insert returned no row');
    return mapAccount(row);
  }
}
