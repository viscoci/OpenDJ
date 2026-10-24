/**
 * /api/v1/sessions/:id/search — configurable search sources
 * (`SEARCH_SOURCES`). The provider and an external source are mocks; no
 * network.
 */

import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import {
  defineCapabilities,
  PROVIDER_FEATURES,
  type IStreamingProvider,
  type ISupportsSearch,
  type ProviderCapabilities,
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
  SEARCH_BUDGET_SCOPE,
  SEARCH_DAILY_SCOPE,
  SEARCH_SCOPE,
  searchGuestKey,
} from '../../src/rate-limit/SlidingWindowRateLimiter.js';
import { StreamingRouter } from '../../src/providers/streaming/StreamingRouter.js';
import { ProviderCooldowns } from '../../src/providers/streaming/ProviderCooldowns.js';
import type { ProviderRegistry } from '../../src/providers/streaming/providerRegistry.js';
import type {
  SearchSource,
  SearchSourceId,
  SourceTrack,
} from '../../src/search-sources/SearchSource.js';

const PROVIDER_TRACKS: Track[] = [
  {
    uri: 'mock:track:1',
    name: 'One More Time',
    artist: 'Daft Punk',
    albumArt: null,
    durationMs: 320_000,
  },
];

const DEEZER_TRACKS: SourceTrack[] = [
  {
    trackUri: 'opendj:isrc:GBDUW0000053',
    trackName: 'One More Time',
    artistName: 'Daft Punk',
    albumArtUrl: 'https://cdn.deezer/cover.jpg',
    durationMs: 320_000,
    isrc: 'GBDUW0000053',
  },
];

