import { index, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { accounts } from './accounts.js';
import { users } from './users.js';

/**
 * Music / service provider connection (Spotify, Soundtrack, Apple Music, ...).
 * Distinct from `auth_identities` — a user may log in with Google AND connect
 * Spotify for playback.
 *
 * One connection per (account, provider). The `(provider_id, provider_account_id)`
 * unique constraint also prevents the same external provider account from
 * being attached to two OpenDJ accounts simultaneously.
 */
export const providerConnections = pgTable(
  'provider_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    connectedByUserId: uuid('connected_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** spotify | soundtrack | apple-music | ... */
    providerId: text('provider_id').notNull(),
    providerAccountId: text('provider_account_id'),
    displayName: text('display_name'),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    scopes: text('scopes').array(),
    tokenType: text('token_type'),
    rawProfile: jsonb('raw_profile'),
    rawTokenResponse: jsonb('raw_token_response'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    accountProvider: unique('provider_connections_account_provider').on(
      table.accountId,
      table.providerId,
    ),
    providerNative: unique('provider_connections_provider_native').on(
      table.providerId,
      table.providerAccountId,
    ),
    accountProviderIdx: index('provider_connections_account_provider_idx').on(
      table.accountId,
      table.providerId,
    ),
  }),
);

export type ProviderConnectionRow = typeof providerConnections.$inferSelect;
export type ProviderConnectionInsert = typeof providerConnections.$inferInsert;
