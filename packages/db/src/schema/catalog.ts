import { integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * Local track catalog: every track a provider search has returned or a guest
 * has requested, kept so search can still answer from known tracks when the
 * provider can't be asked (budget spent, daily quota spent, provider cooldown).
 *
 * Shared across accounts and sessions; a track is identified by
 * `(provider_id, track_uri)`. `times_seen` counts provider search results,
 * `times_requested` counts accepted queue requests; both rank local matches.
 */
export const trackCatalog = pgTable(
  'track_catalog',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    providerId: text('provider_id').notNull(),
    trackUri: text('track_uri').notNull(),
    trackName: text('track_name').notNull(),
    artistName: text('artist_name').notNull(),
    albumArtUrl: text('album_art_url'),
    durationMs: integer('duration_ms'),
    timesSeen: integer('times_seen').notNull().default(0),
    timesRequested: integer('times_requested').notNull().default(0),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    providerTrackIdx: uniqueIndex('track_catalog_provider_track').on(
      table.providerId,
      table.trackUri,
    ),
  }),
);

export type TrackCatalogRow = typeof trackCatalog.$inferSelect;
export type TrackCatalogInsert = typeof trackCatalog.$inferInsert;