function buildHarness(
  opts: {
    order?: SearchSourceId[];
    deezer?: SourceTrack[] | 'unavailable';
    /** When set, the deezer mock also reports confidence through `searchWithConfidence`. */
    deezerConfident?: boolean;
    sonovault?: SourceTrack[] | 'unavailable';
    pacing?: Partial<SearchPacingConfig>;
    cooldowns?: ProviderCooldowns;
  } = {},
) {
  const sessions = new InMemorySessionRepository();
  const providerConnections = new InMemoryProviderConnectionRepository();
  const guestSlots = new InMemoryGuestSlotRepository();
  const pacing: SearchPacingConfig = { ...DEFAULT_SEARCH_PACING, ...opts.pacing };
  const limiter = createSearchRateLimiter(pacing, () => Date.now());

  let providerFailure: Error | null = null;
  const providerSearch = vi.fn(async (_q: string, limit = 20) => {
    if (providerFailure) throw providerFailure;
    return PROVIDER_TRACKS.slice(0, limit);
  });
  const provider: IStreamingProvider & ISupportsSearch = {
    providerId: 'mock-streamer',
    displayName: 'Mock',
    async connect() {},
    async disconnect() {},
    isConnected: () => true,
    async refreshCredentials() {
      return {};
    },
    getCapabilities: (): ProviderCapabilities =>
      defineCapabilities('mock-streamer', {
        [PROVIDER_FEATURES.Search]: {
          id: PROVIDER_FEATURES.Search,
          supported: true,
          access: 'guest',
          reliability: 'native',
        },
      }),
    search: providerSearch,
  };
  const router = new StreamingRouter({
    providerConnections,
    registry: { 'mock-streamer': () => provider } as unknown as ProviderRegistry,
    context: { fetch: globalThis.fetch },
    ...(opts.cooldowns && { cooldowns: opts.cooldowns }),
  });

  const catalog = new TrackCatalog({
    repository: new InMemoryTrackCatalogRepository(),
    queueItems: new InMemoryQueueItemRepository(),
    sessions,
    providerConnections,
  });

  let deezerAnswer: SourceTrack[] | 'unavailable' = opts.deezer ?? DEEZER_TRACKS;
  const deezerSearch = vi.fn<SearchSource['search']>(async () => deezerAnswer);
  const deezerConfident = opts.deezerConfident;
  const deezerScored = vi.fn<NonNullable<SearchSource['searchWithConfidence']>>(async () =>
    deezerAnswer === 'unavailable'
      ? 'unavailable'
      : { tracks: deezerAnswer, confident: deezerConfident ?? true },
  );
  const deezer: SearchSource = {
    id: 'deezer',
    search: deezerSearch,
    ...(deezerConfident !== undefined && { searchWithConfidence: deezerScored }),
  };
  const sonovaultAnswer: SourceTrack[] | 'unavailable' = opts.sonovault ?? 'unavailable';
  const sonovaultSearch = vi.fn<SearchSource['search']>(async () => sonovaultAnswer);
  const sonovault: SearchSource = { id: 'sonovault', search: sonovaultSearch };

  const sessionId = 'sess-src-1';
  const accountId = 'acc-src-1';
  sessions.seed({
    id: sessionId,
    accountId,
    name: 'Sources',
    qrSlug: 'sources',
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
  void providerConnections.upsert({
    accountId,
    providerId: 'mock-streamer',
    accessToken: 'tok',
  });

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
      jitterMs: () => 0,
      ...(opts.order && { searchSources: opts.order }),
      externalSearchSources: { deezer, sonovault },
    }),
  );

  async function addGuest(token: string): Promise<string> {
    const slot = await guestSlots.create({
      sessionId,
      fingerprintHash: `fp-${token}`,
      slotToken: token,
      status: 'active',
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

  return {
    search,
    addGuest,
    limiter,
    catalog,
    providerSearch,
    deezerSearch,
    deezerScored,
    sonovaultSearch,
    accountId,
    setDeezer: (answer: SourceTrack[] | 'unavailable') => {
      deezerAnswer = answer;
    },
    failProviderWith: (err: Error | null) => {
      providerFailure = err;
    },
  };
}

const budgetRemaining = (limiter: ReturnType<typeof createSearchRateLimiter>) =>
  limiter.peekSync(SEARCH_BUDGET_SCOPE, 'mock-streamer').remaining;
const dailyRemaining = (limiter: ReturnType<typeof createSearchRateLimiter>) =>
  limiter.peekSync(SEARCH_DAILY_SCOPE, 'mock-streamer').remaining;

describe('GET /sessions/:id/search — search sources', () => {
  it('never asks an external source with the default order', async () => {
    const { search, deezerSearch, providerSearch } = buildHarness();

    const res = await search('one more');

    expect(res.status).toBe(200);
    expect(((await res.json()) as { source: string }).source).toBe('provider');
    expect(providerSearch).toHaveBeenCalledTimes(1);
    expect(deezerSearch).not.toHaveBeenCalled();
  });

  it('answers deezer-first searches as external opendj:isrc tracks without spending provider quota', async () => {
    const { search, addGuest, limiter, providerSearch, deezerSearch } = buildHarness({
      order: ['deezer', 'catalog', 'provider'],
      pacing: { searchGuestLimit: 5 },
    });
    const slotId = await addGuest('tok-a');

    const res = await search('one more', 'tok-a');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      results: [
        {
          trackUri: 'opendj:isrc:GBDUW0000053',
          trackName: 'One More Time',
          artistName: 'Daft Punk',
          albumArtUrl: 'https://cdn.deezer/cover.jpg',
          durationMs: 320_000,
          isrc: 'GBDUW0000053',
        },
      ],
      providerId: 'mock-streamer',
      source: 'external',
    });
    expect(deezerSearch).toHaveBeenCalledTimes(1);
    expect(deezerSearch.mock.calls[0]![2]).toMatchObject({ providerId: 'mock-streamer' });
    expect(providerSearch).not.toHaveBeenCalled();
    expect(budgetRemaining(limiter)).toBe(DEFAULT_SEARCH_PACING.searchBudgetLimit);
    expect(dailyRemaining(limiter)).toBe(DEFAULT_SEARCH_PACING.searchDailyLimit);
    expect(limiter.peekSync(SEARCH_SCOPE, searchGuestKey(slotId)).remaining).toBe(4);
  });

  it('serves a repeated external query from the shared cache without spending again', async () => {
    const { search, addGuest, limiter, deezerSearch } = buildHarness({
      order: ['deezer', 'provider'],
    });
    const slotId = await addGuest('tok-a');

    await search('One  More', 'tok-a');
    const again = await search('one more', 'tok-a');

    expect(again.status).toBe(200);
    expect(((await again.json()) as { source: string }).source).toBe('external');
    expect(deezerSearch).toHaveBeenCalledTimes(1);
    expect(limiter.peekSync(SEARCH_SCOPE, searchGuestKey(slotId)).remaining).toBe(
      DEFAULT_SEARCH_PACING.searchGuestLimit - 1,
    );
  });

  it('records external results in the catalog with their ISRC', async () => {
    const { search, catalog } = buildHarness({ order: ['deezer', 'catalog'] });

    await search('one more');
    await catalog.whenIdle();

    expect(await catalog.search('mock-streamer', 'daft', 5)).toMatchObject([
      { trackUri: 'opendj:isrc:GBDUW0000053', isrc: 'GBDUW0000053', timesSeen: 1 },
    ]);
  });

  it('swaps in the native URI the catalog knows for an external result', async () => {
    const { search, catalog } = buildHarness({ order: ['deezer', 'catalog'] });
    catalog.recordSeen('mock-streamer', [
      {
        uri: 'mock:track:resolved',
        name: 'One More Time',
        artist: 'Daft Punk',
        albumArt: null,
        durationMs: 320_000,
        isrc: 'GBDUW0000053',
      },
    ]);
    await catalog.whenIdle();

    const body = (await (await search('one more')).json()) as {
      results: SourceTrack[];
      source: string;
    };

    expect(body.source).toBe('external');
    expect(body.results[0]).toMatchObject({
      trackUri: 'mock:track:resolved',
      trackName: 'One More Time',
      albumArtUrl: 'https://cdn.deezer/cover.jpg',
    });
  });

  it('keeps the ISRC URI when the catalog has no native URI for it', async () => {
    const { search } = buildHarness({ order: ['deezer', 'catalog'] });

    const body = (await (await search('one more')).json()) as { results: SourceTrack[] };

    expect(body.results[0]?.trackUri).toBe('opendj:isrc:GBDUW0000053');
  });

  it('moves on to the next source when the external one is unavailable, charging the guest once', async () => {
    const { search, addGuest, limiter, providerSearch } = buildHarness({
      order: ['deezer', 'provider'],
      deezer: 'unavailable',
    });
    const slotId = await addGuest('tok-a');

    const res = await search('one more', 'tok-a');

    expect(res.status).toBe(200);
    expect(((await res.json()) as { source: string }).source).toBe('provider');
    expect(providerSearch).toHaveBeenCalledTimes(1);
    expect(budgetRemaining(limiter)).toBe(DEFAULT_SEARCH_PACING.searchBudgetLimit - 1);
    expect(limiter.peekSync(SEARCH_SCOPE, searchGuestKey(slotId)).remaining).toBe(
      DEFAULT_SEARCH_PACING.searchGuestLimit - 1,
    );
  });

  it('never caches an unavailable external answer', async () => {
    const { search, deezerSearch, setDeezer } = buildHarness({
      order: ['deezer', 'provider'],
      deezer: 'unavailable',
    });

    await search('one more');
    setDeezer(DEEZER_TRACKS);
    const res = await search('one more');

    expect(((await res.json()) as { source: string }).source).toBe('external');
    expect(deezerSearch).toHaveBeenCalledTimes(2);
  });

  it('moves on to the catalog when the external source finds nothing', async () => {
    const { search, catalog, deezerSearch } = buildHarness({
      order: ['deezer', 'catalog'],
      deezer: [],
    });
    catalog.recordSeen('mock-streamer', PROVIDER_TRACKS);
    await catalog.whenIdle();

    const res = await search('one more');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      results: [
        {
          trackUri: 'mock:track:1',
          trackName: 'One More Time',
          artistName: 'Daft Punk',
          albumArtUrl: null,
          durationMs: 320_000,
        },
      ],
      providerId: 'mock-streamer',
      source: 'local',
    });
    expect(deezerSearch).toHaveBeenCalledTimes(1);
  });

  it('answers an empty external result when every source comes up empty', async () => {
    const { search } = buildHarness({ order: ['deezer', 'catalog'], deezer: [] });

    const res = await search('nothing at all');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      results: [],
      providerId: 'mock-streamer',
      source: 'external',
    });
  });

  it('answers from sonovault as external when deezer is unavailable and the catalog is empty', async () => {
    const sonovaultTracks: SourceTrack[] = [{ ...DEEZER_TRACKS[0]!, albumArtUrl: null }];
    const { search, catalog, deezerSearch, sonovaultSearch, providerSearch } = buildHarness({
      order: ['deezer', 'catalog', 'sonovault', 'provider'],
      deezer: 'unavailable',
      sonovault: sonovaultTracks,
    });

    const res = await search('Daft Punk - One More Time');
    await catalog.whenIdle();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      results: sonovaultTracks,
      providerId: 'mock-streamer',
      source: 'external',
    });
    expect(deezerSearch).toHaveBeenCalledTimes(1);
    expect(sonovaultSearch).toHaveBeenCalledTimes(1);
    expect(sonovaultSearch.mock.calls[0]![0]).toBe('Daft Punk - One More Time');
    expect(providerSearch).not.toHaveBeenCalled();
    expect(await catalog.search('mock-streamer', 'daft', 5)).toMatchObject([
      { trackUri: 'opendj:isrc:GBDUW0000053', isrc: 'GBDUW0000053' },
    ]);
  });

  it('moves past a skipping sonovault to the provider', async () => {
    const { search, sonovaultSearch, providerSearch } = buildHarness({
      order: ['catalog', 'sonovault', 'provider'],
    });

    const res = await search('one more');

    expect(((await res.json()) as { source: string }).source).toBe('provider');
    expect(sonovaultSearch).toHaveBeenCalledTimes(1);
    expect(providerSearch).toHaveBeenCalledTimes(1);
  });

  it('refuses with 503 search_unavailable when no source could be asked', async () => {
    const { search } = buildHarness({ order: ['deezer', 'catalog'], deezer: 'unavailable' });

    const res = await search('one more');

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; retryAfterSec: number };
    expect(body.error).toBe('search_unavailable');
    expect(body.retryAfterSec).toBeGreaterThan(0);
    expect(res.headers.get('retry-after')).toBe(String(body.retryAfterSec));
  });

  it("returns the provider's refusal when the provider is busy and nothing else answers", async () => {
    const { search, providerSearch } = buildHarness({
      order: ['deezer', 'catalog', 'provider'],
      deezer: 'unavailable',
      pacing: { searchBudgetLimit: 1 },
    });

    expect((await search('first')).status).toBe(200);
    const res = await search('second');

    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe('search_busy');
    expect(providerSearch).toHaveBeenCalledTimes(1);
  });

  it('refuses a too-fast guest before asking any external source', async () => {
    const { search, addGuest, deezerSearch } = buildHarness({
      order: ['deezer', 'provider'],
      pacing: { searchGuestLimit: 1 },
    });
    await addGuest('tok-a');

    expect((await search('first', 'tok-a')).status).toBe(200);
    const res = await search('second', 'tok-a');

    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toBe('search_too_fast');
    expect(deezerSearch).toHaveBeenCalledTimes(1);
  });

  it('hides an opendj:isrc catalog row when a native row with the same ISRC matches', async () => {
    const { search, catalog } = buildHarness({ order: ['catalog'] });
    catalog.recordSeen('mock-streamer', [
      {
        uri: 'opendj:isrc:GBDUW0000053',
        name: 'One More Time',
        artist: 'Daft Punk',
        albumArt: null,
        durationMs: 320_000,
        isrc: 'GBDUW0000053',
      },
      { ...PROVIDER_TRACKS[0]!, isrc: 'GBDUW0000053' },
    ]);
    await catalog.whenIdle();

    const res = await search('one more');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Array<{ trackUri: string }>; source: string };
    expect(body.source).toBe('local');
    expect(body.results.map((r) => r.trackUri)).toEqual(['mock:track:1']);
  });
});

