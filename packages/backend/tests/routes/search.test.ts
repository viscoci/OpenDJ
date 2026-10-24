/**
 * /api/v1/sessions/:id/search — search proxy route.
 *
 * Uses a hand-rolled mock provider implementing IStreamingProvider +
 * ISupportsSearch. No real network calls.
 *
 * Pacing tests use small limits so each describe can drive the budget, the
 * per-guest limit, and the anonymous limit to their edges directly.
 */

import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  defineCapabilities,
  PROVIDER_FEATURES,
  type IStreamingProvider,
  type ISupportsSearch,
  type ProviderCapabilities,
  type ProviderCredentials,
  type Track,
} from '@opendj/core';
import {
  InMemoryGuestSlotRepository,
  InMemoryProviderConnectionRepository,
  InMemoryQueueItemRepository,
  InMemorySessionRepository,
  InMemoryTrackCatalogRepository,
} from '../../src/repositories/in-memory/index.js';
import { TrackCatalog } from '../../src/catalog/TrackCatalog.js';
import { searchRoutes } from '../../src/routes/search.js';
import { DEFAULT_SEARCH_PACING, type SearchPacingConfig } from '../../src/config.js';
import {
  createSearchRateLimiter,
  SEARCH_ANON_KEY,
  SEARCH_BUDGET_SCOPE,
  SEARCH_DAILY_SCOPE,
  SEARCH_SCOPE,
  searchGuestKey,
} from '../../src/rate-limit/SlidingWindowRateLimiter.js';
import {
  ProviderCooldowns,
  ProviderRateLimitedError,
} from '../../src/providers/streaming/ProviderCooldowns.js';
import { StreamingRouter } from '../../src/providers/streaming/StreamingRouter.js';
import type { ProviderRegistry } from '../../src/providers/streaming/providerRegistry.js';

class MockSearchProvider implements IStreamingProvider, ISupportsSearch {
  readonly providerId = 'mock-streamer';
  readonly displayName = 'Mock Streamer';
  private connected = false;
  private lastQuery: string | null = null;
  private resultsToReturn: Track[] = [];
  /** Number of search calls that reached the provider. */
  calls = 0;
  /** When set, the next search calls reject with this error. */
  failWith: Error | null = null;

  async connect(_credentials: ProviderCredentials): Promise<void> {
    this.connected = true;
  }
  async disconnect(): Promise<void> {
    this.connected = false;
  }
  isConnected(): boolean {
    return this.connected;
  }
  async refreshCredentials(): Promise<ProviderCredentials> {
    return { accessToken: 'mock' };
  }
  getCapabilities(): ProviderCapabilities {
    return defineCapabilities('mock-streamer', {
      [PROVIDER_FEATURES.Search]: {
        id: PROVIDER_FEATURES.Search,
        supported: true,
        access: 'guest',
        reliability: 'native',
      },
    });
  }
  /** When set, searches wait on this promise before answering. */
  gate: Promise<void> | null = null;

  async search(query: string, limit = 20): Promise<Track[]> {
    this.calls += 1;
    if (this.gate) await this.gate;
    if (this.failWith) throw this.failWith;
    this.lastQuery = query;
    return this.resultsToReturn.slice(0, limit);
  }
  setResults(tracks: Track[]): void {
    this.resultsToReturn = tracks;
  }
  getLastQuery(): string | null {
    return this.lastQuery;
  }
}

class NoSearchProvider implements IStreamingProvider {
  readonly providerId = 'mute-provider';
  readonly displayName = 'Mute';
  private connected = false;
  async connect(_credentials: ProviderCredentials): Promise<void> {
    this.connected = true;
  }
  async disconnect(): Promise<void> {
    this.connected = false;
  }
  isConnected(): boolean {
    return this.connected;
  }
  async refreshCredentials(): Promise<ProviderCredentials> {
    return { accessToken: 'mock' };
  }
  getCapabilities(): ProviderCapabilities {
    return defineCapabilities('mute-provider', {});
  }
}

const SAMPLE_TRACKS: Track[] = [
  {
    uri: 'mock:track:1',
    name: 'First Song',
    artist: 'Test Artist',
    albumArt: 'https://cdn.test/a.jpg',
    durationMs: 180_000,
  },
  {
    uri: 'mock:track:2',
    name: 'Second Song',
    artist: 'Other Artist',
    albumArt: null,
    durationMs: 200_000,
  },
];

