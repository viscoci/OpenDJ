import { sql } from 'drizzle-orm';
import { index, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users.js';

/**
 * Host account / tenant. OSS deployments have exactly one row with `plan: 'oss'`.
 *
 * Plan values mirror @opendj/core's `Plan` type:
 *   'free' | 'paid_monthly' | 'paid_event' | 'oss'
 */
export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  displayName: text('display_name').notNull(),
  /** Hosted: /u/<slug> guest URL. Globally unique. */
  slug: text('slug').notNull().unique(),
  plan: text('plan').notNull().default('free'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type AccountRow = typeof accounts.$inferSelect;
export type AccountInsert = typeof accounts.$inferInsert;

/**
 * User membership in an account, with role + claim list. Hosts are not a
 * separate identity type — a user is a host of an account by holding a
 * membership row with the appropriate claims.
 */
export const accountMemberships = pgTable(
  'account_memberships',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** active | invited | disabled */
    status: text('status').notNull().default('active'),
    /** owner | admin | host | member */
    role: text('role').notNull().default('member'),
    /** Account-scoped claims. See @opendj/core's `Claim` type. */
    claims: text('claims')
      .array()
      .notNull()
      .default(sql`'{}'`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.accountId, table.userId] }),
    userIdx: index('account_memberships_user').on(table.userId),
  }),
);

export type AccountMembershipRow = typeof accountMemberships.$inferSelect;
export type AccountMembershipInsert = typeof accountMemberships.$inferInsert;
