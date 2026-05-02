import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { accounts } from './accounts.js';
import { users } from './users.js';

/**
 * Login identity for Google / Apple / Facebook / email-password / etc.
 *
 * `(provider_id, provider_subject)` is the natural identity key — Apple's
 * private relay emails change but the subject doesn't, so don't use email as
 * the stable identifier.
 */
export const authIdentities = pgTable(
  'auth_identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** google | apple | facebook | email-password | ... */
    providerId: text('provider_id').notNull(),
    /** OIDC sub or internal email subject. */
    providerSubject: text('provider_subject').notNull(),
    email: text('email'),
    emailVerified: boolean('email_verified').notNull().default(false),
    rawProfile: jsonb('raw_profile'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    providerIdentity: unique('auth_identities_provider_identity').on(
      table.providerId,
      table.providerSubject,
    ),
    userIdx: index('auth_identities_user').on(table.userId),
  }),
);

export type AuthIdentityRow = typeof authIdentities.$inferSelect;
export type AuthIdentityInsert = typeof authIdentities.$inferInsert;

/**
 * Password credential for the email/password fallback.
 *
 * Stores a slow password hash (Argon2id default) plus rate-limit metadata.
 * Never plaintext.
 */
export const passwordCredentials = pgTable('password_credentials', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  passwordHash: text('password_hash').notNull(),
  hashAlgorithm: text('hash_algorithm').notNull(),
  passwordUpdatedAt: timestamp('password_updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  failedAttempts: integer('failed_attempts').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
});

export type PasswordCredentialRow = typeof passwordCredentials.$inferSelect;
export type PasswordCredentialInsert = typeof passwordCredentials.$inferInsert;

/**
 * Server-side sessions. Browser clients see only an opaque session token in a
 * secure httpOnly cookie. The token is hashed before storage.
 */
export const authSessions = pgTable(
  'auth_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    currentAccountId: uuid('current_account_id').references(() => accounts.id, {
      onDelete: 'set null',
    }),
    sessionHash: text('session_hash').notNull().unique(),
    /** Snapshot refreshed on login, account switch, claim change. */
    claimsSnapshot: text('claims_snapshot')
      .array()
      .notNull()
      .default(sql`'{}'`),
    ipHash: text('ip_hash'),
    userAgentHash: text('user_agent_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => ({
    activeIdx: index('auth_sessions_user_active')
      .on(table.userId, table.expiresAt)
      .where(sql`${table.revokedAt} is null`),
  }),
);

export type AuthSessionRow = typeof authSessions.$inferSelect;
export type AuthSessionInsert = typeof authSessions.$inferInsert;

/**
 * Generic OAuth state nonce storage. Used for both login OAuth flows and music-
 * provider connection flows. KV / in-memory storage is preferred when available;
 * this table is the durable fallback.
 */
export const oauthStates = pgTable(
  'oauth_states',
  {
    state: text('state').primaryKey(),
    /** login | connect-provider */
    flowKind: text('flow_kind').notNull().default('login'),
    providerId: text('provider_id').notNull(),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    redirectTo: text('redirect_to'),
    codeVerifier: text('code_verifier'),
    nonce: text('nonce'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => ({
    expiryIdx: index('oauth_states_expiry').on(table.expiresAt),
  }),
);

export type OAuthStateRow = typeof oauthStates.$inferSelect;
export type OAuthStateInsert = typeof oauthStates.$inferInsert;

/**
 * One-time email verification tokens. The opaque token sent to the user is
 * hashed before storage so a DB read can't replay verifications.
 *
 * The token row binds to a specific `email` (not just `user_id`) so users
 * who later change their email need a fresh verification.
 */
export const emailVerificationTokens = pgTable(
  'email_verification_tokens',
  {
    tokenHash: text('token_hash').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (table) => ({
    userIdx: index('email_verification_tokens_user').on(table.userId),
    expiryIdx: index('email_verification_tokens_expiry').on(table.expiresAt),
  }),
);

export type EmailVerificationTokenRow = typeof emailVerificationTokens.$inferSelect;
export type EmailVerificationTokenInsert = typeof emailVerificationTokens.$inferInsert;

/**
 * One-time password-reset tokens. Same hashed-token pattern as
 * `emailVerificationTokens`. `requested_from_ip_hash` captures the request
 * origin for forensics if the flow gets abused — the consumer-side UI
 * never sees this.
 */
export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    tokenHash: text('token_hash').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    requestedFromIpHash: text('requested_from_ip_hash'),
  },
  (table) => ({
    userIdx: index('password_reset_tokens_user').on(table.userId),
    expiryIdx: index('password_reset_tokens_expiry').on(table.expiresAt),
  }),
);

export type PasswordResetTokenRow = typeof passwordResetTokens.$inferSelect;
export type PasswordResetTokenInsert = typeof passwordResetTokens.$inferInsert;