function buildHarness(
  opts: {
    provider?: 'mock-streamer' | 'mute-provider';
    noConnection?: boolean;
    noSession?: boolean;
    pacing?: Partial<SearchPacingConfig>;
    cooldowns?: ProviderCooldowns;
    jitterMs?: () => number;
  } = {},
) {
  const sessions = new InMemorySessionRepository();
  const providerConnections = new InMemoryProviderConnectionRepository();
  const guestSlots = new InMemoryGuestSlotRepository();
  const pacing: SearchPacingConfig = { ...DEFAULT_SEARCH_PACING, ...opts.pacing };
  // Read Date.now per call so vi fake timers move the limiter clock too.
  const limiter = createSearchRateLimiter(pacing, () => Date.now());

  const mockProvider = new MockSearchProvider();
  mockProvider.setResults(SAMPLE_TRACKS);
  const muteProvider = new NoSearchProvider();
  const catalogRepo = new InMemoryTrackCatalogRepository();
  const catalog = new TrackCatalog({
    repository: catalogRepo,
    queueItems: new InMemoryQueueItemRepository(),
    sessions,
    providerConnections,
  });
  const registry: ProviderRegistry = {
    'mock-streamer': () => mockProvider,
    'mute-provider': () => muteProvider,
  } as unknown as ProviderRegistry;

  const router = new StreamingRouter({
    providerConnections,
    registry,
    context: { fetch: globalThis.fetch },
    ...(opts.cooldowns && { cooldowns: opts.cooldowns }),
  });

  const sessionId = 'sess-search-1';
  const accountId = 'acc-search-1';
  if (!opts.noSession) {
    sessions.seed({
      id: sessionId,
      accountId,
      name: 'Search Test',
      qrSlug: 'search-test',
      guestCapOverride: null,
      songsPerGuestCap: 3,
      maxConsecutivePerGuest: null,
      moderationEnabled: false,
      voteSkipMode: 'fixed',
      voteSkipThreshold: 5,
      karaokeMode: 'off',
      karaokeMicCount: 1,
      karaokePauseMode: 'manual',
      karaokePauseTimeoutSec: 30,
      startedAt: new Date(),
      endedAt: null,
    });
  }
  if (!opts.noConnection) {
    void providerConnections.upsert({
      accountId,
      providerId: opts.provider ?? 'mock-streamer',
      accessToken: 'access-tok-mock',
    });
  }

  const app = new Hono();
  app.route(
    '/sessions/:id/search',
    searchRoutes({
      sessions,
      providerConnections,
      streamingRouter: router,
      guestSlots,
      searchRateLimiter: limiter,
      searchPacing: pacing,
      trackCatalog: catalog,
      jitterMs: opts.jitterMs ?? (() => 0),
    }),
  );

  async function addGuest(
    token: string,
    input: { sessionId?: string; status?: 'active' | 'queued' } = {},
  ): Promise<string> {
    const slot = await guestSlots.create({
      sessionId: input.sessionId ?? sessionId,
      fingerprintHash: `fp-${token}`,
      slotToken: token,
      status: input.status ?? 'active',
    });
    return slot.id;
  }

  function search(q: string, token?: string): Promise<Response> {
    return Promise.resolve(
      app.request(`http://x/sessions/${sessionId}/search?q=${encodeURIComponent(q)}`, {
        ...(token !== undefined && { headers: { authorization: `Bearer ${token}` } }),
      }),
    );
  }

  /** Put `tracks` into the local catalog as if a provider search had returned them. */
  async function seedCatalog(tracks: Track[] = SAMPLE_TRACKS): Promise<void> {
    catalog.recordSeen('mock-streamer', tracks);
    await catalog.whenIdle();
  }

  return {
    app,
    sessionId,
    accountId,
    mockProvider,
    limiter,
    catalog,
    catalogRepo,
    addGuest,
    search,
    seedCatalog,
  };
}

function budgetRemaining(limiter: ReturnType<typeof createSearchRateLimiter>): number {
  return limiter.peekSync(SEARCH_BUDGET_SCOPE, 'mock-streamer').remaining;
}

describe('GET /sessions/:id/search', () => {
  it('returns search results from the connected provider', async () => {
    const { app, sessionId, mockProvider } = buildHarness();
    const res = await app.request(`http://x/sessions/${sessionId}/search?q=hello%20world`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: ReadonlyArray<unknown>; providerId: string };
    expect(body.providerId).toBe('mock-streamer');
    expect(body.results).toHaveLength(2);
    expect(body.results[0]).toEqual({
      trackUri: 'mock:track:1',
      trackName: 'First Song',
      artistName: 'Test Artist',
      albumArtUrl: 'https://cdn.test/a.jpg',
      durationMs: 180_000,
    });
    expect(mockProvider.getLastQuery()).toBe('hello world');
  });

  it('honors the limit query param', async () => {
    const { app, sessionId } = buildHarness();
    const res = await app.request(`http://x/sessions/${sessionId}/search?q=x&limit=1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: ReadonlyArray<unknown> };
    expect(body.results).toHaveLength(1);
  });

  it('returns 400 invalid_query when q is missing or empty', async () => {
    const { app, sessionId } = buildHarness();
    const res = await app.request(`http://x/sessions/${sessionId}/search`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_query');
  });

  it('returns 404 session_not_found for an unknown session', async () => {
    const { app } = buildHarness({ noSession: true });
    const res = await app.request('http://x/sessions/unknown/search?q=hi');
    expect(res.status).toBe(404);
  });

  it('returns 503 no_provider_connected when account has no provider', async () => {
    const { app, sessionId } = buildHarness({ noConnection: true });
    const res = await app.request(`http://x/sessions/${sessionId}/search?q=hi`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('no_provider_connected');
  });

  it('returns 501 search_not_supported when the connected provider lacks search', async () => {
    const { app, sessionId } = buildHarness({ provider: 'mute-provider' });
    const res = await app.request(`http://x/sessions/${sessionId}/search?q=hi`);
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('search_not_supported');
  });
});

describe('GET /sessions/:id/search — provider rate limits', () => {
  it('returns 503 provider_rate_limited with Retry-After while the account is cooling down', async () => {
    const { app, sessionId, mockProvider } = buildHarness();
    const now = Date.now();
    mockProvider.failWith = new ProviderRateLimitedError(
      'mock-streamer',
      'search',
      now + 120_000,
      now,
    );

    const res = await app.request(`http://x/sessions/${sessionId}/search?q=abc`);

    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('120');
    expect(await res.json()).toEqual({
      error: 'provider_rate_limited',
      providerId: 'mock-streamer',
      retryAfterSec: 120,
    });
  });

  it('maps a raw provider 429 the same way', async () => {
    const { app, sessionId, mockProvider } = buildHarness();
    mockProvider.failWith = Object.assign(new Error('Spotify Web API returned 429'), {
      status: 429,
      retryAfterSec: 56029,
    });

    const res = await app.request(`http://x/sessions/${sessionId}/search?q=abc`);

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      error: 'provider_rate_limited',
      retryAfterSec: 56029,
    });
  });
});

