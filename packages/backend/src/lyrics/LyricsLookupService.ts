/**
 * LyricsLookupService — cache-fronted wrapper around `LyricsProvider`.
 *
 * Brief §"LRCLIB adapter": cache positive AND negative lookups, never let
 * lookup failures block playback, prefer synced lyrics, attribute the source.
 *
 * Negative lookups are stored as cache rows with `is_synced=false`,
 * `synced_lrc=null`, `plain_lyrics=null` — the `findBySourceAndKey` hit lets
 * us skip a fetch on subsequent lookups for known-misses, with `last_used_at`
 * tracking how recently they're being checked.
 */

import {
  lookupCacheKey,
  normalizeLookup,
  parseLrc,
  type LyricsDocument,
  type LyricsFeedbackInput,
  type LyricsProvider,
} from '@opendj/lyrics';
import type {
  LyricsCacheRecord,
  LyricsCacheRepository,
  LyricsFeedbackRecord,
  LyricsFeedbackRepository,
} from '../repositories/types.js';

const TEXT_ENCODER = new TextEncoder();

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += (bytes[i]! >> 4).toString(16);
    out += (bytes[i]! & 0x0f).toString(16);
  }
  return out;
}

async function sha256Hex(value: string): Promise<string> {
  const data = TEXT_ENCODER.encode(value);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return bytesToHex(new Uint8Array(digest));
}

export interface LyricsLookupServiceDeps {
  /** Primary provider tried first (defaults to `lrclib`). */
  provider: LyricsProvider;
  cache: LyricsCacheRepository;
  feedback: LyricsFeedbackRepository;
  nowEpochMs?: () => number;
}

export class LyricsLookupService {
  private readonly now: () => number;

  constructor(private readonly deps: LyricsLookupServiceDeps) {
    this.now = deps.nowEpochMs ?? Date.now;
  }

  /**
   * Look up lyrics for a track. Returns the cached `LyricsDocument`-ish view
   * regardless of cache hit / miss / negative hit.
   *
   * On cache miss: calls the provider, persists either the matched document
   * or a "no match" sentinel row (so the next call short-circuits), and
   * returns the result.
   */
  async lookup(input: {
    trackName: string;
    artistName: string;
    albumName?: string | null;
    durationMs?: number | null;
    providerTrackUri?: string;
    isrc?: string | null;
  }): Promise<LyricsDocument | null> {
    const normalized = normalizeLookup(input);
    const lookupKeyHash = await sha256Hex(lookupCacheKey(normalized));
    const cached = await this.deps.cache.findBySourceAndKey(
      this.deps.provider.providerId,
      lookupKeyHash,
    );
    if (cached) {
      await this.deps.cache.recordHit(cached.id, this.now());
      if (cached.suppressedAt !== null) {
        return null;
      }
      const hasSyncedLrc = cached.syncedLrc !== null && cached.syncedLrc.length > 0;
      const hasPlainLyrics = cached.plainLyrics !== null && cached.plainLyrics.length > 0;
      if (!hasSyncedLrc && !hasPlainLyrics) {
        // No-match sentinel row (negative cache): nothing to hydrate.
        return null;
      }
      return cacheRowToDocument(cached);
    }

    let document: LyricsDocument | null = null;
    try {
      document = await this.deps.provider.getBestMatch({
        trackName: input.trackName,
        artistName: input.artistName,
        ...(input.albumName !== undefined && { albumName: input.albumName }),
        ...(input.durationMs !== undefined && { durationMs: input.durationMs }),
        ...(input.providerTrackUri !== undefined && { providerTrackUri: input.providerTrackUri }),
        ...(input.isrc !== undefined && { isrc: input.isrc }),
      });
    } catch {
      // Provider failure is silent per brief — UI/realtime never block on lyrics.
      return null;
    }

    const stored = await this.deps.cache.upsert({
      source: this.deps.provider.providerId,
      ...(document?.providerLyricsId !== undefined && {
        sourceLyricsId: String(document.providerLyricsId),
      }),
      ...(input.providerTrackUri !== undefined && { providerTrackUri: input.providerTrackUri }),
      trackName: input.trackName,
      artistName: input.artistName,
      ...(input.albumName !== undefined && { albumName: input.albumName }),
      ...(input.durationMs !== undefined && { durationMs: input.durationMs }),
      ...(input.isrc !== undefined && { isrc: input.isrc }),
      isSynced: document?.isSynced ?? false,
      ...(document?.isInstrumental !== undefined && { isInstrumental: document.isInstrumental }),
      matchConfidence: document?.matchConfidence ?? 'low',
      ...(document?.rawLrc !== undefined && { syncedLrc: document.rawLrc }),
      ...(document?.plainText !== undefined && { plainLyrics: document.plainText }),
      ...(document?.attribution !== undefined && { attribution: document.attribution }),
      lookupKeyHash,
    });
    await this.deps.cache.recordHit(stored.id, this.now());
    return document;
  }

