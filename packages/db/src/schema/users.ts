import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Central user identity. UUIDs internally; expose `publicUserId` only where a
 * human-friendly identifier is useful — never use it for authorization.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    publicUserId: bigserial('public_user_id', { mode: 'number' }).notNull().unique(),
    displayName: text('display_name'),
    primaryEmail: text('primary_email'),
    emailVerified: boolean('email_verified').notNull().default(false),
    avatarUrl: text('avatar_url'),
    /** active | disabled | deleted */
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    primaryEmailUnique: uniqueIndex('users_primary_email_unique')
      .on(sql`lower(${table.primaryEmail})`)
      .where(sql`${table.primaryEmail} is not null`),
  }),
);

export type UserRow = typeof users.$inferSelect;
export type UserInsert = typeof users.$inferInsert;