describe('GET /sessions/:id/search — result cache', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('serves a repeated query from cache (case + whitespace insensitive)', async () => {
    const { app, sessionId, mockProvider } = buildHarness();

    const a = await app.request(`http://x/sessions/${sessionId}/search?q=Velvet%20Leash`);
    const b = await app.request(`http://x/sessions/${sessionId}/search?q=%20velvet%20leash%20`);

    expect(a.status).toBe(200);
    expect(await b.json()).toEqual(await a.json());
    expect(mockProvider.calls).toBe(1);
  });

  it('collapses concurrent identical queries into one provider call', async () => {
    const { app, sessionId, mockProvider } = buildHarness();

    await Promise.all([
      app.request(`http://x/sessions/${sessionId}/search?q=ashes`),
      app.request(`http://x/sessions/${sessionId}/search?q=ashes`),
      app.request(`http://x/sessions/${sessionId}/search?q=ashes`),
    ]);

    expect(mockProvider.calls).toBe(1);
  });

  it('asks the provider again once the cached entry is a minute old', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { app, sessionId, mockProvider } = buildHarness();

    await app.request(`http://x/sessions/${sessionId}/search?q=ashes`);
    vi.setSystemTime(Date.now() + 60_001);
    await app.request(`http://x/sessions/${sessionId}/search?q=ashes`);

    expect(mockProvider.calls).toBe(2);
  });

  it('does not cache failures', async () => {
    const { app, sessionId, mockProvider } = buildHarness();
    mockProvider.failWith = new Error('boom');
    const failed = await app.request(`http://x/sessions/${sessionId}/search?q=ashes`);
    expect(failed.status).toBe(502);

    mockProvider.failWith = null;
    const ok = await app.request(`http://x/sessions/${sessionId}/search?q=ashes`);

    expect(ok.status).toBe(200);
    expect(mockProvider.calls).toBe(2);
  });
});

interface RefusalBody {
  error: string;
  retryAfterSec: number;
}

interface SearchBody {
  results: ReadonlyArray<unknown>;
  providerId: string;
  slowDown?: { debounceMs: number; ttlSec: number };
}

describe('GET /sessions/:id/search — search budget', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refuses a cache miss with 503 search_busy and Retry-After once the budget is spent (AE2)', async () => {
    const { search, mockProvider, limiter } = buildHarness({ pacing: { searchBudgetLimit: 2 } });
    expect((await search('one')).status).toBe(200);
    expect((await search('two')).status).toBe(200);

    const res = await search('daft punk');

    expect(res.status).toBe(503);
    const body = (await res.json()) as RefusalBody;
    expect(body.error).toBe('search_busy');
    const waitSec = Math.ceil(
      limiter.peekSync(SEARCH_BUDGET_SCOPE, 'mock-streamer').retryAfterMs / 1000,
    );
    expect(body.retryAfterSec).toBeGreaterThanOrEqual(waitSec);
    expect(res.headers.get('retry-after')).toBe(String(body.retryAfterSec));
    expect(mockProvider.calls).toBe(2);
  });

  it('serves a query cached 20s ago while the budget is spent (AE1)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { search, addGuest, mockProvider } = buildHarness({ pacing: { searchBudgetLimit: 1 } });
    await addGuest('tok-a');
    await addGuest('tok-b');
    expect((await search('daft punk', 'tok-a')).status).toBe(200);

    vi.setSystemTime(Date.now() + 20_000);
    const res = await search('Daft Punk', 'tok-b');

    expect(res.status).toBe(200);
    expect(((await res.json()) as SearchBody).results).toHaveLength(2);
    expect(mockProvider.calls).toBe(1);
  });

  it('joins an in-flight duplicate while the budget is spent', async () => {
    const { search, mockProvider } = buildHarness({ pacing: { searchBudgetLimit: 1 } });
    let release!: () => void;
    mockProvider.gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = search('ashes');
    await vi.waitFor(() => expect(mockProvider.calls).toBe(1));
    const second = search('ashes');
    release();

    const [a, b] = await Promise.all([first, second]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(mockProvider.calls).toBe(1);
  });

  it('spends the budget once for two concurrent identical cache misses', async () => {
    const { search, mockProvider, limiter } = buildHarness();

    const [a, b] = await Promise.all([search('ashes'), search('ashes')]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(mockProvider.calls).toBe(1);
    expect(budgetRemaining(limiter)).toBe(DEFAULT_SEARCH_PACING.searchBudgetLimit - 1);
  });

  it("leaves the guest's own limit unchanged when refusing as busy", async () => {
    const { search, addGuest, limiter } = buildHarness({ pacing: { searchBudgetLimit: 1 } });
    const slotId = await addGuest('tok-a');
    expect((await search('one', 'tok-a')).status).toBe(200);
    const before = limiter.peekSync(SEARCH_SCOPE, searchGuestKey(slotId)).remaining;

    const res = await search('two', 'tok-a');

    expect(res.status).toBe(503);
    expect(((await res.json()) as RefusalBody).error).toBe('search_busy');
    expect(limiter.peekSync(SEARCH_SCOPE, searchGuestKey(slotId)).remaining).toBe(before);
  });
});

