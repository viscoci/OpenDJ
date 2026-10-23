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
 * - 503 `search_daily_limit` — the provider's daily search cap
 *   (`searchDailyLimit` per rolling 24h) is spent; body carries
 *   `retryAfterSec` (until the oldest unit of the day expires) + `Retry-After`
 *
 * A 200 carries `source: 'provider'` for a provider answer (live or cached).
 *
 * Search sources. `SEARCH_SOURCES` (default `provider,catalog`) lists where
 * answers come from, in order; the first source with at least one result
 * answers. A source that can't be asked (refusal, rate limit, error) or
 * finds nothing passes to the next one, except that a provider answer
 * (even an empty one) is final and a provider error (non-429) is a 502.
 * External sources (`deezer`, `sonovault`) answer `source: 'external'` with
 * `opendj:isrc:<ISRC>` track URIs (resolved to the provider when a guest
 * adds one), share the result cache below (keyed by source), spend no
 * provider budget or daily unit, and add their results to the catalog. A
 * cache miss to an external source spends one unit of the guest-or-anon
 * limit, at most once per request, after the same too-fast and early-retry
 * checks the provider uses; those refusals are returned at once. When every
 * source comes up empty the answer is a 200 with no results. Otherwise, when
 * nothing answered, the provider's refusal below is returned, or 503
 * `search_unavailable` (with `retryAfterSec` + `Retry-After`) when no
 * provider refusal applies and an external source couldn't be asked.
 *
 * Fall-through after a provider refusal. When a cache miss can't go to the
 * provider because the budget is busy, the daily cap is spent, or the
 * provider's search cooldown is open (or the provider answers 429 at call
 * time), the route asks the sources listed after `provider`, in order. A
 * `deezer` / `sonovault` answer is a normal `source: 'external'` 200 (full
 * quality, no notice). A local catalog answer (tracks seen in earlier
 * results or requested by guests) is 200 `{ results, providerId,
 * source: 'local', fallbackReason: 'busy' | 'daily_limit' |
 * 'provider_limited' }`, which the guest UI shows as limited results. The
 * guest-or-anon unit is spent at most once per request: a refused admission
 * spends none, and a provider 429 after admission has already spent it, so
 * the next external source spends no second one. When nothing after the
 * provider answers, the provider's refusal above is returned. Per-guest
 * `search_too_fast` and early-retry refusals return at once, before any later
 * source. With the default `provider,catalog` this is the local-catalog
 * fallback alone. Every successful provider call adds its results to the
 * catalog (fire-and-forget). With the default order the catalog is only
 * reached this way; placed before the provider, it answers `source: 'local'`
 * without a `fallbackReason`. Catalog rows minted by an external source are
 * hidden when a resolved row with the same ISRC also matches.
 *
 * Low-confidence escalation. An external source that reports confidence
 * (`searchWithConfidence`; today `deezer`, see `DEEZER_CONFIDENT_RANK`) may
 * answer not confident, e.g. Deezer has only covers of "Mr. Brightside".
 * When `provider` is listed after that source, the route then asks the
 * provider through the same admission (cooldown, budget, daily cap) with
 * the guest unit this request already spent, so the guest is charged once.
 * A provider answer is returned as a normal `source: 'provider'` 200 (and
 * cached under the provider key). If the provider can't be asked or fails
 * (busy, daily cap, cooldown, 429, error), the external answer is returned
 * as-is (`source: 'external'`, no `fallbackReason`). Each escalation logs
 * `[search] <source> low-confidence q=<q> → provider served|refused:<reason>`.
 * Caching: each source's answer is cached under its own key as usual. A
 * request whose external answer came from the cache (spending no guest unit)
 * only uses a cached or in-flight provider answer for the query and never
 * starts a provider call, so a low-confidence answer returned after a
 * refused escalation is reused until it expires (`SEARCH_CACHE_TTL_MS`), and
 * the next miss after that escalates again.
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
 * cooldown, peek the guest-or-anon limit, the budget, and the daily cap, then
 * spend all three and insert the in-flight promise. Two identical misses can
 * never both spend, and nothing is spent unless all three admit.
 *
 * Early retries pay. Each busy or too-fast refusal records the retry deadline
 * it handed out (including jitter) for its limiter key (a busy refusal only
 * when no local match was served; a daily-cap refusal records none). A cache miss from
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
import type { TrackCatalog } from '../catalog/TrackCatalog.js';
import { DEFAULT_SEARCH_SOURCES, type SearchPacingConfig, type SearchSourceId } from '../config.js';
import { createCatalogSearchSource } from '../search-sources/CatalogSearchSource.js';
import type {
  SearchSource,
  SearchSourceContext,
  SourceTrack,
} from '../search-sources/SearchSource.js';
import {
  ProviderConnectionNotFoundError,
  StreamingRouter,
  UnknownProviderError,
} from '../providers/streaming/StreamingRouter.js';
import {
  SEARCH_ANON_KEY,
  SEARCH_BUDGET_SCOPE,
  SEARCH_DAILY_SCOPE,
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
  /** Per-guest / anonymous limits, the per-provider search budget, and the daily cap. */
  searchRateLimiter: SlidingWindowRateLimiter;
  searchPacing: SearchPacingConfig;
  /** Local catalog for fallback answers. Without one, refusals are never softened. */
  trackCatalog?: Pick<TrackCatalog, 'recordSeen' | 'search'>;
  /** Server jitter added to our own refusal waits, in ms (clamped to 0-1500). Default random. */
  jitterMs?: () => number;
  /** Sources asked in order (`SEARCH_SOURCES`). Default `['provider', 'catalog']`. */
  searchSources?: ReadonlyArray<SearchSourceId>;
  /** External source implementations; a listed source without one is skipped. */
  externalSearchSources?: Partial<Record<ExternalSearchSourceId, SearchSource>>;
}

