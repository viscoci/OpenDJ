/**
 * Deezer's public search API as a guest search source. No API key.
 *
 * `GET https://api.deezer.com/search?q=<q>&limit=<n>&order=RANKING` answers
 * `{ data: [{ id, title, isrc, duration (s), rank, artist: { name },
 * album: { cover_medium } }] }`. Each hit becomes an `opendj:isrc:<ISRC>`
 * track (hits without an ISRC are skipped) that is resolved to the session's
 * provider when a guest adds it.
 *
 * Deezer's own order is cluttered (remixes, live takes, karaoke, covers), so
 * the source asks for at least `DEEZER_FETCH_LIMIT` hits, re-ranks them with
 * `rankDeezerHits` (deduplication, variant penalty, query-word and
 * guest-requested bonuses), and returns the first `limit`. The requested
 * bonus comes from the optional `requestedCounts` port (the local catalog);
 * a failing lookup ranks without it.
 *
 * `searchWithConfidence` also reports whether the answer is confident (see
 * `isConfidentAnswer`): a non-variant hit matching every query word with a
 * Deezer rank of at least `confidentRank` (`DEEZER_CONFIDENT_RANK`) among the
 * returned results. Deezer lacks some originals (e.g. "Mr. Brightside" comes
 * back as covers and remixes only), and the route asks the provider instead.
 *
 * Its own limiter (scope `deezer`, one deployment-wide key) keeps calls at
 * `rateLimit` per 5s, under Deezer's 50 per 5s. A spent limiter, a timeout,
 * an HTTP error, or an `{ error }` body all answer `'unavailable'`.
 */

import { DEFAULT_DEEZER_CONFIDENT_RANK } from '../config.js';
import { SlidingWindowRateLimiter } from '../rate-limit/SlidingWindowRateLimiter.js';
import { isConfidentAnswer, scoreDeezerHits, type RankableHit } from './deezerRanking.js';
import { isrcTrackUri, normalizeIsrc } from './isrc.js';
import type {
  ScoredSourceAnswer,
  SearchSource,
  SearchSourceContext,
  SourceTrack,
} from './SearchSource.js';

export const DEEZER_SCOPE = 'deezer';
const DEEZER_KEY = 'global';
const DEEZER_WINDOW_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_BASE_URL = 'https://api.deezer.com';
/** Hits asked of Deezer per search (more when the caller wants more), so re-ranking has room. */
export const DEEZER_FETCH_LIMIT = 25;

/** How often guests requested each of `isrcs` under `providerId`; unrequested ones may be absent. */
export type RequestedCountsLookup = (
  providerId: string,
  isrcs: readonly string[],
) => Promise<ReadonlyMap<string, number>>;

export interface DeezerSearchSourceOptions {
  fetchImpl?: typeof fetch;
  /** Calls allowed per 5s. Default 45. */
  rateLimit?: number;
  /** Abort a call after this long. Default 3s. */
  timeoutMs?: number;
  baseUrl?: string;
  now?: () => number;
  logger?: Pick<Console, 'warn'>;
  /** Guest request counts by ISRC, for the requested bonus. Default: none. */
  requestedCounts?: RequestedCountsLookup;
  /** Minimum Deezer rank of a confident answer's original. Default 500000. */
  confidentRank?: number;
}

interface DeezerTrack {
  title?: unknown;
  isrc?: unknown;
  duration?: unknown;
  rank?: unknown;
  artist?: { name?: unknown } | null;
  album?: { cover_medium?: unknown } | null;
}

function toSourceTrack(item: DeezerTrack): SourceTrack | null {
  const isrc = normalizeIsrc(item.isrc);
  const name = item.title;
  const artist = item.artist?.name;
  if (isrc === null || typeof name !== 'string' || typeof artist !== 'string') return null;
  const cover = item.album?.cover_medium;
  return {
    trackUri: isrcTrackUri(isrc),
    trackName: name,
    artistName: artist,
    albumArtUrl: typeof cover === 'string' && cover !== '' ? cover : null,
    durationMs:
      typeof item.duration === 'number' && Number.isFinite(item.duration)
        ? Math.round(item.duration * 1000)
        : null,
    isrc,
  };
}

