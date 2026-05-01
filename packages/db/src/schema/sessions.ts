import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { accounts } from './accounts.js';
import { users } from './users.js';

/**
 * Live event / session. One row per event hosts run.
 *
 * `voteSkipMode`: 'fixed' | 'percentage' | 'host_approval'
 */
export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  qrSlug: text('qr_slug').notNull().unique(),
  guestCapOverride: integer('guest_cap_override'),
  songsPerGuestCap: integer('songs_per_guest_cap').notNull().default(3),
  moderationEnabled: boolean('moderation_enabled').notNull().default(false),
  voteSkipMode: text('vote_skip_mode').notNull().default('fixed'),
  voteSkipThreshold: integer('vote_skip_threshold').notNull().default(5),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
});

export type SessionRow = typeof sessions.$inferSelect;
export type SessionInsert = typeof sessions.$inferInsert;

/**
 * Per-session guest record. `userId` is nullable — anonymous guests.
 * `(session_id, fingerprint)` uniqueness enforces session-scoped slot identity.
 */
export const guests = pgTable(
  'guests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    /** Salted, session-scoped fingerprint hash. Never the raw client signal. */
    fingerprint: text('fingerprint').notNull(),
    name: text('name'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sessionFingerprint: unique('guests_session_fingerprint').on(table.sessionId, table.fingerprint),
  }),
);

export type GuestRow = typeof guests.$inferSelect;
export type GuestInsert = typeof guests.$inferInsert;

/**
 * Queue items.
 *
 * `status`: pending | approved | queued | playing | rejected
 */
export const queueItems = pgTable(
  'queue_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    guestId: uuid('guest_id')
      .notNull()
      .references(() => guests.id, { onDelete: 'cascade' }),
    trackUri: text('track_uri').notNull(),
    trackName: text('track_name').notNull(),
    artistName: text('artist_name').notNull(),
    albumArtUrl: text('album_art_url'),
    durationMs: integer('duration_ms'),
    status: text('status').notNull().default('pending'),
    skipVotes: integer('skip_votes').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
  },
  (table) => ({
    sessionStatusIdx: index('queue_items_session_status').on(table.sessionId, table.status),
    sessionCreatedIdx: index('queue_items_session_created').on(table.sessionId, table.createdAt),
  }),
);

export type QueueItemRow = typeof queueItems.$inferSelect;
export type QueueItemInsert = typeof queueItems.$inferInsert;

/**
 * Append-only event stream for realtime replay/debugging. Payload is
 * public/session-safe only — no secrets, no PII.
 */
export const sessionEvents = pgTable(
  'session_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sessionCreatedIdx: index('session_events_session_created').on(table.sessionId, table.createdAt),
  }),
);

export type SessionEventRow = typeof sessionEvents.$inferSelect;
export type SessionEventInsert = typeof sessionEvents.$inferInsert;

/**
 * Reliable provider/background side effects. Workers/Queues consume and mark processed.
 */
export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    payload: jsonb('payload').notNull(),
    /** pending | processing | done | failed */
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (table) => ({
    pendingIdx: index('outbox_events_pending').on(table.status, table.nextAttemptAt),
  }),
);

export type OutboxEventRow = typeof outboxEvents.$inferSelect;
export type OutboxEventInsert = typeof outboxEvents.$inferInsert;

/**
 * Guest capacity slot. `status`: active | queued | priority_queued
 */
export const guestSlots = pgTable(
  'guest_slots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id),
    fingerprintHash: text('fingerprint_hash').notNull(),
    slotToken: text('slot_token').notNull().unique(),
    status: text('status').notNull().default('active'),
    queuePosition: integer('queue_position'),
    lastHeartbeat: timestamp('last_heartbeat', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sessionFingerprint: unique('guest_slots_session_fingerprint').on(
      table.sessionId,
      table.fingerprintHash,
    ),
    heartbeatIdx: index('guest_slots_heartbeat')
      .on(table.sessionId, table.lastHeartbeat)
      .where(sql`${table.status} = 'active'`),
  }),
);

export type GuestSlotRow = typeof guestSlots.$inferSelect;
export type GuestSlotInsert = typeof guestSlots.$inferInsert;

/**
 * Priority re-entry: a slot that was released. Held briefly so the guest can
 * reclaim it on quick rejoin without competing with new arrivals.
 */
export const fingerprintPriority = pgTable(
  'fingerprint_priority',
  {
    fingerprintHash: text('fingerprint_hash').notNull(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id),
    releasedAt: timestamp('released_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '48 hours'`),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.fingerprintHash, table.sessionId] }),
  }),
);

export type FingerprintPriorityRow = typeof fingerprintPriority.$inferSelect;
export type FingerprintPriorityInsert = typeof fingerprintPriority.$inferInsert;