/** Sources other than the provider and the local catalog. */
export type ExternalSearchSourceId = Exclude<SearchSourceId, 'provider' | 'catalog'>;

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
/** Wait suggested by `search_unavailable` (an external source's rate window). */
const UNAVAILABLE_RETRY_MS = 5_000;

interface CachedSearch {
  expiresAtEpochMs: number;
  tracks: Promise<SourceTrack[]>;
}

/** Rejection of a cached external search whose source was unavailable. */
const SOURCE_UNAVAILABLE = Symbol('source_unavailable');

export type SearchResultDto = SourceTrack;

/** Where a 200's results came from. */
export type SearchResultSource = 'provider' | 'external' | 'local';

/** Tells the client to lengthen its search debounce for a while. */
export interface SearchSlowDownDto {
  debounceMs: number;
  ttlSec: number;
}

/** Why a local catalog answer was served instead of the provider's. */
export type SearchFallbackReason = 'busy' | 'daily_limit' | 'provider_limited';

type RefusalKind = 'search_too_fast' | 'search_busy';
/** A refusal that never gets local results (per-guest limits, early retries). */
type Refusal = { kind: RefusalKind; retryAfterSec: number };

type Admission =
  | { kind: 'search'; tracks: Promise<SourceTrack[]>; slowDown: SearchSlowDownDto | null }
  | Refusal
  /** The provider can't be asked right now; try the local catalog, else refuse. */
  | { kind: 'unavailable'; reason: SearchFallbackReason; retryAfterMs: number };

function trackToSource(track: Track): SourceTrack {
  return {
    trackUri: track.uri,
    trackName: track.name,
    artistName: track.artist,
    albumArtUrl: track.albumArt,
    durationMs: track.durationMs,
    ...(track.isrc !== undefined && { isrc: track.isrc }),
  };
}

function sourceToTrack(track: SourceTrack): Track {
  return {
    uri: track.trackUri,
    name: track.trackName,
    artist: track.artistName,
    albumArt: track.albumArtUrl,
    durationMs: track.durationMs ?? 0,
    ...(track.isrc !== undefined && { isrc: track.isrc }),
  };
}

