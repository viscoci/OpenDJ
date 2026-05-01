import { sql } from 'drizzle-orm';
import {
  bigserial,
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
import { guests, sessions } from './sessions.js';
import { users } from './users.js';

/**
 * Lyrics lookup cache. OSS includes generic lyrics caching because lyrics are
 * a core live-view feature, not just a paid extension.
 *
 * `(source, lookup_key_hash)` is the natural cache key — adapters compute the
 * hash from normalized track metadata via @opendj/lyrics's lookupCacheKey.
 */
export const lyricsCache = pgTable(
  'lyrics_cache',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** lrclib | manual | provider-specific | ... */
    source: text('source').notNull(),
    sourceLyricsId: text('source_lyrics_id'),
    providerTrackUri: text('provider_track_uri'),
    trackName: text('track_name').notNull(),
    artistName: text('artist_name').notNull(),
    albumName: text('album_name'),
    durationMs: integer('duration_ms'),
    isrc: text('isrc'),
    isSynced: boolean('is_synced').notNull().default(false),
    isInstrumental: boolean('is_instrumental').notNull().default(false),
    /** low | medium | high */
    matchConfidence: text('match_confidence').notNull().default('medium'),
    syncedLrc: text('synced_lrc'),
    plainLyrics: text('plain_lyrics'),
    normalizedPayload: jsonb('normalized_payload'),
    attribution: text('attribution'),
    lookupKeyHash: text('lookup_key_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    /** When set, this match has been suppressed (do not return for new lookups). */
    suppressedAt: timestamp('suppressed_at', { withTimezone: true }),
    suppressedReason: text('suppressed_reason'),
  },
  (table) => ({
    sourceLookup: unique('lyrics_cache_source_lookup').on(table.source, table.lookupKeyHash),
    trackLookupIdx: index('lyrics_cache_track_lookup').on(
      sql`lower(${table.trackName})`,
      sql`lower(${table.artistName})`,
      table.durationMs,
    ),
    providerTrackIdx: index('lyrics_cache_provider_track')
      .on(table.providerTrackUri)
      .where(sql`${table.providerTrackUri} is not null`),
  }),
);

export type LyricsCacheRow = typeof lyricsCache.$inferSelect;
export type LyricsCacheInsert = typeof lyricsCache.$inferInsert;

/**
 * Feedback about lyrics quality / timing / matches.
 *
 * `kind`: wrong_song | bad_timing | wrong_line | missing_lyrics |
 *         offensive_or_bad_content | other
 */
export const lyricsFeedback = pgTable(
  'lyrics_feedback',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'set null' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    guestId: uuid('guest_id').references(() => guests.id, { onDelete: 'set null' }),
    lyricsCacheId: uuid('lyrics_cache_id').references(() => lyricsCache.id, {
      onDelete: 'set null',
    }),
    providerTrackUri: text('provider_track_uri'),
    kind: text('kind').notNull(),
    lineId: text('line_id'),
    comment: text('comment'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sessionCreatedIdx: index('lyrics_feedback_session_created').on(
      table.sessionId,
      table.createdAt,
    ),
    lyricsKindIdx: index('lyrics_feedback_lyrics_kind').on(table.lyricsCacheId, table.kind),
  }),
);

export type LyricsFeedbackRow = typeof lyricsFeedback.$inferSelect;
export type LyricsFeedbackInsert = typeof lyricsFeedback.$inferInsert;