describe('GET /sessions/:id/search — per-guest limits', () => {
  it('refuses only the fast guest with 429 search_too_fast (AE4)', async () => {
    const { search, addGuest, mockProvider } = buildHarness({
      pacing: { searchGuestLimit: 2, searchBudgetLimit: 10 },
    });
    await addGuest('tok-a');
    await addGuest('tok-b');
    expect((await search('a1', 'tok-a')).status).toBe(200);
    expect((await search('a2', 'tok-a')).status).toBe(200);

    const tooFast = await search('a3', 'tok-a');
    const other = await search('b1', 'tok-b');

    expect(tooFast.status).toBe(429);
    const body = (await tooFast.json()) as RefusalBody;
    expect(body.error).toBe('search_too_fast');
    expect(body.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(tooFast.headers.get('retry-after')).toBe(String(body.retryAfterSec));
    expect(other.status).toBe(200);
    expect(mockProvider.calls).toBe(3);
  });

  it('does not spend the search budget on a too-fast refusal', async () => {
    const { search, addGuest, limiter } = buildHarness({
      pacing: { searchGuestLimit: 1, searchBudgetLimit: 10 },
    });
    await addGuest('tok-a');
    expect((await search('a1', 'tok-a')).status).toBe(200);
    const before = budgetRemaining(limiter);

    expect((await search('a2', 'tok-a')).status).toBe(429);

    expect(budgetRemaining(limiter)).toBe(before);
  });

  it('accepts a queued guest slot as a guest identity', async () => {
    const { search, addGuest, limiter } = buildHarness();
    const slotId = await addGuest('tok-q', { status: 'queued' });

    expect((await search('hello', 'tok-q')).status).toBe(200);

    const guest = limiter.peekSync(SEARCH_SCOPE, searchGuestKey(slotId));
    expect(guest.remaining).toBe(DEFAULT_SEARCH_PACING.searchGuestLimit - 1);
    const anon = limiter.peekSync(SEARCH_SCOPE, SEARCH_ANON_KEY);
    expect(anon.remaining).toBe(DEFAULT_SEARCH_PACING.searchAnonLimit);
  });

  it('limits a slot token from another session as anonymous', async () => {
    const { search, addGuest, limiter } = buildHarness();
    const slotId = await addGuest('tok-elsewhere', { sessionId: 'other-session' });

    expect((await search('hello', 'tok-elsewhere')).status).toBe(200);

    const guest = limiter.peekSync(SEARCH_SCOPE, searchGuestKey(slotId));
    expect(guest.remaining).toBe(DEFAULT_SEARCH_PACING.searchGuestLimit);
    const anon = limiter.peekSync(SEARCH_SCOPE, SEARCH_ANON_KEY);
    expect(anon.remaining).toBe(DEFAULT_SEARCH_PACING.searchAnonLimit - 1);
  });

  it('treats an unknown bearer token as anonymous, not 401', async () => {
    const { search, limiter } = buildHarness();

    const res = await search('hello', 'tok-nobody');

    expect(res.status).toBe(200);
    const anon = limiter.peekSync(SEARCH_SCOPE, SEARCH_ANON_KEY);
    expect(anon.remaining).toBe(DEFAULT_SEARCH_PACING.searchAnonLimit - 1);
  });
});

describe('GET /sessions/:id/search — anonymous limit', () => {
  it('shares one anon limit across tokenless callers and still spends the budget (AE10)', async () => {
    const { search, addGuest, limiter } = buildHarness({
      pacing: { searchAnonLimit: 5, searchBudgetLimit: 20 },
    });
    await addGuest('tok-a');
    for (let i = 0; i < 5; i += 1) {
      expect((await search(`anon ${i}`)).status).toBe(200);
    }

    const sixth = await search('anon 6');
    const guest = await search('guest search', 'tok-a');

    expect(sixth.status).toBe(429);
    expect(((await sixth.json()) as RefusalBody).error).toBe('search_too_fast');
    expect(guest.status).toBe(200);
    expect(budgetRemaining(limiter)).toBe(20 - 6);
  });
});

describe('GET /sessions/:id/search — Spotify cooldown and cache', () => {
  it('serves cached queries and refuses misses without spending limits while cooling down (AE8)', async () => {
    const cooldowns = new ProviderCooldowns();
    const { search, accountId, mockProvider, limiter } = buildHarness({ cooldowns });
    expect((await search('cached song')).status).toBe(200);
    cooldowns.record(accountId, 'mock-streamer', 'search', 40 * 60);
    const budgetBefore = budgetRemaining(limiter);
    const anonBefore = limiter.peekSync(SEARCH_SCOPE, SEARCH_ANON_KEY).remaining;

    const hit = await search('cached song');
    const miss = await search('fresh song');

    expect(hit.status).toBe(200);
    expect(miss.status).toBe(503);
    const body = (await miss.json()) as RefusalBody;
    expect(body.error).toBe('provider_rate_limited');
    expect(body.retryAfterSec).toBeGreaterThan(40 * 60 - 5);
    expect(body.retryAfterSec).toBeLessThanOrEqual(40 * 60);
    expect(miss.headers.get('retry-after')).toBe(String(body.retryAfterSec));
    expect(mockProvider.calls).toBe(1);
    expect(budgetRemaining(limiter)).toBe(budgetBefore);
    expect(limiter.peekSync(SEARCH_SCOPE, SEARCH_ANON_KEY).remaining).toBe(anonBefore);
  });

  it('keeps searching while only the player quota group is cooling down', async () => {
    const cooldowns = new ProviderCooldowns();
    const { search, accountId, mockProvider } = buildHarness({ cooldowns });
    cooldowns.record(accountId, 'mock-streamer', 'player', 40 * 60);

    const res = await search('fresh song');

    expect(res.status).toBe(200);
    expect(mockProvider.calls).toBe(1);
  });
});

describe('GET /sessions/:id/search — slow-down hint', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const pacing = { searchBudgetLimit: 10, searchAnonLimit: 50 };

  it('adds slowDown once budget remaining is at or below the threshold (AE5)', async () => {
    const { search } = buildHarness({ pacing });
    for (let i = 0; i < 6; i += 1) {
      const body = (await (await search(`q${i}`)).json()) as SearchBody;
      expect(body.slowDown).toBeUndefined();
    }

    const body = (await (await search('q6')).json()) as SearchBody;

    expect(body.slowDown).toEqual({
      debounceMs: DEFAULT_SEARCH_PACING.searchSlowDownDebounceMs,
      ttlSec: DEFAULT_SEARCH_PACING.searchSlowDownTtlSec,
    });
  });

  it('computes the hint for a cache hit at the time it is served, never from the cache', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { search, mockProvider } = buildHarness({ pacing });
    expect(((await (await search('early')).json()) as SearchBody).slowDown).toBeUndefined();
    for (let i = 0; i < 6; i += 1) await search(`drain ${i}`);

    const hotHit = (await (await search('early')).json()) as SearchBody;
    expect(hotHit.slowDown).toBeDefined();

    // The budget window (30s) has passed but the cache entry (60s) is still live.
    vi.setSystemTime(Date.now() + 31_000);
    const coolHit = (await (await search('drain 5')).json()) as SearchBody;
    expect(coolHit.slowDown).toBeUndefined();
    expect(mockProvider.calls).toBe(7);
  });

  it('never sends the hint when the threshold is 0, even with the budget fully spent', async () => {
    const { search } = buildHarness({
      pacing: { ...pacing, searchSlowDownThresholdPct: 0 },
    });
    let last: SearchBody | undefined;
    for (let i = 0; i < 10; i += 1) {
      last = (await (await search(`q${i}`)).json()) as SearchBody;
    }
    expect(last?.slowDown).toBeUndefined();
    const cachedHit = (await (await search('q0')).json()) as SearchBody;
    expect(cachedHit.slowDown).toBeUndefined();
  });
});

