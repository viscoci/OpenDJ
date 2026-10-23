import type { Database } from '@opendj/db';
import { schema } from '@opendj/db';
import { eq, sql } from 'drizzle-orm';
import { mergeCatalogUpserts, rankCatalogMatches } from '../../catalog/catalogSearch.js';
import type { TrackCatalogRecord, TrackCatalogRepository, TrackCatalogUpsert } from '../types.js';

/** Rows per INSERT, well under Postgres' 65535 bind-parameter limit (9 per row). */
const UPSERT_CHUNK_ROWS = 1_000;

function mapRow(row: typeof schema.trackCatalog.$inferSelect): TrackCatalogRecord {
  return {
    providerId: row.providerId,
    trackUri: row.trackUri,
    trackName: row.trackName,
    artistName: row.artistName,
    albumArtUrl: row.albumArtUrl,
    durationMs: row.durationMs,
    timesSeen: row.timesSeen,
    timesRequested: row.timesRequested,
    lastSeenAt: row.lastSeenAt,
  };
}

export class DrizzleTrackCatalogRepository implements TrackCatalogRepository {
  constructor(private readonly db: Database) {}

  async upsertMany(entries: ReadonlyArray<TrackCatalogUpsert>): Promise<void> {
    const merged = mergeCatalogUpserts(entries);
    for (let i = 0; i < merged.length; i += UPSERT_CHUNK_ROWS) {
      const chunk = merged.slice(i, i + UPSERT_CHUNK_ROWS);
      await this.db
        .insert(schema.trackCatalog)
        .values(
          chunk.map((e) => ({
            providerId: e.providerId,
            trackUri: e.trackUri,
            trackName: e.trackName,
            artistName: e.artistName,
            albumArtUrl: e.albumArtUrl,
            durationMs: e.durationMs,
            timesSeen: e.seenIncrement,
            timesRequested: e.requestedIncrement,
            lastSeenAt: e.seenAt,
          })),
        )
        .onConflictDoUpdate({
          target: [schema.trackCatalog.providerId, schema.trackCatalog.trackUri],
          set: {
            trackName: sql`excluded."track_name"`,
            artistName: sql`excluded."artist_name"`,
            albumArtUrl: sql`coalesce(excluded."album_art_url", "track_catalog"."album_art_url")`,
            durationMs: sql`coalesce(excluded."duration_ms", "track_catalog"."duration_ms")`,
            timesSeen: sql`"track_catalog"."times_seen" + excluded."times_seen"`,
            timesRequested: sql`"track_catalog"."times_requested" + excluded."times_requested"`,
            lastSeenAt: sql`greatest("track_catalog"."last_seen_at", excluded."last_seen_at")`,
          },
        });
    }
  }

  async findAll(): Promise<TrackCatalogRecord[]> {
    const rows = await this.db.select().from(schema.trackCatalog);
    return rows.map(mapRow);
  }

  /**
   * Ranks in JS (`rankCatalogMatches`) so accent folding and prefix rules
   * match the in-process index exactly, without needing `unaccent`. Search
   * normally runs on `TrackCatalog`'s index; this is the cold-path fallback.
   */
  async search(input: {
    providerId: string;
    query: string;
    limit: number;
  }): Promise<TrackCatalogRecord[]> {
    const rows = await this.db
      .select()
      .from(schema.trackCatalog)
      .where(eq(schema.trackCatalog.providerId, input.providerId));
    return rankCatalogMatches(rows.map(mapRow), input.query, input.limit);
  }
}
