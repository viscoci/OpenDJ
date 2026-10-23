/**
 * Sonovault ISRC → streaming-platform links, as a track resolver. Only wired
 * when `SONOVAULT_API_KEY` is set.
 *
 * `GET https://api.sonovault.now/v1/tracks/links?isrc=<ISRC>` with header
 * `x-api-key` answers a `links` list of platform links. The shape is read
 * defensively: each link names its platform (`platform` / `name` /
 * `service` / `provider`) and carries an id (`id` / `trackId` / ...) or a
 * URL (`url` / `link` / ...); a `links` object keyed by platform works too.
 *
 * Platform names map to OpenDJ provider ids here (`spotify` → `spotify`,
 * `apple music` → `apple-music`); the native URI is built from the
 * provider's scheme in `@opendj/core`, so a provider without a known scheme
 * never resolves.
 *
 * Own limiter (scope `sonovault`, one deployment-wide key): 18 calls/min.
 * Answers are cached per ISRC, links for 24h and misses (404, no links) for
 * 10 min. A spent limiter, timeout (4s), network failure, or other HTTP error
 * is a miss that isn't cached.
 */

import { PROVIDER_TRACK_URI_SCHEMES, providerTrackUri } from '@opendj/core';
import { SlidingWindowRateLimiter } from '../rate-limit/SlidingWindowRateLimiter.js';
import type { TrackResolveRequest, TrackResolver } from './TrackResolver.js';

export const SONOVAULT_SCOPE = 'sonovault';
const SONOVAULT_KEY = 'global';
const DEFAULT_BASE_URL = 'https://api.sonovault.now';
const DEFAULT_TIMEOUT_MS = 4_000;
const RATE_LIMIT_PER_MIN = 18;
const HIT_TTL_MS = 24 * 60 * 60_000;
const MISS_TTL_MS = 10 * 60_000;
const CACHE_MAX_ENTRIES = 2_000;

/** Normalised Sonovault platform name → OpenDJ provider id. */
const PLATFORM_PROVIDERS: Readonly<Record<string, string>> = {
  spotify: 'spotify',
  applemusic: 'apple-music',
};

const NAME_FIELDS = ['platform', 'name', 'service', 'provider', 'source'] as const;
const ID_FIELDS = [
  'external_id',
  'externalId',
  'id',
  'trackId',
  'platformId',
  'platform_id',
] as const;
const URL_FIELDS = ['url', 'link', 'href', 'uri'] as const;

/** One platform's link: an id and/or a URL. */
interface PlatformLink {
  id: string | null;
  url: string | null;
}

interface CacheEntry {
  expiresAtEpochMs: number;
  /** Provider id → link. Empty for a miss. */
  links: Map<string, PlatformLink>;
}

export interface SonovaultTrackResolverOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
  now?: () => number;
  logger?: Pick<Console, 'warn'>;
}

function firstString(
  record: Record<string, unknown>,
  fields: ReadonlyArray<string>,
): string | null {
  for (const field of fields) {
    const value = record[field];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function providerForPlatform(name: string): string | null {
  return PLATFORM_PROVIDERS[name.toLowerCase().replace(/[^a-z0-9]/g, '')] ?? null;
}

function linkFrom(value: unknown): PlatformLink | null {
  if (typeof value === 'string' && value.trim() !== '') return { id: null, url: value.trim() };
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const link = { id: firstString(record, ID_FIELDS), url: firstString(record, URL_FIELDS) };
  return link.id !== null || link.url !== null ? link : null;
}

/** Provider id → link, from either a list of links or an object keyed by platform. */
function parseLinks(body: unknown): Map<string, PlatformLink> {
  const links = new Map<string, PlatformLink>();
  const raw = body && typeof body === 'object' ? (body as { links?: unknown }).links : undefined;
  const add = (platform: string | null, value: unknown) => {
    const providerId = platform === null ? null : providerForPlatform(platform);
    const link = linkFrom(value);
    if (providerId !== null && link !== null && !links.has(providerId)) links.set(providerId, link);
  };
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      add(firstString(item as Record<string, unknown>, NAME_FIELDS), item);
    }
  } else if (raw && typeof raw === 'object') {
    for (const [platform, value] of Object.entries(raw as Record<string, unknown>)) {
      add(platform, value);
    }
  }
  return links;
}

/** The native URI for `providerId` from a link's id or URL, or null. */
function nativeUri(providerId: string, link: PlatformLink): string | null {
  const known = PROVIDER_TRACK_URI_SCHEMES[providerId];
  if (!known) return null;
  for (const candidate of [link.id, link.url]) {
    if (candidate === null) continue;
    if (candidate.startsWith(known.trackPrefix)) return candidate;
    const fromPath = /\/track\/([A-Za-z0-9]+)/.exec(candidate)?.[1];
    if (fromPath) return providerTrackUri(providerId, fromPath);
    if (/^[A-Za-z0-9]+$/.test(candidate)) return providerTrackUri(providerId, candidate);
  }
  return null;
}

export class SonovaultTrackResolver implements TrackResolver {
  readonly id = 'sonovault';
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly logger: Pick<Console, 'warn'>;
  private readonly limiter: SlidingWindowRateLimiter;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(options: SonovaultTrackResolverOptions) {
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? console;
    this.limiter = new SlidingWindowRateLimiter({
      now: this.now,
      scopes: { [SONOVAULT_SCOPE]: { limit: RATE_LIMIT_PER_MIN, windowMs: 60_000 } },
    });
  }

  async resolve(request: TrackResolveRequest): Promise<string | null> {
    const links = await this.linksFor(request.isrc);
    const link = links?.get(request.providerId);
    return link ? nativeUri(request.providerId, link) : null;
  }

  /** Cached or fetched links for `isrc`; null on an uncached failure. */
  private async linksFor(isrc: string): Promise<Map<string, PlatformLink> | null> {
    const cached = this.cache.get(isrc);
    if (cached && cached.expiresAtEpochMs > this.now()) return cached.links;
    if (cached) this.cache.delete(isrc);

    if (!this.limiter.tryApply(SONOVAULT_SCOPE, SONOVAULT_KEY).ok) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const params = new URLSearchParams({ isrc });
      const response = await this.fetchImpl(
        `${this.baseUrl}/v1/tracks/links?${params.toString()}`,
        {
          signal: controller.signal,
          headers: { 'x-api-key': this.apiKey, accept: 'application/json' },
        },
      );
      if (response.status === 404) return this.remember(isrc, new Map());
      if (!response.ok) {
        this.logger.warn(`[track-resolution] sonovault answered HTTP ${response.status}`);
        return null;
      }
      return this.remember(isrc, parseLinks(await response.json()));
    } catch (err) {
      this.logger.warn(`[track-resolution] sonovault lookup failed: ${(err as Error).message}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private remember(isrc: string, links: Map<string, PlatformLink>): Map<string, PlatformLink> {
    const ttl = links.size > 0 ? HIT_TTL_MS : MISS_TTL_MS;
    this.cache.set(isrc, { expiresAtEpochMs: this.now() + ttl, links });
    while (this.cache.size > CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return links;
  }
}