describe('GET /sessions/:id/search — refusal jitter', () => {
  it.each([0, 750, 1500])(
    'keeps retryAfterSec within [limiter wait, limiter wait + 2] with %ims jitter',
    async (jitter) => {
      const { search, limiter } = buildHarness({
        pacing: { searchBudgetLimit: 1 },
        jitterMs: () => jitter,
      });
      await search('one');

      const res = await search('two');

      const body = (await res.json()) as RefusalBody;
      const waitSec = Math.ceil(
        limiter.peekSync(SEARCH_BUDGET_SCOPE, 'mock-streamer').retryAfterMs / 1000,
      );
      expect(Number.isInteger(body.retryAfterSec)).toBe(true);
      expect(body.retryAfterSec).toBeGreaterThanOrEqual(waitSec);
      expect(body.retryAfterSec).toBeLessThanOrEqual(waitSec + 2);
      expect(res.headers.get('retry-after')).toBe(String(body.retryAfterSec));
    },
  );
});

describe('GET /sessions/:id/search — admitted searches that fail upstream', () => {
  it.each([
    ['a provider error (502)', () => new Error('boom'), 502, 'provider_error'],
    [
      'a provider 429 after admission',
      () =>
        Object.assign(new Error('Spotify Web API returned 429'), {
          status: 429,
          retryAfterSec: 30,
        }),
      503,
      'provider_rate_limited',
    ],
  ])(
    'keeps the budget and guest units spent after %s',
    async (_label, makeError, status, error) => {
      const { search, addGuest, limiter, mockProvider } = buildHarness({
        pacing: { searchBudgetLimit: 3, searchGuestLimit: 3 },
      });
      const slotId = await addGuest('tok-a');
      mockProvider.failWith = makeError();

      const res = await search('doomed', 'tok-a');

      expect(res.status).toBe(status);
      expect(((await res.json()) as { error: string }).error).toBe(error);
      expect(mockProvider.calls).toBe(1);
      expect(budgetRemaining(limiter)).toBe(3 - 1);
      expect(limiter.peekSync(SEARCH_SCOPE, searchGuestKey(slotId)).remaining).toBe(3 - 1);
    },
  );
});