export class DeezerSearchSource implements SearchSource {
  readonly id = 'deezer' as const;
  private readonly fetchImpl: typeof fetch;
  private readonly limiter: SlidingWindowRateLimiter;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;
  private readonly logger: Pick<Console, 'warn'>;
  private readonly requestedCounts: RequestedCountsLookup | null;
  private readonly confidentRank: number;

  constructor(options: DeezerSearchSourceOptions = {}) {
    this.requestedCounts = options.requestedCounts ?? null;
    this.confidentRank = options.confidentRank ?? DEFAULT_DEEZER_CONFIDENT_RANK;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.logger = options.logger ?? console;
    this.limiter = new SlidingWindowRateLimiter({
      ...(options.now !== undefined && { now: options.now }),
      scopes: {
        [DEEZER_SCOPE]: { limit: options.rateLimit ?? 45, windowMs: DEEZER_WINDOW_MS },
      },
    });
  }

  async search(
    query: string,
    limit: number,
    ctx?: SearchSourceContext,
  ): Promise<SourceTrack[] | 'unavailable'> {
    const answer = await this.searchWithConfidence(query, limit, ctx);
    return answer === 'unavailable' ? answer : answer.tracks;
  }

  async searchWithConfidence(
    query: string,
    limit: number,
    ctx?: SearchSourceContext,
  ): Promise<ScoredSourceAnswer | 'unavailable'> {
    const hits = await this.fetchHits(query, Math.max(limit, DEEZER_FETCH_LIMIT));
    if (hits === 'unavailable') return hits;
    const requested = await this.lookupRequested(hits, ctx);
    const scored = scoreDeezerHits(query, hits, requested).slice(0, limit);
    return {
      tracks: scored.map((h) => h.track),
      confident: isConfidentAnswer(query, scored, limit, this.confidentRank),
    };
  }

  private async lookupRequested(
    hits: RankableHit[],
    ctx: SearchSourceContext | undefined,
  ): Promise<ReadonlyMap<string, number>> {
    if (!this.requestedCounts || !ctx || hits.length === 0) return new Map();
    const isrcs = [...new Set(hits.flatMap((h) => (h.track.isrc ? [h.track.isrc] : [])))];
    try {
      return await this.requestedCounts(ctx.providerId, isrcs);
    } catch (err) {
      this.logger.warn('[search] deezer requested-count lookup failed', (err as Error).message);
      return new Map();
    }
  }

  private async fetchHits(query: string, limit: number): Promise<RankableHit[] | 'unavailable'> {
    if (!this.limiter.tryApply(DEEZER_SCOPE, DEEZER_KEY).ok) return 'unavailable';
    const params = new URLSearchParams({ q: query, limit: String(limit), order: 'RANKING' });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/search?${params.toString()}`, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      if (!response.ok) {
        this.logger.warn(`[search] deezer answered HTTP ${response.status}`);
        return 'unavailable';
      }
      const body = (await response.json()) as { data?: unknown; error?: unknown };
      if (body.error !== undefined || !Array.isArray(body.data)) {
        this.logger.warn('[search] deezer answered an error body', body.error);
        return 'unavailable';
      }
      const hits: RankableHit[] = [];
      for (const item of body.data as DeezerTrack[]) {
        const track = item && typeof item === 'object' ? toSourceTrack(item) : null;
        if (!track) continue;
        const rank = typeof item.rank === 'number' && item.rank > 0 ? item.rank : 0;
        hits.push({ track, rank });
      }
      return hits;
    } catch (err) {
      this.logger.warn('[search] deezer search failed', (err as Error).message);
      return 'unavailable';
    } finally {
      clearTimeout(timer);
    }
  }
}
