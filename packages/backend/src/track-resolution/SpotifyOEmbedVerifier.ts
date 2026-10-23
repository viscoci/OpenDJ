/**
 * Verifies a resolved Spotify track through Spotify's public endpoints (no
 * auth, not the Web API, so it spends none of the search quota).
 *
 * Title: `GET https://open.spotify.com/oembed?url=https://open.spotify.com/track/<id>`
 * answers `title` (the track name), plus `html`, `iframe_url`,
 * `thumbnail_url`, `provider_name`, `type`, `version`, width/height fields.
 * It names no artist; the title is compared with `compareTitles`.
 *
 * Artist: when the title passes and the request names an artist, the public
 * track page `GET https://open.spotify.com/track/<id>` (plain HTML, fetched
 * with a browser User-Agent) is read. Its `<title>` credits the artists, e.g.
 * `Happy - song and lyrics by Ken | Spotify` or `Push It - Radio Version -
 * Song, Lyrics, and Music Video by Salt-N-Pepa | Spotify` (see
 * `parseSpotifyPageArtists`), compared with `compareArtists`. This catches a
 * same-titled recording by another artist, which oEmbed alone can't. A page
 * that can't be fetched or parsed falls back to the title-only decision.
 *
 * One limiter (scope `spotify_oembed`, one deployment-wide key) of 60
 * calls/min covers both fetches. Titles and page artists are cached per URI
 * for 24h. A spent limiter, timeout (3s), network failure, HTTP error, or an
 * unparsable body is `unavailable` (oEmbed) / a title-only fallback (page),
 * and isn't cached.
 */

import { SlidingWindowRateLimiter } from '../rate-limit/SlidingWindowRateLimiter.js';
import {
  compareArtists,
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
const CACHE_TTL_MS = 24 * 60 * 60_000;
const CACHE_MAX_ENTRIES = 2_000;
const TRACK_URI = /^spotify:track:([A-Za-z0-9]+)$/;
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

type Fetched<T> = { ok: true; value: T } | { ok: false; reason: string };

type Unavailable = Extract<TrackVerdict, { verdict: 'unavailable' }>;

interface CacheEntry<T> {
  expiresAtEpochMs: number;
  value: T;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/giu, (whole, code: string) => {
    if (code[0] === '#') {
      const point =
        code[1] === 'x' || code[1] === 'X'
          ? Number.parseInt(code.slice(2), 16)
          : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(point) && point <= 0x10ffff ? String.fromCodePoint(point) : whole;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/**
 * The artists a Spotify track page's `<title>` credits: the text after the
 * last ` by ` up to ` | Spotify`, split on commas, ` & ` and ` and `. Null
 * when the page has no such title.
 */
export function parseSpotifyPageArtists(html: string): string[] | null {
  const raw = /<title[^>]*>([\s\S]*?)<\/title>/iu.exec(html)?.[1];
  if (raw === undefined) return null;
  const title = decodeEntities(raw).replace(/\s+/gu, ' ').trim();
  const lower = title.toLowerCase();
  const by = lower.lastIndexOf(' by ');
  if (by < 0) return null;
  const end = lower.lastIndexOf(' | spotify');
  const credit = title.slice(by + ' by '.length, end > by ? end : undefined);
  const artists = credit
    .split(/\s*,\s*|\s+&\s+|\s+and\s+/iu)
    .map((artist) => artist.trim())
    .filter((artist) => artist !== '');
  return artists.length > 0 ? artists : null;
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
  private readonly titles = new Map<string, CacheEntry<string>>();
  private readonly artists = new Map<string, CacheEntry<string[]>>();

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
    if (!compared.ok) return { verdict: 'mismatch', title, reason: compared.reason };

    const artistName = request.artistName?.trim();
    if (!artistName) return { verdict: 'match' };
    const artists = await this.artistsFor(request.uri, id);
    if (artists === null) return { verdict: 'match' };
    const credited = compareArtists(artistName, artists);
    return credited.ok
      ? { verdict: 'match' }
      : { verdict: 'mismatch', title, reason: credited.reason };
  }

  /** Cached or fetched oEmbed title for the track, or an `unavailable` verdict. */
  private async titleFor(uri: string, id: string): Promise<string | Unavailable> {
    const cached = this.cached(this.titles, uri);
    if (cached !== undefined) return cached;

    const params = new URLSearchParams({ url: `https://open.spotify.com/track/${id}` });
    const result = await this.fetchLimited(
      `${this.baseUrl}/oembed?${params.toString()}`,
      { accept: 'application/json' },
      async (response) => {
        const body = (await response.json()) as unknown;
        const title =
          body && typeof body === 'object' ? (body as { title?: unknown }).title : undefined;
        return typeof title === 'string' && title.trim() !== ''
          ? { ok: true, value: title }
          : { ok: false, reason: 'no title' };
      },
    );
    if (result.ok) {
      this.remember(this.titles, uri, result.value);
      return result.value;
    }
    return this.unavailable('oembed', result.reason);
  }

  /** Cached or fetched artists the track page credits, or null when unknown. */
  private async artistsFor(uri: string, id: string): Promise<string[] | null> {
    const cached = this.cached(this.artists, uri);
    if (cached !== undefined) return cached;

    const result = await this.fetchLimited(
      `${this.baseUrl}/track/${id}`,
      {
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'en',
        'user-agent': BROWSER_USER_AGENT,
      },
      async (response) => {
        const artists = parseSpotifyPageArtists(await response.text());
        return artists
          ? { ok: true, value: artists }
          : { ok: false, reason: 'no artists in title' };
      },
    );
    if (result.ok) {
      this.remember(this.artists, uri, result.value);
      return result.value;
    }
    this.unavailable('track page', result.reason);
    return null;
  }

  /**
   * One limited, timed fetch; `read` parses an OK response's body.
   */
  private async fetchLimited<T>(
    url: string,
    headers: Record<string, string>,
    read: (response: Response) => Promise<Fetched<T>>,
  ): Promise<Fetched<T>> {
    if (!this.limiter.tryApply(SPOTIFY_OEMBED_SCOPE, LIMITER_KEY).ok) {
      return { ok: false, reason: 'rate limited' };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, { signal: controller.signal, headers });
      if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
      return await read(response);
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    } finally {
      clearTimeout(timer);
    }
  }

  private unavailable(source: string, reason: string): Unavailable {
    this.logger.warn(`[track-resolution] spotify ${source} unavailable: ${reason}`);
    return { verdict: 'unavailable', reason };
  }

  private cached<T>(cache: Map<string, CacheEntry<T>>, uri: string): T | undefined {
    const entry = cache.get(uri);
    if (entry && entry.expiresAtEpochMs > this.now()) return entry.value;
    if (entry) cache.delete(uri);
    return undefined;
  }

  private remember<T>(cache: Map<string, CacheEntry<T>>, uri: string, value: T): void {
    cache.set(uri, { expiresAtEpochMs: this.now() + CACHE_TTL_MS, value });
    while (cache.size > CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }
}
