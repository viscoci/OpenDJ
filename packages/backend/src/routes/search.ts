/**
 * `/api/v1/sessions/:id/search` — track search proxied through the session's
 * connected streaming provider.
 *
 * Optional guest auth — guests need to search to make requests. A caller may
 * send `Authorization: Bearer <slotToken>`; a slot in this session (active or
 * queued) is limited per guest. A missing, unknown, or other-session token is
 * never a 401: it falls into one shared anonymous limit. The route resolves
 * the session, looks up the account's connected provider, type-guards for
 * `ISupportsSearch`, and forwards the query.
 *
 * Errors:
 * - 404 `session_not_found` / `session_ended`
 * - 503 `no_provider_connected` — account has no streaming provider linked yet
 * - 501 `search_not_supported` — provider connected, but doesn't implement search
 *   (e.g. AppleMusic stub) — type guard prevents the call from happening
 * - 502 `provider_error` — search failed at the provider edge
 * - 503 `provider_rate_limited` — the provider is throttling the host's
 *   account; body carries `retryAfterSec` (also sent as `Retry-After`)
 * - 429 `search_too_fast` — this guest (or the shared anonymous bucket) is
 *   over its search limit; body carries `retryAfterSec` + `Retry-After`
 * - 503 `search_busy` — the search budget for the provider's API key is spent;
 *   body carries `retryAfterSec` + `Retry-After`
 *
 * Clients branch on `error`, not the status. Our own refusal waits add 0-1.5s
 * of server jitter so refused clients don't retry in lockstep.
 *
 * Results are cached per (account, provider, query, limit) for
 * `SEARCH_CACHE_TTL_MS`, and identical in-flight queries share one provider
 * call — guests at the same party type the same song names, and every
 * provider call counts against the host's Spotify quota. Cache hits and
 * joined in-flight searches never spend, and are never refused by, the limits.
 *
 * A cache miss is admitted in one synchronous step after every async lookup:
 * re-check the cache (joining any in-flight search), check the Spotify
 * cooldown, peek the guest-or-anon limit and the budget, then spend both and
 * insert the in-flight promise. Two identical misses can never both spend.
 *
 * Early retries pay. Each busy or too-fast refusal records the retry deadline
 * it handed out (including jitter) for its limiter key. A cache miss from
 * that key that arrives before the deadline is refused (`search_busy` while the
 * budget is spent, else `search_too_fast` until the deadline) and spends one
 * unit of the key's own search limit, so a client that ignores
 * `retryAfterSec` soon gets `search_too_fast` for the rest of the window and
 * never wins a freed budget slot ahead of its deadline. A client that waits out its deadline is
 * never charged for a refusal, and a busy refusal still never spends an honest
 * guest's limit. Cache hits and in-flight joins are exempt.
 *
 * A 200 carries `slowDown: { debounceMs, ttlSec }` when the budget's remaining
 * calls are at or below `searchSlowDownThresholdPct` of its limit. It is
 * computed per response and never cached.
 *
 * Pacing state is in-memory: on Cloudflare Workers each isolate gets its own
 * budget, limits, and result cache.
 */

import { Hono } from 'hono';
import * as v from 'valibot';
import { InvalidProviderCredentialsError, supportsSearch, type Track } from '@opendj/core';
import type { SearchPacingConfig } from '../config.js';
import {
  ProviderConnectionNotFoundError,
  StreamingRouter,
  UnknownProviderError,
} from '../providers/streaming/StreamingRouter.js';
import {
  SEARCH_ANON_KEY,
  SEARCH_BUDGET_SCOPE,
  SEARCH_SCOPE,
  searchGuestKey,
  type SlidingWindowRateLimiter,
} from '../rate-limit/SlidingWindowRateLimiter.js';
import { RetryDeadlines } from '../rate-limit/RetryDeadlines.js';
import type {
  GuestSlotRepository,
  ProviderConnectionRepository,
  SessionRepository,
} from '../repositories/types.js';
import { bearerFromAuthHeader } from './bearer.js';

export interface SearchRouteDeps {
  sessions: SessionRepository;
  providerConnections: ProviderConnectionRepository;
  streamingRouter: StreamingRouter;
  /** Resolves the optional bearer slot token to a guest identity. */
  guestSlots: Pick<GuestSlotRepository, 'findBySlotToken'>;
  /** Per-guest / anonymous limits and the per-provider search budget. */
  searchRateLimiter: SlidingWindowRateLimiter;
  searchPacing: SearchPacingConfig;
  /** Server jitter added to our own refusal waits, in ms (clamped to 0-1500). Default random. */
  jitterMs?: () => number;
}

