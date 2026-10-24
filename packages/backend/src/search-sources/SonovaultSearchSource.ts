/**
 * Sonovault's track search as a guest search source. Only wired when
 * `SEARCH_SOURCES` lists `sonovault` and `SONOVAULT_API_KEY` is set.
 *
 * `GET https://api.sonovault.now/v1/tracks/search?artist=<a>&title=<t>&limit=<n>`
 * with header `x-api-key`. Both `artist` and `title` are required and there
 * is no free-text parameter, so a guest query is only sent when it has a
 * clear separator (`parseArtistTitleQuery`): `Artist - Title` (also `–`, `—`)
 * is asked as written, then swapped if nothing usable came back; `Title by
 * Artist` is asked once. Any other query is skipped (`'unavailable'`) without
 * a request, so a search costs at most two calls.
 *
 * The body is read defensively: a top-level array or `{ data | results |
 * tracks: [...] }` of `{ title, artists: [{ name } | string], isrc, duration }`.
 * `duration` above 10000 is taken as ms, otherwise seconds. Each hit becomes
 * an `opendj:isrc:<ISRC>` track (hits without an ISRC are skipped) with no
 * album art; it is resolved to the session's provider when a guest adds it.
 *
 * Budget: shares the deployment-wide Sonovault limiter (`createSonovaultLimiter`,
 * 18 calls/min) with `SonovaultTrackResolver` when deps passes it in, and only
 * spends while more than `SONOVAULT_SEARCH_RESERVE` calls are left, so add-time
 * resolution always keeps that headroom. A spent budget, a timeout, an HTTP
 * error, or an unreadable body all answer `'unavailable'`.
 */

import type { SlidingWindowRateLimiter } from '../rate-limit/SlidingWindowRateLimiter.js';
import {
  createSonovaultLimiter,
  SONOVAULT_KEY,
  SONOVAULT_SCOPE,
} from '../track-resolution/SonovaultTrackResolver.js';
import { isrcTrackUri, normalizeIsrc } from './isrc.js';
import type { SearchSource, SearchSourceContext, SourceTrack } from './SearchSource.js';

/** Sonovault calls per window that guest search leaves for add-time resolution. */
export const SONOVAULT_SEARCH_RESERVE = 6;
const DEFAULT_BASE_URL = 'https://api.sonovault.now';
const DEFAULT_TIMEOUT_MS = 3_000;
/** A `duration` above this is in ms; at or below it, seconds. */
const DURATION_MS_THRESHOLD = 10_000;

const DASH_SEPARATOR = /\s+[-–—]\s+/;
const BY_SEPARATOR = /\s+by\s+/gi;

export interface ArtistTitle {
  artist: string;
  title: string;
}

/**
 * The artist/title pairs to ask for `query`, in order, or null when it has
 * no clear separator. Splits on the first spaced dash (artist first, then
 * swapped) or else on the last ` by ` (title by artist).
 */
export function parseArtistTitleQuery(query: string): ArtistTitle[] | null {
  const trimmed = query.trim();
  const dash = DASH_SEPARATOR.exec(trimmed);
  if (dash) {
    const left = trimmed.slice(0, dash.index).trim();
    const right = trimmed.slice(dash.index + dash[0].length).trim();
    if (left === '' || right === '') return null;
    return [
      { artist: left, title: right },
      { artist: right, title: left },
    ];
  }
  let last: RegExpExecArray | null = null;
  for (const match of trimmed.matchAll(BY_SEPARATOR)) last = match as RegExpExecArray;
  if (last) {
    const title = trimmed.slice(0, last.index).trim();
    const artist = trimmed.slice(last.index + last[0].length).trim();
    if (title === '' || artist === '') return null;
    return [{ artist, title }];
  }
  return null;
}

