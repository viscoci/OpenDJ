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
    sonovault?: SourceTrack[] | 'unavailable';
    pacing?: Partial<SearchPacingConfig>;
  } = {},
) {
  const sessions = new InMemorySessionRepository();
  const providerConnections = new InMemoryProviderConnectionRepository();
  const guestSlots = new InMemoryGuestSlotRepository();
  const pacing: SearchPacingConfig = { ...DEFAULT_SEARCH_PACING, ...opts.pacing };
  const limiter = createSearchRateLimiter(pacing, () => Date.now());

  const providerSearch = vi.fn(async (_q: string, limit = 20) => PROVIDER_TRACKS.slice(0, limit));
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
  });

  const catalog = new TrackCatalog({
    repository: new InMemoryTrackCatalogRepository(),
    queueItems: new InMemoryQueueItemRepository(),
    sessions,
    providerConnections,
  });

  let deezerAnswer: SourceTrack[] | 'unavailable' = opts.deezer ?? DEEZER_TRACKS;
  const deezerSearch = vi.fn<SearchSource['search']>(async () => deezerAnswer);
  const deezer: SearchSource = { id: 'deezer', search: deezerSearch };
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
    sonovaultSearch,
    setDeezer: (answer: SourceTrack[] | 'unavailable') => {
      deezerAnswer = answer;
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