describe('GET /sessions/:id/search — early retries', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function guestRemaining(
    limiter: ReturnType<typeof createSearchRateLimiter>,
    slotId: string,
  ): number {
    return limiter.peekSync(SEARCH_SCOPE, searchGuestKey(slotId)).remaining;
  }

  it('never charges a guest who waits out each busy refusal', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { search, addGuest, limiter } = buildHarness({
      pacing: { searchBudgetLimit: 1, searchGuestLimit: 3 },
    });
    await addGuest('tok-other');
    const honest = await addGuest('tok-honest');
    expect((await search('other 0', 'tok-other')).status).toBe(200);

    for (let round = 1; round <= 4; round += 1) {
      const res = await search(`honest ${round}`, 'tok-honest');
      expect(res.status).toBe(503);
      const body = (await res.json()) as RefusalBody;
      expect(body.error).toBe('search_busy');
      expect(guestRemaining(limiter, honest)).toBe(3);
      // Waits exactly as told, but another guest takes the freed slot first.
      vi.setSystemTime(Date.now() + body.retryAfterSec * 1000);
      expect((await search(`other ${round}`, 'tok-other')).status).toBe(200);
    }
  });

  it('charges a busy refusal that arrives before its deadline to the retrying guest', async () => {
    const { search, addGuest, limiter, mockProvider } = buildHarness({
      pacing: { searchBudgetLimit: 1, searchGuestLimit: 3 },
    });
    await addGuest('tok-other');
    const rude = await addGuest('tok-rude');
    expect((await search('other', 'tok-other')).status).toBe(200);

    // The first refusal is honest: nothing to ignore yet.
    expect(((await (await search('r0', 'tok-rude')).json()) as RefusalBody).error).toBe(
      'search_busy',
    );
    expect(guestRemaining(limiter, rude)).toBe(3);

    for (let i = 1; i <= 3; i += 1) {
      const res = await search(`r${i}`, 'tok-rude');
      expect(((await res.json()) as RefusalBody).error).toBe('search_busy');
      expect(guestRemaining(limiter, rude)).toBe(3 - i);
    }

    const tooFast = await search('r4', 'tok-rude');
    expect(tooFast.status).toBe(429);
    expect(((await tooFast.json()) as RefusalBody).error).toBe('search_too_fast');
    expect(budgetRemaining(limiter)).toBe(0);
    expect(mockProvider.calls).toBe(1);
  });

  it('lets a guest who waited win freed slots over one who retries every 250ms', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { search, addGuest } = buildHarness({
      pacing: { searchBudgetLimit: 1, searchGuestLimit: 5 },
    });
    await addGuest('tok-other');
    await addGuest('tok-honest');
    await addGuest('tok-rude');
    expect((await search('other', 'tok-other')).status).toBe(200);

    const wins = { honest: 0, rude: 0 };
    let rudeTooFast = 0;
    let honestNextAt = Date.now();
    const start = Date.now();
    let n = 0;
    // Five budget windows; the rude client always gets in first within a tick.
    for (let t = start; t < start + 150_000; t += 250) {
      vi.setSystemTime(t);
      n += 1;
      const rudeRes = await search(`rude ${n}`, 'tok-rude');
      if (rudeRes.status === 200) wins.rude += 1;
      if (rudeRes.status === 429) rudeTooFast += 1;
      if (t >= honestNextAt) {
        const res = await search(`honest ${n}`, 'tok-honest');
        if (res.status === 200) {
          wins.honest += 1;
        } else {
          honestNextAt = t + ((await res.json()) as RefusalBody).retryAfterSec * 1000;
        }
      }
    }

    // One slot frees per window (30s, 60s, 90s, 120s); the guest who waited takes each.
    expect(wins.honest).toBeGreaterThanOrEqual(wins.rude);
    expect(wins).toEqual({ honest: 4, rude: 0 });
    expect(rudeTooFast).toBeGreaterThan(0);
  });

  it('charges early anonymous retries to the shared anon limit only', async () => {
    const { search, addGuest, limiter } = buildHarness({
      pacing: { searchBudgetLimit: 1, searchAnonLimit: 5, searchGuestLimit: 5 },
    });
    const guest = await addGuest('tok-a');
    expect((await search('first', 'tok-a')).status).toBe(200);

    expect((await search('anon 1')).status).toBe(503);
    expect(limiter.peekSync(SEARCH_SCOPE, SEARCH_ANON_KEY).remaining).toBe(5);
    expect((await search('anon 2')).status).toBe(503);
    expect(limiter.peekSync(SEARCH_SCOPE, SEARCH_ANON_KEY).remaining).toBe(4);

    // A guest's first busy refusal is not an early retry of the anon deadline.
    expect((await search('guest 2', 'tok-a')).status).toBe(503);
    expect(guestRemaining(limiter, guest)).toBe(5 - 1);
  });

  it('never charges an early retry that is served from cache or joins an in-flight search', async () => {
    const { search, addGuest, limiter, mockProvider } = buildHarness({
      pacing: { searchBudgetLimit: 1, searchGuestLimit: 3 },
    });
    await addGuest('tok-other');
    const rude = await addGuest('tok-rude');
    let release!: () => void;
    mockProvider.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inFlight = search('shared', 'tok-other');
    await vi.waitFor(() => expect(mockProvider.calls).toBe(1));

    expect((await search('miss', 'tok-rude')).status).toBe(503);
    const joined = search('shared', 'tok-rude');
    release();
    expect((await joined).status).toBe(200);
    expect((await inFlight).status).toBe(200);
    expect((await search('Shared', 'tok-rude')).status).toBe(200);

    expect(guestRemaining(limiter, rude)).toBe(3);
  });
});

