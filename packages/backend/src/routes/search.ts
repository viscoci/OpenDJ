/**
 * `/api/v1/sessions/:id/search` — track search proxied through the session's
 * connected streaming provider.
 *
 * Public (no auth required) — guests need to search to make requests. The
 * route resolves the session, looks up the account's connected provider,
 * type-guards for `ISupportsSearch`, and forwards the query.
 *
 * Errors:
 * - 404 `session_not_found` / `session_ended`
 * - 503 `no_provider_connected` — account has no streaming provider linked yet
 * - 501 `search_not_supported` — provider connected, but doesn't implement search
 *   (e.g. AppleMusic stub) — type guard prevents the call from happening
 * - 502 `provider_error` — search failed at the provider edge
 * - 503 `provider_rate_limited` — the provider is throttling the host's
 *   account; body carries `retryAfterSec` (also sent as `Retry-After`)
 *
 * Results are cached per (account, provider, query, limit) for
 * `SEARCH_CACHE_TTL_MS`, and identical in-flight queries share one provider
 * call — guests at the same party type the same song names, and every
 * provider call counts against the host's Spotify quota.
 */

import { Hono } from 'hono';
import * as v from 'valibot';
import { InvalidProviderCredentialsError, supportsSearch, type Track } from '@opendj/core';
import {
  ProviderConnectionNotFoundError,
  StreamingRouter,
  UnknownProviderError,
} from '../providers/streaming/StreamingRouter.js';
import type { ProviderConnectionRepository, SessionRepository } from '../repositories/types.js';

export interface SearchRouteDeps {
  sessions: SessionRepository;
  providerConnections: ProviderConnectionRepository;
  streamingRouter: StreamingRouter;
}

const QuerySchema = v.object({
  q: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(50))),
});

/** How long a successful search result is reused. */
const SEARCH_CACHE_TTL_MS = 60_000;
/** Upper bound on cached queries; oldest entries are evicted first. */
const SEARCH_CACHE_MAX_ENTRIES = 500;

interface CachedSearch {
  expiresAtEpochMs: number;
  tracks: Promise<Track[]>;
}

export interface SearchResultDto {
  trackUri: string;
  trackName: string;
  artistName: string;
  albumArtUrl: string | null;
  durationMs: number | null;
}

function toDto(track: Track): SearchResultDto {
  return {
    trackUri: track.uri,
    trackName: track.name,
    artistName: track.artist,
    albumArtUrl: track.albumArt,
    durationMs: track.durationMs,
  };
}

export function searchRoutes(deps: SearchRouteDeps): Hono {
  const app = new Hono();
  const cache = new Map<string, CachedSearch>();

  /**
   * Run `search` once per cache key per TTL. The promise itself is cached so
   * concurrent identical queries share a single provider call; rejected
   * promises are evicted so failures are never served from cache.
   */
  function cachedSearch(key: string, search: () => Promise<Track[]>): Promise<Track[]> {
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && hit.expiresAtEpochMs > now) return hit.tracks;
    if (hit) cache.delete(key);

    const tracks = search();
    const entry: CachedSearch = { expiresAtEpochMs: now + SEARCH_CACHE_TTL_MS, tracks };
    cache.set(key, entry);
    tracks.catch(() => {
      if (cache.get(key) === entry) cache.delete(key);
    });
    while (cache.size > SEARCH_CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    return tracks;
  }

  app.get('/', async (c) => {
    const sessionId = c.req.param('id') ?? '';
    const session = await deps.sessions.findById(sessionId);
    if (!session) return c.json({ error: 'session_not_found' }, 404);
    if (session.endedAt) return c.json({ error: 'session_ended' }, 404);

    const limitRaw = c.req.query('limit');
    const parsed = v.safeParse(QuerySchema, {
      q: c.req.query('q') ?? '',
      ...(limitRaw !== undefined && { limit: Number.parseInt(limitRaw, 10) }),
    });
    if (!parsed.success) {
      return c.json({ error: 'invalid_query', issues: parsed.issues.map((i) => i.message) }, 400);
    }

    // Pick any connection on the account — first match wins. A future
    // multi-provider preference order lives here.
    const connections = await deps.providerConnections.findAllForAccount(session.accountId);
    const connection = connections[0];
    if (!connection) return c.json({ error: 'no_provider_connected' }, 503);

    let provider;
    try {
      provider = await deps.streamingRouter.getProvider(session.accountId, connection.providerId);
    } catch (err) {
      if (err instanceof UnknownProviderError) {
        return c.json({ error: 'unknown_provider', providerId: connection.providerId }, 502);
      }
      if (err instanceof ProviderConnectionNotFoundError) {
        return c.json({ error: 'no_provider_connected' }, 503);
      }
      if (err instanceof InvalidProviderCredentialsError) {
        return c.json({ error: 'provider_credentials_invalid' }, 502);
      }
      throw err;
    }

    if (!supportsSearch(provider)) {
      return c.json({ error: 'search_not_supported', providerId: connection.providerId }, 501);
    }

    const query = parsed.output.q;
    const limit = parsed.output.limit ?? 20;
    const cacheKey = [
      session.accountId,
      connection.providerId,
      limit,
      query.trim().replace(/\s+/g, ' ').toLowerCase(),
    ].join('\u0000');
    try {
      const tracks = await cachedSearch(cacheKey, () => provider.search(query, limit));
      return c.json({
        results: tracks.map(toDto),
        providerId: connection.providerId,
      });
    } catch (err) {
      const rateLimit = err as { status?: number; retryAfterSec?: number | null };
      if (rateLimit?.status === 429) {
        const retryAfterSec =
          typeof rateLimit.retryAfterSec === 'number' && rateLimit.retryAfterSec > 0
            ? rateLimit.retryAfterSec
            : null;
        if (retryAfterSec !== null) c.header('Retry-After', String(retryAfterSec));
        return c.json(
          {
            error: 'provider_rate_limited',
            providerId: connection.providerId,
            retryAfterSec,
          },
          503,
        );
      }
      return c.json(
        {
          error: 'provider_error',
          providerId: connection.providerId,
          message: (err as Error).message,
        },
        502,
      );
    }
  });

  return app;
}