describe('GET /sessions/:id/search — fall-through after a provider refusal', () => {
  const FALL_THROUGH: SearchSourceId[] = ['provider', 'deezer', 'catalog', 'sonovault'];
  const rateLimited = () =>
    Object.assign(new Error('Spotify Web API returned 429'), { status: 429, retryAfterSec: 30 });

  type Body = { source?: string; fallbackReason?: string; error?: string; results?: unknown[] };

  it('asks deezer when the provider budget is busy and answers external without a notice', async () => {
    const { search, addGuest, limiter, providerSearch, deezerSearch } = buildHarness({
      order: FALL_THROUGH,
      pacing: { searchBudgetLimit: 1, searchGuestLimit: 10 },
    });
    const slotId = await addGuest('tok-a');

    expect((await search('first', 'tok-a')).status).toBe(200);
    const res = await search('second', 'tok-a');

    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    expect(body.source).toBe('external');
    expect(body.fallbackReason).toBeUndefined();
    expect(body.results).toEqual(DEEZER_TRACKS);
    expect(providerSearch).toHaveBeenCalledTimes(1);
    expect(deezerSearch).toHaveBeenCalledTimes(1);
    // One unit per request: the provider answer, then the deezer answer.
    expect(limiter.peekSync(SEARCH_SCOPE, searchGuestKey(slotId)).remaining).toBe(8);
  });

  it('asks deezer when the daily cap is spent', async () => {
    const { search, deezerSearch } = buildHarness({
      order: FALL_THROUGH,
      pacing: { searchDailyLimit: 1 },
    });

    expect((await search('first')).status).toBe(200);
    const res = await search('second');

    expect(res.status).toBe(200);
    expect(((await res.json()) as Body).source).toBe('external');
    expect(deezerSearch).toHaveBeenCalledTimes(1);
  });

  it('asks deezer while the provider search cooldown is open', async () => {
    const cooldowns = new ProviderCooldowns();
    const { search, accountId, providerSearch, deezerSearch } = buildHarness({
      order: FALL_THROUGH,
      cooldowns,
    });
    cooldowns.record(accountId, 'mock-streamer', 'search', 600);

    const res = await search('one more');

    expect(res.status).toBe(200);
    expect(((await res.json()) as Body).source).toBe('external');
    expect(providerSearch).not.toHaveBeenCalled();
    expect(deezerSearch).toHaveBeenCalledTimes(1);
  });

  it('asks deezer after a provider 429 at call time, charging the guest once', async () => {
    const { search, addGuest, limiter, failProviderWith, deezerSearch } = buildHarness({
      order: FALL_THROUGH,
      pacing: { searchGuestLimit: 10 },
    });
    const slotId = await addGuest('tok-a');
    failProviderWith(rateLimited());

    const res = await search('one more', 'tok-a');

    expect(res.status).toBe(200);
    expect(((await res.json()) as Body).source).toBe('external');
    expect(deezerSearch).toHaveBeenCalledTimes(1);
    expect(limiter.peekSync(SEARCH_SCOPE, searchGuestKey(slotId)).remaining).toBe(9);
  });

  it('answers from the catalog with a fallbackReason when deezer is unavailable too', async () => {
    const { search, catalog, deezerSearch } = buildHarness({
      order: FALL_THROUGH,
      deezer: 'unavailable',
      pacing: { searchBudgetLimit: 1 },
    });
    catalog.recordSeen('mock-streamer', PROVIDER_TRACKS);
    await catalog.whenIdle();

    expect((await search('first')).status).toBe(200);
    const res = await search('one more');

    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    expect(body.source).toBe('local');
    expect(body.fallbackReason).toBe('busy');
    expect(deezerSearch).toHaveBeenCalledTimes(1);
  });

  it("returns the provider's refusal when every later source fails", async () => {
    const { search, deezerSearch, sonovaultSearch } = buildHarness({
      order: FALL_THROUGH,
      deezer: 'unavailable',
      pacing: { searchDailyLimit: 1 },
    });

    expect((await search('first')).status).toBe(200);
    const res = await search('nothing in the catalog');

    expect(res.status).toBe(503);
    expect(((await res.json()) as Body).error).toBe('search_daily_limit');
    expect(deezerSearch).toHaveBeenCalledTimes(1);
    expect(sonovaultSearch).toHaveBeenCalledTimes(1);
  });

  it('still refuses a too-fast guest before asking deezer', async () => {
    const { search, addGuest, deezerSearch } = buildHarness({
      order: FALL_THROUGH,
      pacing: { searchGuestLimit: 1, searchBudgetLimit: 1 },
    });
    await addGuest('tok-a');

    expect((await search('first', 'tok-a')).status).toBe(200);
    const res = await search('second', 'tok-a');

    expect(res.status).toBe(429);
    expect(((await res.json()) as Body).error).toBe('search_too_fast');
    expect(deezerSearch).not.toHaveBeenCalled();
  });

  it('keeps the default order: busy falls back to the catalog only', async () => {
    const { search, catalog, deezerSearch } = buildHarness({ pacing: { searchBudgetLimit: 1 } });
    catalog.recordSeen('mock-streamer', PROVIDER_TRACKS);
    await catalog.whenIdle();

    expect((await search('first')).status).toBe(200);
    const res = await search('one more');

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ source: 'local', fallbackReason: 'busy' });
    expect(deezerSearch).not.toHaveBeenCalled();
  });
});