  /**
   * Record a feedback submission. Returns the persisted row.
   *
   * Auto-suppression rule: when a single cache entry accumulates >= 3
   * `wrong_song` or `bad_timing` reports, mark it suppressed so the next
   * lookup skips returning the bad match.
   */
  async recordFeedback(
    input: LyricsFeedbackInput & {
      accountId?: string | null;
      userId?: string | null;
      guestId?: string | null;
    },
  ): Promise<LyricsFeedbackRecord> {
    const created = await this.deps.feedback.create({
      ...(input.sessionId !== undefined && { sessionId: input.sessionId }),
      ...(input.accountId !== undefined && { accountId: input.accountId }),
      ...(input.userId !== undefined && { userId: input.userId }),
      ...(input.guestId !== undefined && { guestId: input.guestId }),
      ...(input.lyricsDocumentId !== undefined && { lyricsCacheId: input.lyricsDocumentId }),
      ...(input.trackUri !== undefined && { providerTrackUri: input.trackUri }),
      kind: input.kind,
      ...(input.lineId !== undefined && { lineId: input.lineId }),
      ...(input.comment !== undefined && { comment: input.comment }),
    });

    if (
      input.lyricsDocumentId &&
      (input.kind === 'wrong_song' ||
        input.kind === 'bad_timing' ||
        input.kind === 'offensive_or_bad_content')
    ) {
      const total = await this.deps.feedback.countForCacheEntry(input.lyricsDocumentId, input.kind);
      if (total >= 3) {
        await this.deps.cache.suppress(input.lyricsDocumentId, `auto:${input.kind}`, this.now());
      }
    }

    return created;
  }
}

function cacheRowToDocument(row: LyricsCacheRecord): LyricsDocument {
  // Late-bound import would force a circular dep; we rebuild a LyricsDocument
  // shape here. When the row carries synced LRC, we re-parse it with
  // @opendj/lyrics' parseLrc so cache hits hydrate a full timed line list
  // (mirrors what the LRCLIB adapter does on a fresh provider match).
  const hasSyncedLrc = row.syncedLrc !== null && row.syncedLrc.length > 0;
  const document: LyricsDocument = {
    id: row.id,
    source: row.source,
    ...(row.sourceLyricsId !== null && { providerLyricsId: row.sourceLyricsId }),
    trackName: row.trackName,
    artistName: row.artistName,
    albumName: row.albumName,
    durationMs: row.durationMs,
    isSynced: row.isSynced,
    isInstrumental: row.isInstrumental,
    lines: hasSyncedLrc ? parseLrc(row.syncedLrc!) : [],
    ...(row.syncedLrc !== null && { rawLrc: row.syncedLrc }),
    ...(row.plainLyrics !== null && { plainText: row.plainLyrics }),
    ...(row.attribution !== null && { attribution: row.attribution }),
    matchConfidence: row.matchConfidence,
  };
  return document;
}
