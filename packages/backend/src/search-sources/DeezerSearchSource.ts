/**
 * Deezer's public search API as a guest search source. No API key.
 *
 * `GET https://api.deezer.com/search?q=<q>&limit=<n>` answers
 * `{ data: [{ id, title, isrc, duration (s), artist: { name },
 * album: { cover_medium } }] }`. Each hit becomes an `opendj:isrc:<ISRC>`
 * track (hits without an ISRC are skipped) that is resolved to the session's
 * provider when a guest adds it.
 *
 * Its own limiter (scope `deezer`, one deployment-wide key) keeps calls at
 * `rateLimit` per 5s, under Deezer's 50 per 5s. A spent limiter, a timeout,
 * an HTTP error, or an `{ error }` body all answer `'unavailable'`.
 */

import { SlidingWindowRateLimiter } from '../rate-limit/SlidingWindowRateLimiter.js';
import { isrcTrackUri, normalizeIsrc } from './isrc.js';
import type { SearchSource, SearchSourceContext, SourceTrack } from './SearchSource.js';

export const DEEZER_SCOPE = 'deezer';
const DEEZER_KEY = 'global';
const DEEZER_WINDOW_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_BASE_URL = 'https://api.deezer.com';

export interface DeezerSearchSourceOptions {
  fetchImpl?: typeof fetch;
  /** Calls allowed per 5s. Default 45. */
  rateLimit?: number;
  /** Abort a call after this long. Default 3s. */
  timeoutMs?: number;
  baseUrl?: string;
  now?: () => number;
  logger?: Pick<Console, 'warn'>;
}

interface DeezerTrack {
  title?: unknown;
  isrc?: unknown;
  duration?: unknown;
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

  constructor(options: DeezerSearchSourceOptions = {}) {
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
    _ctx?: SearchSourceContext,
  ): Promise<SourceTrack[] | 'unavailable'> {
    if (!this.limiter.tryApply(DEEZER_SCOPE, DEEZER_KEY).ok) return 'unavailable';
    const params = new URLSearchParams({ q: query, limit: String(limit) });
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
      const tracks: SourceTrack[] = [];
      for (const item of body.data as DeezerTrack[]) {
        const track = item && typeof item === 'object' ? toSourceTrack(item) : null;
        if (track) tracks.push(track);
      }
      return tracks;
    } catch (err) {
      this.logger.warn('[search] deezer search failed', (err as Error).message);
      return 'unavailable';
    } finally {
      clearTimeout(timer);
    }
  }
}