describe('GET /sessions/:id/search — early retry with a free slot', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refuses an early retry as too fast even once the budget frees, then admits it after the deadline', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { search, addGuest, limiter } = buildHarness({
      pacing: { searchBudgetLimit: 1, searchGuestLimit: 5 },
      jitterMs: () => 1_500,
    });
    await addGuest('tok-other');
    const rude = await addGuest('tok-rude');
    const start = Date.now();
    expect((await search('other', 'tok-other')).status).toBe(200);
    const busy = (await (await search('r0', 'tok-rude')).json()) as RefusalBody;
    expect(busy.error).toBe('search_busy');
    const deadline = start + busy.retryAfterSec * 1000;

    // The budget has freed (30s) but the deadline (30s + jitter) has not passed.
    vi.setSystemTime(start + 30_500);
    expect(budgetRemaining(limiter)).toBe(1);
    const early = await search('r1', 'tok-rude');
    expect(early.status).toBe(429);
    const body = (await early.json()) as RefusalBody;
    expect(body.error).toBe('search_too_fast');
    expect(body.retryAfterSec).toBeGreaterThanOrEqual(Math.ceil((deadline - Date.now()) / 1000));
    expect(limiter.peekSync(SEARCH_SCOPE, searchGuestKey(rude)).remaining).toBe(4);
    expect(budgetRemaining(limiter)).toBe(1);

    vi.setSystemTime(start + 30_500 + body.retryAfterSec * 1000);
    expect((await search('r2', 'tok-rude')).status).toBe(200);
  });
});

interface LocalBody extends SearchBody {
  source?: 'provider' | 'local';
  fallbackReason?: string;
}

function dailyRemaining(limiter: ReturnType<typeof createSearchRateLimiter>): number {
  return limiter.peekSync(SEARCH_DAILY_SCOPE, 'mock-streamer').remaining;
}

describe('GET /sessions/:id/search — daily cap', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refuses with 503 search_daily_limit after N admissions, independent of the 30s window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { search, mockProvider } = buildHarness({
      pacing: { searchDailyLimit: 2, searchBudgetLimit: 10 },
    });
    const start = Date.now();
    expect((await search('a1')).status).toBe(200);
    expect((await search('a2')).status).toBe(200);

    // Well past the 30s budget window: the budget is free, the daily cap is not.
    vi.setSystemTime(start + 31_000);
    const res = await search('zzz nothing');

    expect(res.status).toBe(503);
    const body = (await res.json()) as RefusalBody;
    expect(body.error).toBe('search_daily_limit');
    expect(body.retryAfterSec).toBeGreaterThanOrEqual(86_400 - 31 - 1);
    expect(body.retryAfterSec).toBeLessThanOrEqual(86_400);
    expect(res.headers.get('retry-after')).toBe(String(body.retryAfterSec));
    expect(mockProvider.calls).toBe(2);

    // A day after the first admission one unit has expired.
    vi.setSystemTime(start + 86_400_000 + 1);
    expect((await search('a3')).status).toBe(200);
    expect(mockProvider.calls).toBe(3);
  });

  it('still serves cache hits while the daily cap is spent', async () => {
    const { search, mockProvider } = buildHarness({ pacing: { searchDailyLimit: 1 } });
    expect((await search('cached')).status).toBe(200);

    expect((await search('Cached')).status).toBe(200);
    expect(mockProvider.calls).toBe(1);
  });

  it('spends a daily unit only when the budget admits too', async () => {
    const { search, addGuest, limiter } = buildHarness({
      pacing: { searchDailyLimit: 5, searchBudgetLimit: 1 },
    });
    const slotId = await addGuest('tok-a');
    expect((await search('one', 'tok-a')).status).toBe(200);
    expect(dailyRemaining(limiter)).toBe(4);

    const busy = await search('two', 'tok-a');

    expect(((await busy.json()) as RefusalBody).error).toBe('search_busy');
    expect(dailyRemaining(limiter)).toBe(4);
    expect(limiter.peekSync(SEARCH_SCOPE, searchGuestKey(slotId)).remaining).toBe(
      DEFAULT_SEARCH_PACING.searchGuestLimit - 1,
    );
  });

  it('spends no budget or guest unit when the daily cap refuses', async () => {
    const { search, addGuest, limiter } = buildHarness({
      pacing: { searchDailyLimit: 1, searchBudgetLimit: 5 },
    });
    const slotId = await addGuest('tok-a');
    expect((await search('one', 'tok-a')).status).toBe(200);
    const guestBefore = limiter.peekSync(SEARCH_SCOPE, searchGuestKey(slotId)).remaining;

    const res = await search('two', 'tok-a');

    expect(((await res.json()) as RefusalBody).error).toBe('search_daily_limit');
    expect(budgetRemaining(limiter)).toBe(4);
    expect(limiter.peekSync(SEARCH_SCOPE, searchGuestKey(slotId)).remaining).toBe(guestBefore);
    // A daily refusal hands out no retry deadline: the next try is not "early".
    const again = await search('three', 'tok-a');
    expect(((await again.json()) as RefusalBody).error).toBe('search_daily_limit');
    expect(limiter.peekSync(SEARCH_SCOPE, searchGuestKey(slotId)).remaining).toBe(guestBefore);
  });
});