describe('GET /sessions/:id/search — low-confidence deezer escalation', () => {
  const ESCALATING: SearchSourceId[] = ['deezer', 'catalog', 'provider'];
  const rateLimited = () =>
    Object.assign(new Error('Spotify Web API returned 429'), { status: 429, retryAfterSec: 30 });
  type Body = { source?: string; fallbackReason?: string; error?: string; results?: unknown[] };
  type Harness = ReturnType<typeof buildHarness>;

  const providerResults = PROVIDER_TRACKS.map((t) => ({
    trackUri: t.uri,
    trackName: t.name,
    artistName: t.artist,
    albumArtUrl: t.albumArt,
    durationMs: t.durationMs,
  }));

  const spyInfo = () => vi.spyOn(console, 'info').mockImplementation(() => {});

  it('asks the provider once when deezer is not confident, charging the guest once', async () => {
    const info = spyInfo();
    const { search, addGuest, limiter, providerSearch, deezerScored } = buildHarness({
      order: ESCALATING,
      deezerConfident: false,
      pacing: { searchGuestLimit: 10 },
    });
    const slotId = await addGuest('tok-a');

    const res = await search('mr brightside', 'tok-a');

    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    expect(body.source).toBe('provider');
    expect(body.fallbackReason).toBeUndefined();
    expect(body.results).toEqual(providerResults);
    expect(deezerScored).toHaveBeenCalledTimes(1);
    expect(providerSearch).toHaveBeenCalledTimes(1);
    expect(limiter.peekSync(SEARCH_SCOPE, searchGuestKey(slotId)).remaining).toBe(9);
    expect(budgetRemaining(limiter)).toBe(DEFAULT_SEARCH_PACING.searchBudgetLimit - 1);
    expect(dailyRemaining(limiter)).toBe(DEFAULT_SEARCH_PACING.searchDailyLimit - 1);
    expect(info).toHaveBeenCalledWith(
      '[search] deezer low-confidence q=mr brightside → provider served',
    );
    info.mockRestore();
  });

  it('serves a repeat of an escalated query from the provider cache without spending', async () => {
    const info = spyInfo();
    const { search, limiter, providerSearch, deezerScored } = buildHarness({
      order: ESCALATING,
      deezerConfident: false,
    });

    await search('mr brightside');
    const again = await search('Mr  Brightside');

    expect(((await again.json()) as Body).source).toBe('provider');
    expect(deezerScored).toHaveBeenCalledTimes(1);
    expect(providerSearch).toHaveBeenCalledTimes(1);
    expect(budgetRemaining(limiter)).toBe(DEFAULT_SEARCH_PACING.searchBudgetLimit - 1);
    info.mockRestore();
  });

  const refusals: Array<[string, Partial<SearchPacingConfig>, (h: Harness) => void]> = [
    [
      'busy',
      { searchBudgetLimit: 1 },
      (h) => h.limiter.tryApply(SEARCH_BUDGET_SCOPE, 'mock-streamer'),
    ],
    [
      'daily_limit',
      { searchDailyLimit: 1 },
      (h) => h.limiter.tryApply(SEARCH_DAILY_SCOPE, 'mock-streamer'),
    ],
    ['rate_limited', {}, (h) => h.failProviderWith(rateLimited())],
    ['error', {}, (h) => h.failProviderWith(new Error('boom'))],
  ];

  it.each(refusals)(
    'returns the deezer answer as external when the provider is refused (%s)',
    async (reason, pacing, setup) => {
      const info = spyInfo();
      const h = buildHarness({
        order: ESCALATING,
        deezerConfident: false,
        pacing: { ...pacing, searchGuestLimit: 10 },
      });
      const slotId = await h.addGuest('tok-a');
      setup(h);

      const res = await h.search('mr brightside', 'tok-a');

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        results: DEEZER_TRACKS,
        providerId: 'mock-streamer',
        source: 'external',
      });
      expect(h.limiter.peekSync(SEARCH_SCOPE, searchGuestKey(slotId)).remaining).toBe(9);
      expect(info).toHaveBeenCalledWith(
        `[search] deezer low-confidence q=mr brightside → provider refused:${reason}`,
      );
      info.mockRestore();
    },
  );

  it('returns the deezer answer while the provider search cooldown is open', async () => {
    const info = spyInfo();
    const cooldowns = new ProviderCooldowns();
    const { search, accountId, providerSearch, limiter } = buildHarness({
      order: ESCALATING,
      deezerConfident: false,
      cooldowns,
    });
    cooldowns.record(accountId, 'mock-streamer', 'search', 600);

    const res = await search('mr brightside');

    expect(res.status).toBe(200);
    expect(((await res.json()) as Body).source).toBe('external');
    expect(providerSearch).not.toHaveBeenCalled();
    expect(budgetRemaining(limiter)).toBe(DEFAULT_SEARCH_PACING.searchBudgetLimit);
    expect(info).toHaveBeenCalledWith(
      '[search] deezer low-confidence q=mr brightside → provider refused:provider_limited',
    );
    info.mockRestore();
  });

  it('spends no budget on an escalation refused by the daily cap', async () => {
    const info = spyInfo();
    const h = buildHarness({
      order: ESCALATING,
      deezerConfident: false,
      pacing: { searchDailyLimit: 1 },
    });
    h.limiter.tryApply(SEARCH_DAILY_SCOPE, 'mock-streamer');

    await h.search('mr brightside');

    expect(budgetRemaining(h.limiter)).toBe(DEFAULT_SEARCH_PACING.searchBudgetLimit);
    expect(h.providerSearch).not.toHaveBeenCalled();
    info.mockRestore();
  });

  it('serves a cached low-confidence deezer answer without retrying the provider', async () => {
    // Documented: the returned deezer answer is cached for the query like any
    // other, so a repeat within the cache TTL is a free cache hit, not a new
    // escalation (only a cached provider answer would be used).
    const info = spyInfo();
    const h = buildHarness({
      order: ESCALATING,
      deezerConfident: false,
      pacing: { searchBudgetLimit: 1 },
    });
    h.limiter.tryApply(SEARCH_BUDGET_SCOPE, 'mock-streamer');

    await h.search('mr brightside');
    const again = await h.search('mr brightside');

    expect(((await again.json()) as Body).source).toBe('external');
    expect(h.deezerScored).toHaveBeenCalledTimes(1);
    expect(h.providerSearch).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
    info.mockRestore();
  });

  it('never asks the provider when deezer is confident', async () => {
    const info = spyInfo();
    const { search, providerSearch, deezerScored } = buildHarness({
      order: ESCALATING,
      deezerConfident: true,
    });

    const res = await search('basket case');

    expect(((await res.json()) as Body).source).toBe('external');
    expect(deezerScored).toHaveBeenCalledTimes(1);
    expect(providerSearch).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    info.mockRestore();
  });

  it('never escalates when the provider is not listed after deezer', async () => {
    const info = spyInfo();
    const noProvider = buildHarness({ order: ['deezer', 'catalog'], deezerConfident: false });
    const res = await noProvider.search('mr brightside');
    expect(((await res.json()) as Body).source).toBe('external');
    expect(noProvider.providerSearch).not.toHaveBeenCalled();

    // Provider first and busy: deezer answers the fall-through with no second provider try.
    const before = buildHarness({
      order: ['provider', 'deezer', 'catalog'],
      deezerConfident: false,
      pacing: { searchBudgetLimit: 1 },
    });
    before.limiter.tryApply(SEARCH_BUDGET_SCOPE, 'mock-streamer');
    const fell = await before.search('mr brightside');
    expect(fell.status).toBe(200);
    expect(((await fell.json()) as Body).source).toBe('external');
    expect(before.providerSearch).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    info.mockRestore();
  });

  it('keeps the default provider,catalog order unchanged', async () => {
    const { search, providerSearch, deezerScored, deezerSearch } = buildHarness({
      deezerConfident: false,
    });

    const res = await search('mr brightside');

    expect(((await res.json()) as Body).source).toBe('provider');
    expect(providerSearch).toHaveBeenCalledTimes(1);
    expect(deezerScored).not.toHaveBeenCalled();
    expect(deezerSearch).not.toHaveBeenCalled();
  });
});
