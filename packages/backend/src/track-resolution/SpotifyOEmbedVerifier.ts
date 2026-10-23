/**
 * Verifies a resolved Spotify track through Spotify's public oEmbed endpoint
 * (no auth, not the Web API, so it spends none of the search quota).
 *
 * `GET https://open.spotify.com/oembed?url=https://open.spotify.com/track/<id>`
 * answers `title` (the track name), plus `html`, `iframe_url`,
 * `thumbnail_url`, `provider_name`, `type`, `version`, width/height fields.
 * It names no artist, so only the title is compared (see `compareTitles`).
 *
 * Own limiter (scope `spotify_oembed`, one deployment-wide key): 60 calls/min.
 * Titles are cached per URI for 24h. A spent limiter, timeout (3s), network
 * failure, HTTP error, or body without a title is `unavailable` and isn't
 * cached.
 */

import { SlidingWindowRateLimiter } from '../rate-limit/SlidingWindowRateLimiter.js';
import {
  compareTitles,
  type TrackVerdict,
  type TrackVerifier,
  type TrackVerifyRequest,
} from './TrackVerifier.js';

export const SPOTIFY_OEMBED_SCOPE = 'spotify_oembed';
const LIMITER_KEY = 'global';
const DEFAULT_BASE_URL = 'https://open.spotify.com';
const DEFAULT_TIMEOUT_MS = 3_000;
const RATE_LIMIT_PER_MIN = 60;
const TITLE_TTL_MS = 24 * 60 * 60_000;
const CACHE_MAX_ENTRIES = 2_000;
const TRACK_URI = /^spotify:track:([A-Za-z0-9]+)$/;

interface CacheEntry {
  expiresAtEpochMs: number;
  title: string;
}

export interface SpotifyOEmbedVerifierOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
  now?: () => number;
  logger?: Pick<Console, 'warn'>;
}

export class SpotifyOEmbedVerifier implements TrackVerifier {
  readonly providerId = 'spotify';
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly logger: Pick<Console, 'warn'>;
  private readonly limiter: SlidingWindowRateLimiter;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(options: SpotifyOEmbedVerifierOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? console;
    this.limiter = new SlidingWindowRateLimiter({
      now: this.now,
      scopes: { [SPOTIFY_OEMBED_SCOPE]: { limit: RATE_LIMIT_PER_MIN, windowMs: 60_000 } },
    });
  }

  async verify(request: TrackVerifyRequest): Promise<TrackVerdict> {
    const id = TRACK_URI.exec(request.uri)?.[1];
    if (id === undefined) return { verdict: 'unavailable', reason: 'not a Spotify track uri' };

    const title = await this.titleFor(request.uri, id);
    if (typeof title !== 'string') return title;
    const compared = compareTitles(request.trackName, title);
    return compared.ok
      ? { verdict: 'match' }
      : { verdict: 'mismatch', title, reason: compared.reason };
  }

  /** Cached or fetched title for the track, or an `unavailable` verdict. */
  private async titleFor(
    uri: string,
    id: string,
  ): Promise<string | Extract<TrackVerdict, { verdict: 'unavailable' }>> {
    const cached = this.cache.get(uri);
    if (cached && cached.expiresAtEpochMs > this.now()) return cached.title;
    if (cached) this.cache.delete(uri);

    if (!this.limiter.tryApply(SPOTIFY_OEMBED_SCOPE, LIMITER_KEY).ok) {
      return this.unavailable('rate limited');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const params = new URLSearchParams({ url: `https://open.spotify.com/track/${id}` });
      const response = await this.fetchImpl(`${this.baseUrl}/oembed?${params.toString()}`, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      if (!response.ok) return this.unavailable(`HTTP ${response.status}`);
      const body = (await response.json()) as unknown;
      const title =
        body && typeof body === 'object' ? (body as { title?: unknown }).title : undefined;
      if (typeof title !== 'string' || title.trim() === '') return this.unavailable('no title');
      this.remember(uri, title);
      return title;
    } catch (err) {
      return this.unavailable((err as Error).message);
    } finally {
      clearTimeout(timer);
    }
  }

  private unavailable(reason: string): Extract<TrackVerdict, { verdict: 'unavailable' }> {
    this.logger.warn(`[track-resolution] spotify oembed unavailable: ${reason}`);
    return { verdict: 'unavailable', reason };
  }

  private remember(uri: string, title: string): void {
    this.cache.set(uri, { expiresAtEpochMs: this.now() + TITLE_TTL_MS, title });
    while (this.cache.size > CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}