describe('GET /sessions/:id/search — source', () => {
  it("marks provider answers and cache hits as source 'provider'", async () => {
    const { search } = buildHarness();

    const live = (await (await search('first')).json()) as LocalBody;
    const cached = (await (await search('First')).json()) as LocalBody;

    expect(live.source).toBe('provider');
    expect(live.fallbackReason).toBeUndefined();
    expect(cached.source).toBe('provider');
  });

  it('adds provider results to the local catalog once per provider call', async () => {
    const { search, catalog, catalogRepo } = buildHarness();

    await search('anything');
    await search('Anything');
    await catalog.whenIdle();

    const rows = await catalogRepo.findAll();
    expect(rows.map((r) => [r.providerId, r.trackUri, r.timesSeen])).toEqual([
      ['mock-streamer', 'mock:track:1', 1],
      ['mock-streamer', 'mock:track:2', 1],
    ]);
  });

  it('never fails the response when the catalog write fails', async () => {
    const { search, catalog, catalogRepo } = buildHarness();
    vi.spyOn(catalogRepo, 'upsertMany').mockRejectedValue(new Error('db down'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await search('anything');
    await catalog.whenIdle();

    expect(res.status).toBe(200);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe('GET /sessions/:id/search — local catalog fallback', () => {
  type Reason = 'busy' | 'daily_limit' | 'provider_limited';

  /** A harness whose next cache miss can't reach the provider because of `reason`. */
  async function blocked(reason: Reason) {
    const cooldowns = new ProviderCooldowns();
    const harness = buildHarness({
      cooldowns,
      pacing:
        reason === 'busy'
          ? { searchBudgetLimit: 1, searchDailyLimit: 10 }
          : reason === 'daily_limit'
            ? { searchBudgetLimit: 10, searchDailyLimit: 1 }
            : {},
    });
    await harness.addGuest('tok-a');
    expect((await harness.search('spend', 'tok-a')).status).toBe(200);
    if (reason === 'provider_limited') {
      cooldowns.record(harness.accountId, 'mock-streamer', 'search', 600);
    }
    await harness.seedCatalog();
    return harness;
  }

  it.each<Reason>(['busy', 'daily_limit', 'provider_limited'])(
    'serves local matches with fallbackReason %s and spends nothing',
    async (reason) => {
      const { search, limiter, mockProvider } = await blocked(reason);
      const callsBefore = mockProvider.calls;
      const before = {
        budget: budgetRemaining(limiter),
        daily: dailyRemaining(limiter),
        anon: limiter.peekSync(SEARCH_SCOPE, SEARCH_ANON_KEY).remaining,
      };

      const res = await search('first son');
      const again = await search('test art');

      expect(res.status).toBe(200);
      expect(res.headers.get('retry-after')).toBeNull();
      expect(await res.json()).toEqual({
        results: [
          {
            trackUri: 'mock:track:1',
            trackName: 'First Song',
            artistName: 'Test Artist',
            albumArtUrl: 'https://cdn.test/a.jpg',
            durationMs: 180_000,
          },
        ],
        providerId: 'mock-streamer',
        source: 'local',
        fallbackReason: reason,
      });
      expect(again.status).toBe(200);
      expect(mockProvider.calls).toBe(callsBefore);
      expect({
        budget: budgetRemaining(limiter),
        daily: dailyRemaining(limiter),
        anon: limiter.peekSync(SEARCH_SCOPE, SEARCH_ANON_KEY).remaining,
      }).toEqual(before);
    },
  );

  it.each<[Reason, string]>([
    ['busy', 'search_busy'],
    ['daily_limit', 'search_daily_limit'],
    ['provider_limited', 'provider_rate_limited'],
  ])('falls back to the %s refusal when nothing local matches', async (reason, error) => {
    const { search } = await blocked(reason);

    const res = await search('daft punk');

    expect(res.status).toBe(503);
    expect(((await res.json()) as RefusalBody).error).toBe(error);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('serves local matches when the provider answers 429 at call time', async () => {
    const { search, mockProvider, seedCatalog } = buildHarness();
    await seedCatalog();
    mockProvider.failWith = Object.assign(new Error('Spotify Web API returned 429'), {
      status: 429,
      retryAfterSec: 3600,
    });

    const res = await search('second');

    expect(res.status).toBe(200);
    const body = (await res.json()) as LocalBody;
    expect(body).toMatchObject({ source: 'local', fallbackReason: 'provider_limited' });
    expect(body.results).toHaveLength(1);
  });

  it('never serves local results to a too-fast guest', async () => {
    const { search, addGuest, seedCatalog } = buildHarness({
      pacing: { searchGuestLimit: 1, searchBudgetLimit: 10 },
    });
    await seedCatalog();
    await addGuest('tok-a');
    expect((await search('zzz', 'tok-a')).status).toBe(200);

    const res = await search('first', 'tok-a');

    expect(res.status).toBe(429);
    expect(((await res.json()) as RefusalBody).error).toBe('search_too_fast');
  });

  it('never serves local results to an early retry', async () => {
    const { search, addGuest, seedCatalog, limiter } = buildHarness({
      pacing: { searchBudgetLimit: 1, searchGuestLimit: 5 },
    });
    await seedCatalog();
    const rude = await addGuest('tok-rude');
    expect((await search('spend')).status).toBe(200);
    expect(((await (await search('zzz', 'tok-rude')).json()) as RefusalBody).error).toBe(
      'search_busy',
    );

    const early = await search('first', 'tok-rude');

    expect(early.status).toBe(503);
    expect(((await early.json()) as RefusalBody).error).toBe('search_busy');
    expect(limiter.peekSync(SEARCH_SCOPE, searchGuestKey(rude)).remaining).toBe(4);
  });

  it('caps local results at the request limit', async () => {
    const { app, sessionId, seedCatalog } = await blocked('busy');
    await seedCatalog([
      ...SAMPLE_TRACKS,
      { uri: 'mock:track:3', name: 'Third Song', artist: 'X', albumArt: null, durationMs: null },
    ]);

    const res = await app.request(`http://x/sessions/${sessionId}/search?q=song&limit=2`);

    expect(res.status).toBe(200);
    expect(((await res.json()) as LocalBody).results).toHaveLength(2);
  });
});
