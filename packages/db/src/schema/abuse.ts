import { sql } from 'drizzle-orm';
import {
  bigserial,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { accounts } from './accounts.js';
import { guests, sessions } from './sessions.js';
import { users } from './users.js';

/**
 * Privacy-minimized action / abuse signals. Mirrors @opendj/abuse's ActionEvent.
 *
 * Note: `subjectHash` is salted and session-scoped. Never store raw IPs or raw
 * fingerprint signals.
 */
export const actionEvents = pgTable(
  'action_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    guestId: uuid('guest_id').references(() => guests.id, { onDelete: 'set null' }),
    /** guest_joined | search | song_requested | skip_vote | rate_limited | abuse_blocked | cap_hit | ... */
    eventKind: text('event_kind').notNull(),
    subjectHash: text('subject_hash'),
    riskScore: numeric('risk_score', { precision: 5, scale: 2 }),
    meta: jsonb('meta'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sessionCreatedIdx: index('action_events_session_created').on(table.sessionId, table.createdAt),
    subjectCreatedIdx: index('action_events_subject_created')
      .on(table.subjectHash, table.createdAt)
      .where(sql`${table.subjectHash} is not null`),
  }),
);

export type ActionEventRow = typeof actionEvents.$inferSelect;
export type ActionEventInsert = typeof actionEvents.$inferInsert;

/**
 * Current enforcement state for a subject (hashed identifier).
 *
 * `status`: normal | throttled | shadow_limited | blocked
 */
export const abuseSubjects = pgTable(
  'abuse_subjects',
  {
    subjectHash: text('subject_hash').primaryKey(),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'cascade' }),
    riskScore: numeric('risk_score', { precision: 5, scale: 2 }).notNull().default('0'),
    status: text('status').notNull().default('normal'),
    reason: text('reason'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (table) => ({
    sessionStatusIdx: index('abuse_subjects_session_status').on(table.sessionId, table.status),
  }),
);

export type AbuseSubjectRow = typeof abuseSubjects.$inferSelect;
export type AbuseSubjectInsert = typeof abuseSubjects.$inferInsert;