const QuerySchema = v.object({
  q: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(50))),
});

/** How long a successful search result is reused. */
const SEARCH_CACHE_TTL_MS = 60_000;
/** Upper bound on cached queries; oldest entries are evicted first. */
const SEARCH_CACHE_MAX_ENTRIES = 500;
/** Upper bound on the server jitter added to our own refusal waits. */
const MAX_REFUSAL_JITTER_MS = 1_500;

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

/** Tells the client to lengthen its search debounce for a while. */
export interface SearchSlowDownDto {
  debounceMs: number;
  ttlSec: number;
}

type Admission =
  | { kind: 'search'; tracks: Promise<Track[]>; slowDown: SearchSlowDownDto | null }
  | {
      kind: 'provider_rate_limited' | 'search_too_fast' | 'search_busy';
      retryAfterSec: number;
    };

function toDto(track: Track): SearchResultDto {
  return {
    trackUri: track.uri,
    trackName: track.name,
    artistName: track.artist,
    albumArtUrl: track.albumArt,
    durationMs: track.durationMs,
  };
}

function randomJitterMs(): number {
  return Math.random() * MAX_REFUSAL_JITTER_MS;
}

export function searchRoutes(deps: SearchRouteDeps): Hono {
  const app = new Hono();
  const cache = new Map<string, CachedSearch>();
  const limiter = deps.searchRateLimiter;
  const pacing = deps.searchPacing;
  const jitterMs = deps.jitterMs ?? randomJitterMs;
  const retryDeadlines = new RetryDeadlines();

  /** The live cached or in-flight search for `key`; evicts an expired entry. */
  function lookupCached(key: string): Promise<Track[]> | null {
    const hit = cache.get(key);
    if (!hit) return null;
    if (hit.expiresAtEpochMs > Date.now()) return hit.tracks;
    cache.delete(key);
    return null;
  }

  /**
   * Start `search` and cache its promise so identical queries share one
   * provider call. Rejected promises are evicted so failures are never served
   * from cache.
   */
  function startCachedSearch(key: string, search: () => Promise<Track[]>): Promise<Track[]> {
    const tracks = search();
    const entry: CachedSearch = { expiresAtEpochMs: Date.now() + SEARCH_CACHE_TTL_MS, tracks };
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

  /** The slow-down hint for a budget with `remaining` of `limit` calls left, if due. */
  function slowDownFor(remaining: number, limit: number): SearchSlowDownDto | null {
    if (pacing.searchSlowDownThresholdPct === 0) return null;
    if (remaining * 100 > limit * pacing.searchSlowDownThresholdPct) return null;
    return { debounceMs: pacing.searchSlowDownDebounceMs, ttlSec: pacing.searchSlowDownTtlSec };
  }

  function peekSlowDown(providerId: string): SearchSlowDownDto | null {
    const budget = limiter.peekSync(SEARCH_BUDGET_SCOPE, providerId);
    return slowDownFor(budget.remaining, budget.limit);
  }

  /** Our own refusal wait in whole seconds: the limiter's wait plus jitter. */
  function refusalWaitSec(retryAfterMs: number): number {
    const jitter = Math.min(MAX_REFUSAL_JITTER_MS, Math.max(0, jitterMs()));
    return Math.max(1, Math.ceil((retryAfterMs + jitter) / 1000));
  }

  /** Refuse `limitKey` and remember the deadline it was given. */
  function refuse(
    kind: 'search_too_fast' | 'search_busy',
    limitKey: string,
    retryAfterMs: number,
  ): Admission {
    const retryAfterSec = refusalWaitSec(retryAfterMs);
    retryDeadlines.record(limitKey, Date.now() + retryAfterSec * 1000);
    return { kind, retryAfterSec };
  }

  /** Limiter key for the optional slot token: a slot in this session, else `anon`. */
  async function resolveLimitKey(sessionId: string, slotToken: string | null): Promise<string> {
    if (!slotToken) return SEARCH_ANON_KEY;
    const slot = await deps.guestSlots.findBySlotToken(slotToken);
    if (!slot || slot.sessionId !== sessionId) return SEARCH_ANON_KEY;
    return searchGuestKey(slot.id);
  }

  /**
   * Admit one cache miss. Synchronous on purpose: an await between the cache
   * re-check and the in-flight insert would let two identical misses both
   * spend budget. Cooldown is checked first (hardest block); a busy refusal
   * never spends the guest's limit (an early retry is charged instead), and a
   * too-fast refusal never spends budget.
   */
  function admit(input: {
    cacheKey: string;
    accountId: string;
    providerId: string;
    limitKey: string;
    search: () => Promise<Track[]>;
  }): Admission {
    const joined = lookupCached(input.cacheKey);
    if (joined) return { kind: 'search', tracks: joined, slowDown: peekSlowDown(input.providerId) };

    const until = deps.streamingRouter.rateLimitedUntil(
      input.accountId,
      input.providerId,
      'search',
    );
    if (until !== null) {
      return {
        kind: 'provider_rate_limited',
        retryAfterSec: Math.max(1, Math.ceil((until - Date.now()) / 1000)),
      };
    }

    const guest = limiter.peekSync(SEARCH_SCOPE, input.limitKey);
    if (!guest.ok) {
      return refuse('search_too_fast', input.limitKey, guest.retryAfterMs);
    }
    const budget = limiter.peekSync(SEARCH_BUDGET_SCOPE, input.providerId);
    const earlyByMs = retryDeadlines.remainingMs(input.limitKey);
    if (earlyByMs > 0) {
      // Retrying before the deadline we handed out costs the key one unit and
      // is never admitted, even if a budget slot has freed in the meantime.
      limiter.tryApply(SEARCH_SCOPE, input.limitKey);
      return budget.ok
        ? refuse('search_too_fast', input.limitKey, earlyByMs)
        : refuse('search_busy', input.limitKey, budget.retryAfterMs);
    }
    if (!budget.ok) {
      return refuse('search_busy', input.limitKey, budget.retryAfterMs);
    }

    limiter.tryApply(SEARCH_SCOPE, input.limitKey);
    const spent = limiter.tryApply(SEARCH_BUDGET_SCOPE, input.providerId);
    return {
      kind: 'search',
      tracks: startCachedSearch(input.cacheKey, input.search),
      slowDown: slowDownFor(spent.remaining, spent.limit),
    };
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
    const providerId = connection.providerId;

    // Must complete before admission: loading the provider is what brings the
    // connection's cooldown into the router.
    let provider;
    try {
      provider = await deps.streamingRouter.getProvider(session.accountId, providerId);
    } catch (err) {
      if (err instanceof UnknownProviderError) {
        return c.json({ error: 'unknown_provider', providerId }, 502);
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
      return c.json({ error: 'search_not_supported', providerId }, 501);
    }

    const query = parsed.output.q;
    const limit = parsed.output.limit ?? 20;
    const cacheKey = [
      session.accountId,
      providerId,
      limit,
      query.trim().replace(/\s+/g, ' ').toLowerCase(),
    ].join('\u0000');

    // Fast path: a live cached or in-flight result skips the slot lookup and
    // never touches the limits.
    let tracks = lookupCached(cacheKey);
    let slowDown: SearchSlowDownDto | null;
    if (tracks) {
      slowDown = peekSlowDown(providerId);
    } else {
      const limitKey = await resolveLimitKey(
        session.id,
        bearerFromAuthHeader(c.req.header('authorization')),
      );
      // No awaits from here until the in-flight promise is inserted.
      const admission = admit({
        cacheKey,
        accountId: session.accountId,
        providerId,
        limitKey,
        search: () => provider.search(query, limit),
      });
      if (admission.kind !== 'search') {
        const { retryAfterSec } = admission;
        c.header('Retry-After', String(retryAfterSec));
        switch (admission.kind) {
          case 'provider_rate_limited':
            return c.json({ error: admission.kind, providerId, retryAfterSec }, 503);
          case 'search_too_fast':
            return c.json({ error: admission.kind, retryAfterSec }, 429);
          case 'search_busy':
            return c.json({ error: admission.kind, retryAfterSec }, 503);
        }
      }
      tracks = admission.tracks;
      slowDown = admission.slowDown;
    }

    try {
      const results = (await tracks).map(toDto);
      return c.json({ results, providerId, ...(slowDown && { slowDown }) });
    } catch (err) {
      const rateLimit = err as { status?: number; retryAfterSec?: number | null };
      if (rateLimit?.status === 429) {
        const retryAfterSec =
          typeof rateLimit.retryAfterSec === 'number' && rateLimit.retryAfterSec > 0
            ? rateLimit.retryAfterSec
            : null;
        if (retryAfterSec !== null) c.header('Retry-After', String(retryAfterSec));
        return c.json({ error: 'provider_rate_limited', providerId, retryAfterSec }, 503);
      }
      return c.json({ error: 'provider_error', providerId, message: (err as Error).message }, 502);
    }
  });

  return app;
}