export interface SonovaultSearchSourceOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  /** Abort a call after this long. Default 3s. */
  timeoutMs?: number;
  now?: () => number;
  logger?: Pick<Console, 'warn'>;
  /** The Sonovault limiter shared with the resolver. Default: a new one. */
  limiter?: SlidingWindowRateLimiter;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function artistNameOf(value: unknown): string | null {
  if (typeof value === 'string') return nonEmptyString(value);
  if (value && typeof value === 'object') return nonEmptyString((value as { name?: unknown }).name);
  return null;
}

function artistNames(item: Record<string, unknown>): string | null {
  const names = Array.isArray(item['artists'])
    ? item['artists'].map(artistNameOf).filter((name): name is string => name !== null)
    : [];
  if (names.length === 0) {
    const single = artistNameOf(item['artist']);
    if (single !== null) names.push(single);
  }
  return names.length > 0 ? names.join(', ') : null;
}

function durationMsOf(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return Math.round(value > DURATION_MS_THRESHOLD ? value : value * 1000);
}

function toSourceTrack(value: unknown): SourceTrack | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const isrc = normalizeIsrc(item['isrc']);
  const name = nonEmptyString(item['title']) ?? nonEmptyString(item['name']);
  const artist = artistNames(item);
  if (isrc === null || name === null || artist === null) return null;
  return {
    trackUri: isrcTrackUri(isrc),
    trackName: name,
    artistName: artist,
    albumArtUrl: null,
    durationMs: durationMsOf(item['duration']),
    isrc,
  };
}

/** The track list in a response body, or null for an unknown shape. */
function trackList(body: unknown): unknown[] | null {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return null;
  for (const field of ['data', 'results', 'tracks']) {
    const list = (body as Record<string, unknown>)[field];
    if (Array.isArray(list)) return list;
  }
  return null;
}

export class SonovaultSearchSource implements SearchSource {
  readonly id = 'sonovault' as const;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly logger: Pick<Console, 'warn'>;
  private readonly limiter: SlidingWindowRateLimiter;

  constructor(options: SonovaultSearchSourceOptions) {
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.logger = options.logger ?? console;
    this.limiter = options.limiter ?? createSonovaultLimiter(options.now);
  }

  async search(
    query: string,
    limit: number,
    _ctx?: SearchSourceContext,
  ): Promise<SourceTrack[] | 'unavailable'> {
    const attempts = parseArtistTitleQuery(query);
    if (attempts === null) return 'unavailable';
    for (const attempt of attempts) {
      const tracks = await this.ask(attempt, limit);
      if (tracks === 'unavailable' || tracks.length > 0) return tracks;
    }
    return [];
  }

  /** Spend one call unless only the resolution reserve is left. */
  private trySpend(): boolean {
    if (
      this.limiter.peekSync(SONOVAULT_SCOPE, SONOVAULT_KEY).remaining <= SONOVAULT_SEARCH_RESERVE
    ) {
      return false;
    }
    return this.limiter.tryApply(SONOVAULT_SCOPE, SONOVAULT_KEY).ok;
  }

  private async ask(
    { artist, title }: ArtistTitle,
    limit: number,
  ): Promise<SourceTrack[] | 'unavailable'> {
    if (!this.trySpend()) return 'unavailable';
    const params = new URLSearchParams({ artist, title, limit: String(limit) });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(
        `${this.baseUrl}/v1/tracks/search?${params.toString()}`,
        {
          signal: controller.signal,
          headers: { 'x-api-key': this.apiKey, accept: 'application/json' },
        },
      );
      if (!response.ok) {
        this.logger.warn(`[search] sonovault answered HTTP ${response.status}`);
        return 'unavailable';
      }
      const list = trackList(await response.json());
      if (list === null) {
        this.logger.warn('[search] sonovault answered an unknown body shape');
        return 'unavailable';
      }
      const tracks: SourceTrack[] = [];
      for (const item of list) {
        const track = toSourceTrack(item);
        if (track) tracks.push(track);
      }
      return tracks;
    } catch (err) {
      this.logger.warn('[search] sonovault search failed', (err as Error).message);
      return 'unavailable';
    } finally {
      clearTimeout(timer);
    }
  }
}