/** Normalised query text for cache keys. */
function normalizeQuery(query: string): string {
  return query.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Whole seconds, at least 1. */
function waitSec(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
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
  const order = deps.searchSources ?? DEFAULT_SEARCH_SOURCES;
  const catalogSource = deps.trackCatalog ? createCatalogSearchSource(deps.trackCatalog) : null;
  /** Cached result arrays of external answers whose source was not confident. */
  const lowConfidenceResults = new WeakSet<SourceTrack[]>();

  /** The live cached or in-flight search for `key`; evicts an expired entry. */
  function lookupCached(key: string): Promise<SourceTrack[]> | null {
    const hit = cache.get(key);
    if (!hit) return null;
    if (hit.expiresAtEpochMs > Date.now()) return hit.tracks;
    cache.delete(key);
    return null;
  }

  /** Add `tracks` to the catalog under `providerId`; never throws. */
  function recordInCatalog(providerId: string, tracks: Track[]): void {
    try {
      deps.trackCatalog?.recordSeen(providerId, tracks);
    } catch (err) {
      console.error('[search] failed to record results in the track catalog', err);
    }
  }

  /**
   * Start `search` and cache its promise so identical queries share one
   * call. Results are added to the catalog under `providerId`. Rejected
   * promises are evicted so failures are never served from cache.
   */
  function startCachedSearch(
    key: string,
    providerId: string,
    search: () => Promise<SourceTrack[]>,
  ): Promise<SourceTrack[]> {
    const tracks = search();
    const entry: CachedSearch = { expiresAtEpochMs: Date.now() + SEARCH_CACHE_TTL_MS, tracks };
    cache.set(key, entry);
    tracks.then(
      (results) => recordInCatalog(providerId, results.map(sourceToTrack)),
      () => {
        if (cache.get(key) === entry) cache.delete(key);
      },
    );
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
  function refuse(kind: RefusalKind, limitKey: string, retryAfterMs: number): Refusal {
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
   * The guest-or-anon gate for a cache miss to an external source: the same
   * too-fast and early-retry refusals the provider admission applies, then
   * one unit spent. Synchronous, like `admit`.
   */
  function gateGuest(limitKey: string): Refusal | null {
    const guest = limiter.peekSync(SEARCH_SCOPE, limitKey);
    if (!guest.ok) return refuse('search_too_fast', limitKey, guest.retryAfterMs);
    const earlyByMs = retryDeadlines.remainingMs(limitKey);
    if (earlyByMs > 0) {
      limiter.tryApply(SEARCH_SCOPE, limitKey);
      return refuse('search_too_fast', limitKey, earlyByMs);
    }
    limiter.tryApply(SEARCH_SCOPE, limitKey);
    return null;
  }

  /**
   * Admit one cache miss. Synchronous on purpose: an await between the cache
   * re-check and the in-flight insert would let two identical misses both
   * spend budget. Cooldown is checked first (hardest block); a busy or
   * daily-cap answer never spends the guest's limit (an early retry is
   * charged instead), and a too-fast refusal never spends budget. Guest,
   * budget, and daily units are spent together or not at all. A request
   * that already passed the guest gate at an earlier external source
   * (`guestGated`) skips the guest checks and spends no second unit.
   */
  function admit(input: {
    cacheKey: string;
    accountId: string;
    providerId: string;
    limitKey: string;
    guestGated: boolean;
    search: () => Promise<SourceTrack[]>;
  }): Admission {
    const joined = lookupCached(input.cacheKey);
    if (joined) return { kind: 'search', tracks: joined, slowDown: peekSlowDown(input.providerId) };

    const until = deps.streamingRouter.rateLimitedUntil(
      input.accountId,
      input.providerId,
      'search',
    );
    if (until !== null) {
      return { kind: 'unavailable', reason: 'provider_limited', retryAfterMs: until - Date.now() };
    }

    if (!input.guestGated) {
      const guest = limiter.peekSync(SEARCH_SCOPE, input.limitKey);
      if (!guest.ok) {
        return refuse('search_too_fast', input.limitKey, guest.retryAfterMs);
      }
    }
    const budget = limiter.peekSync(SEARCH_BUDGET_SCOPE, input.providerId);
    const daily = limiter.peekSync(SEARCH_DAILY_SCOPE, input.providerId);
    const earlyByMs = input.guestGated ? 0 : retryDeadlines.remainingMs(input.limitKey);
    if (earlyByMs > 0) {
      // Retrying before the deadline we handed out costs the key one unit and
      // is never admitted, even if a budget slot has freed in the meantime.
      limiter.tryApply(SEARCH_SCOPE, input.limitKey);
      return budget.ok
        ? refuse('search_too_fast', input.limitKey, earlyByMs)
        : refuse('search_busy', input.limitKey, budget.retryAfterMs);
    }
    if (!daily.ok) {
      return { kind: 'unavailable', reason: 'daily_limit', retryAfterMs: daily.retryAfterMs };
    }
    if (!budget.ok) {
      return { kind: 'unavailable', reason: 'busy', retryAfterMs: budget.retryAfterMs };
    }

    if (!input.guestGated) limiter.tryApply(SEARCH_SCOPE, input.limitKey);
    limiter.tryApply(SEARCH_DAILY_SCOPE, input.providerId);
    const spent = limiter.tryApply(SEARCH_BUDGET_SCOPE, input.providerId);
    return {
      kind: 'search',
      tracks: startCachedSearch(input.cacheKey, input.providerId, input.search),
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

    const searchable = supportsSearch(provider) ? provider : null;
    if (!searchable && order.includes('provider')) {
      return c.json({ error: 'search_not_supported', providerId }, 501);
    }

    const query = parsed.output.q;
    const limit = parsed.output.limit ?? 20;
    const normalizedQuery = normalizeQuery(query);
    const ctx: SearchSourceContext = { accountId: session.accountId, providerId };
    const providerCacheKey = [session.accountId, providerId, limit, normalizedQuery].join('\u0000');
    const providerSearch = async (): Promise<SourceTrack[]> =>
      (await searchable!.search(query, limit)).map(trackToSource);

    let limitKey: string | null = null;
    const getLimitKey = async (): Promise<string> =>
      (limitKey ??= await resolveLimitKey(
        session.id,
        bearerFromAuthHeader(c.req.header('authorization')),
      ));
    /** Set once this request has spent its guest-or-anon unit. */
    let guestGated = false;
    /** Why the provider couldn't be asked, for a later catalog answer. */
    let fallbackReason: SearchFallbackReason | null = null;
    /** The provider's refusal, returned if no later source answers. */
    let providerRefusal: (() => Response) | null = null;
    /** The first source that was asked and found nothing. */
    let emptySource: SearchResultSource | null = null;
    /** Set when an external source couldn't be asked. */
    let externalUnavailable = false;

    const refusalResponse = (refusal: Refusal): Response => {
      c.header('Retry-After', String(refusal.retryAfterSec));
      return c.json(
        { error: refusal.kind, retryAfterSec: refusal.retryAfterSec },
        refusal.kind === 'search_too_fast' ? 429 : 503,
      );
    };

    /**
     * Ask the provider after a low-confidence external answer. Returns the
     * provider's 200, or null when the external answer should stand. Spends
     * provider budget only when this request already spent its guest unit
     * (`guestGated`), never a second guest unit.
     */
    const escalateToProvider = async (sourceId: SearchSourceId): Promise<Response | null> => {
      let tracks = lookupCached(providerCacheKey);
      let slowDown: SearchSlowDownDto | null = tracks ? peekSlowDown(providerId) : null;
      let outcome: string;
      if (!tracks) {
        // An external cache hit spent no guest unit: no new provider call.
        if (!guestGated) return null;
        // No awaits from here until the in-flight promise is inserted.
        const admission = admit({
          cacheKey: providerCacheKey,
          accountId: session.accountId,
          providerId,
          limitKey: limitKey ?? SEARCH_ANON_KEY,
          guestGated: true,
          search: providerSearch,
        });
        if (admission.kind === 'search') {
          tracks = admission.tracks;
          slowDown = admission.slowDown;
        } else {
          outcome = `refused:${admission.kind === 'unavailable' ? admission.reason : admission.kind}`;
        }
      }
      let response: Response | null = null;
      if (tracks) {
        try {
          const results = await tracks;
          response = c.json({
            results,
            providerId,
            source: 'provider',
            ...(slowDown && { slowDown }),
          });
          outcome = 'served';
        } catch (err) {
          outcome = `refused:${(err as { status?: number })?.status === 429 ? 'rate_limited' : 'error'}`;
        }
      }
      console.info(
        `[search] ${sourceId} low-confidence q=${normalizedQuery} → provider ${outcome!}`,
      );
      return response;
    };

    for (const sourceId of order) {
      if (sourceId === 'provider') {
        if (!searchable) continue;
        const cacheKey = providerCacheKey;
        // Fast path: a live cached or in-flight result skips the slot lookup
        // and never touches the limits.
        let tracks = lookupCached(cacheKey);
        let slowDown: SearchSlowDownDto | null;
        if (tracks) {
          slowDown = peekSlowDown(providerId);
        } else {
          const key = await getLimitKey();
          // No awaits from here until the in-flight promise is inserted.
          const admission = admit({
            cacheKey,
            accountId: session.accountId,
            providerId,
            limitKey: key,
            guestGated,
            search: providerSearch,
          });
          if (admission.kind === 'unavailable') {
            fallbackReason = admission.reason;
            providerRefusal = () => {
              switch (admission.reason) {
                case 'provider_limited': {
                  const retryAfterSec = waitSec(admission.retryAfterMs);
                  c.header('Retry-After', String(retryAfterSec));
                  return c.json({ error: 'provider_rate_limited', providerId, retryAfterSec }, 503);
                }
                case 'daily_limit': {
                  // No retry deadline: an early retry would lose its local fallback for hours.
                  const retryAfterSec = waitSec(admission.retryAfterMs);
                  c.header('Retry-After', String(retryAfterSec));
                  return c.json({ error: 'search_daily_limit', retryAfterSec }, 503);
                }
                case 'busy':
                  return refusalResponse(refuse('search_busy', key, admission.retryAfterMs));
              }
            };
            continue;
          }
          if (admission.kind !== 'search') return refusalResponse(admission);
          tracks = admission.tracks;
          slowDown = admission.slowDown;
          guestGated = true;
        }

        try {
          const results = await tracks;
          return c.json({ results, providerId, source: 'provider', ...(slowDown && { slowDown }) });
        } catch (err) {
          const rateLimit = err as { status?: number; retryAfterSec?: number | null };
          if (rateLimit?.status !== 429) {
            return c.json(
              { error: 'provider_error', providerId, message: (err as Error).message },
              502,
            );
          }
          fallbackReason = 'provider_limited';
          providerRefusal = () => {
            const retryAfterSec =
              typeof rateLimit.retryAfterSec === 'number' && rateLimit.retryAfterSec > 0
                ? rateLimit.retryAfterSec
                : null;
            if (retryAfterSec !== null) c.header('Retry-After', String(retryAfterSec));
            return c.json({ error: 'provider_rate_limited', providerId, retryAfterSec }, 503);
          };
          continue;
        }
      }

      if (sourceId === 'catalog') {
        if (!catalogSource) continue;
        const results = await catalogSource.search(query, limit, ctx);
        if (results === 'unavailable') continue;
        if (results.length > 0) {
          return c.json({
            results,
            providerId,
            source: 'local',
            ...(fallbackReason !== null && { fallbackReason }),
          });
        }
        emptySource ??= 'local';
        continue;
      }

      const source = deps.externalSearchSources?.[sourceId];
      if (!source) continue;
      const cacheKey = [`source:${sourceId}`, limit, normalizedQuery].join('\u0000');
      let tracks = lookupCached(cacheKey);
      if (!tracks && !guestGated) {
        const key = await getLimitKey();
        // No awaits from here until the in-flight promise is inserted.
        tracks = lookupCached(cacheKey);
        if (!tracks) {
          const refusal = gateGuest(key);
          if (refusal) return refusalResponse(refusal);
          guestGated = true;
        }
      }
      tracks ??= startCachedSearch(cacheKey, providerId, async () => {
        if (source.searchWithConfidence) {
          const answer = await source.searchWithConfidence(query, limit, ctx);
          if (answer === 'unavailable') throw SOURCE_UNAVAILABLE;
          // A fresh array: its identity carries the confidence flag in the cache.
          const tracks = [...answer.tracks];
          if (!answer.confident) lowConfidenceResults.add(tracks);
          return tracks;
        }
        const results = await source.search(query, limit, ctx);
        if (results === 'unavailable') throw SOURCE_UNAVAILABLE;
        return results;
      });
      let results: SourceTrack[];
      try {
        results = await tracks;
      } catch {
        externalUnavailable = true;
        continue;
      }
      if (results.length > 0) {
        if (
          searchable &&
          lowConfidenceResults.has(results) &&
          order.indexOf('provider') > order.indexOf(sourceId)
        ) {
          const escalated = await escalateToProvider(sourceId);
          if (escalated) return escalated;
        }
        return c.json({ results, providerId, source: 'external' });
      }
      emptySource ??= 'external';
    }

    if (providerRefusal) return providerRefusal();
    if (emptySource && !externalUnavailable) {
      return c.json({ results: [], providerId, source: emptySource });
    }
    const retryAfterSec = refusalWaitSec(UNAVAILABLE_RETRY_MS);
    c.header('Retry-After', String(retryAfterSec));
    return c.json({ error: 'search_unavailable', retryAfterSec }, 503);
  });

  return app;
}
