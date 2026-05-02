import type { Database } from '@opendj/db';
import { schema } from '@opendj/db';
import { and, eq, sql } from 'drizzle-orm';
import type { LyricsCacheRecord, LyricsCacheRepository } from '../types.js';

function mapCache(row: typeof schema.lyricsCache.$inferSelect): LyricsCacheRecord {
  return {
    id: row.id,
    source: row.source,
    sourceLyricsId: row.sourceLyricsId,
    providerTrackUri: row.providerTrackUri,
    trackName: row.trackName,
    artistName: row.artistName,
    albumName: row.albumName,
    durationMs: row.durationMs,
    isrc: row.isrc,
    isSynced: row.isSynced,
    isInstrumental: row.isInstrumental,
    matchConfidence: row.matchConfidence as LyricsCacheRecord['matchConfidence'],
    syncedLrc: row.syncedLrc,
    plainLyrics: row.plainLyrics,
    attribution: row.attribution,
    lookupKeyHash: row.lookupKeyHash,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastUsedAt: row.lastUsedAt,
    suppressedAt: row.suppressedAt,
    suppressedReason: row.suppressedReason,
  };
}

export class DrizzleLyricsCacheRepository implements LyricsCacheRepository {
  constructor(private readonly db: Database) {}

  async findBySourceAndKey(
    source: string,
    lookupKeyHash: string,
  ): Promise<LyricsCacheRecord | null> {
    const rows = await this.db
      .select()
      .from(schema.lyricsCache)
      .where(
        and(
          eq(schema.lyricsCache.source, source),
          eq(schema.lyricsCache.lookupKeyHash, lookupKeyHash),
        ),
      )
      .limit(1);
    return rows[0] ? mapCache(rows[0]) : null;
  }

  async upsert(input: {
    source: string;
    sourceLyricsId?: string | null;
    providerTrackUri?: string | null;
    trackName: string;
    artistName: string;
    albumName?: string | null;
    durationMs?: number | null;
    isrc?: string | null;
    isSynced: boolean;
    isInstrumental?: boolean;
    matchConfidence: 'low' | 'medium' | 'high';
    syncedLrc?: string | null;
    plainLyrics?: string | null;
    attribution?: string | null;
    lookupKeyHash: string;
  }): Promise<LyricsCacheRecord> {
    const rows = await this.db
      .insert(schema.lyricsCache)
      .values({
        source: input.source,
        sourceLyricsId: input.sourceLyricsId ?? null,
        providerTrackUri: input.providerTrackUri ?? null,
        trackName: input.trackName,
        artistName: input.artistName,
        albumName: input.albumName ?? null,
        durationMs: input.durationMs ?? null,
        isrc: input.isrc ?? null,
        isSynced: input.isSynced,
        isInstrumental: input.isInstrumental ?? false,
        matchConfidence: input.matchConfidence,
        syncedLrc: input.syncedLrc ?? null,
        plainLyrics: input.plainLyrics ?? null,
        attribution: input.attribution ?? null,
        lookupKeyHash: input.lookupKeyHash,
      })
      .onConflictDoUpdate({
        target: [schema.lyricsCache.source, schema.lyricsCache.lookupKeyHash],
        set: {
          sourceLyricsId: input.sourceLyricsId ?? null,
          providerTrackUri: input.providerTrackUri ?? null,
          trackName: input.trackName,
          artistName: input.artistName,
          albumName: input.albumName ?? null,
          durationMs: input.durationMs ?? null,
          isrc: input.isrc ?? null,
          isSynced: input.isSynced,
          isInstrumental: input.isInstrumental ?? false,
          matchConfidence: input.matchConfidence,
          syncedLrc: input.syncedLrc ?? null,
          plainLyrics: input.plainLyrics ?? null,
          attribution: input.attribution ?? null,
          updatedAt: sql`now()`,
        },
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('Failed to upsert lyrics cache.');
    return mapCache(row);
  }

  async recordHit(id: string, nowEpochMs: number): Promise<void> {
    await this.db
      .update(schema.lyricsCache)
      .set({ lastUsedAt: new Date(nowEpochMs) })
      .where(eq(schema.lyricsCache.id, id));
  }

  async suppress(id: string, reason: string, nowEpochMs: number): Promise<void> {
    await this.db
      .update(schema.lyricsCache)
      .set({ suppressedAt: new Date(nowEpochMs), suppressedReason: reason })
      .where(eq(schema.lyricsCache.id, id));
  }
}
