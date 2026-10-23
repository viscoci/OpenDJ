/**
 * Add-time track resolution: catalog → Sonovault → provider ISRC search.
 * fetch and the provider are mocks; no network.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  defineCapabilities,
  PROVIDER_FEATURES,
  type IStreamingProvider,
  type ISupportsSearch,
  type Track,
} from '@opendj/core';
import { TrackCatalog } from '../../src/catalog/TrackCatalog.js';
import { DEFAULT_SEARCH_PACING } from '../../src/config.js';
import { ProviderCooldowns } from '../../src/providers/streaming/ProviderCooldowns.js';
import type { ProviderRegistry } from '../../src/providers/streaming/providerRegistry.js';
import { StreamingRouter } from '../../src/providers/streaming/StreamingRouter.js';
import {
  createSearchRateLimiter,
  SEARCH_BUDGET_SCOPE,
  SEARCH_DAILY_SCOPE,
} from '../../src/rate-limit/SlidingWindowRateLimiter.js';
import { createInMemoryRepositories } from '../../src/repositories/in-memory/index.js';
import {
  CatalogTrackResolver,
  ProviderIsrcTrackResolver,
  TrackResolverChain,
  type TrackResolver,
} from '../../src/track-resolution/TrackResolver.js';
import { SonovaultTrackResolver } from '../../src/track-resolution/SonovaultTrackResolver.js';

const ISRC = 'GBDUW0000053';
const REQ = { accountId: 'acc-1', providerId: 'spotify', isrc: ISRC };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fixed(
  id: string,
  uri: string | null,
): TrackResolver & { resolve: ReturnType<typeof vi.fn> } {
  return { id, resolve: vi.fn(async () => uri) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('TrackResolverChain', () => {
  it('returns the first native answer and asks no later resolver', async () => {
    const a = fixed('a', null);
    const b = fixed('b', 'spotify:track:B');
    const c = fixed('c', 'spotify:track:C');

    expect(await new TrackResolverChain([a, b, c]).resolve(REQ)).toEqual({
      uri: 'spotify:track:B',
      resolverId: 'b',
    });
    expect(a.resolve).toHaveBeenCalledWith(REQ);
    expect(c.resolve).not.toHaveBeenCalled();
  });

  it('skips a resolver that throws or answers a non-native uri', async () => {
    const throws: TrackResolver = {
      id: 'throws',
      resolve: async () => {
        throw new Error('boom');
      },
    };
    const foreign = fixed('foreign', 'apple-music:track:1');
    const good = fixed('good', 'spotify:track:G');

    const chain = new TrackResolverChain([throws, foreign, good], { error: () => {} });
    expect(await chain.resolve(REQ)).toEqual({ uri: 'spotify:track:G', resolverId: 'good' });
  });

  it('answers null when nothing resolves', async () => {
    expect(await new TrackResolverChain([fixed('a', null)]).resolve(REQ)).toBeNull();
  });
});

describe('CatalogTrackResolver', () => {
  async function catalogWith(tracks: Track[]): Promise<TrackCatalog> {
    const repositories = createInMemoryRepositories();
    const catalog = new TrackCatalog({
      repository: repositories.trackCatalog,
      queueItems: repositories.queueItems,
      sessions: repositories.sessions,
      providerConnections: repositories.providerConnections,
    });
    catalog.recordSeen('spotify', tracks);
    await catalog.whenIdle();
    return catalog;
  }

  const base = { name: 'One More Time', artist: 'Daft Punk', albumArt: null, durationMs: 1 };

  it('answers a native row with the same ISRC for the provider', async () => {
    const catalog = await catalogWith([
      { ...base, uri: `opendj:isrc:${ISRC}`, isrc: ISRC },
      { ...base, uri: 'spotify:track:native', isrc: ISRC },
    ]);
    expect(await new CatalogTrackResolver(catalog).resolve(REQ)).toBe('spotify:track:native');
  });

  it('ignores rows that are not native to the provider', async () => {
    const catalog = await catalogWith([{ ...base, uri: `opendj:isrc:${ISRC}`, isrc: ISRC }]);
    expect(await new CatalogTrackResolver(catalog).resolve(REQ)).toBeNull();
  });
});

describe('SonovaultTrackResolver', () => {
  const LINKS = {
    isrc: ISRC,
    links: [
      { platform: 'Apple Music', url: 'https://music.apple.com/us/song/1' },
      { platform: 'Spotify', url: 'https://open.spotify.com/track/0DiWol3AO6WpXZgp0goxAV?si=x' },
    ],
  };

  it('looks up the ISRC with the API key and maps the Spotify link', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(LINKS));
    const resolver = new SonovaultTrackResolver({ apiKey: 'sv-key', fetchImpl });

    expect(await resolver.resolve(REQ)).toBe('spotify:track:0DiWol3AO6WpXZgp0goxAV');

    const [url, init] = fetchImpl.mock.calls[0]!;
    const parsed = new URL(String(url));
    expect(parsed.origin + parsed.pathname).toBe('https://api.sonovault.now/v1/tracks/links');
    expect(parsed.searchParams.get('isrc')).toBe(ISRC);
    expect(new Headers(init?.headers).get('x-api-key')).toBe('sv-key');
  });

  it.each([
    [{ links: [{ name: 'spotify', id: '0DiWol3AO6WpXZgp0goxAV' }] }],
    [{ links: [{ service: 'SPOTIFY', link: 'spotify:track:0DiWol3AO6WpXZgp0goxAV' }] }],
    [{ links: { spotify: { url: 'https://open.spotify.com/track/0DiWol3AO6WpXZgp0goxAV' } } }],
    [{ links: { spotify: 'https://open.spotify.com/track/0DiWol3AO6WpXZgp0goxAV' } }],
    // Sonovault's live shape (verified 2026-10-23): `source` + `external_id` + `url`.
    [
      {
        track_id: 104195873,
        isrc: ISRC,
        links: [
          {
            source: 'applemusic',
            external_id: '711069',
            url: 'https://music.apple.com/song/711069',
          },
          {
            source: 'spotify',
            external_id: '0DiWol3AO6WpXZgp0goxAV',
            url: 'https://open.spotify.com/track/0DiWol3AO6WpXZgp0goxAV',
          },
        ],
      },
    ],
    [{ links: [{ source: 'spotify', external_id: '0DiWol3AO6WpXZgp0goxAV' }] }],
  ])('reads link shape %j defensively', async (body) => {
    const resolver = new SonovaultTrackResolver({
      apiKey: 'k',
      fetchImpl: vi.fn<typeof fetch>(async () => jsonResponse(body)),
    });
    expect(await resolver.resolve(REQ)).toBe('spotify:track:0DiWol3AO6WpXZgp0goxAV');
  });

  it('caches an answer per ISRC', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(LINKS));
    const resolver = new SonovaultTrackResolver({ apiKey: 'k', fetchImpl });

    await resolver.resolve(REQ);
    expect(await resolver.resolve(REQ)).toBe('spotify:track:0DiWol3AO6WpXZgp0goxAV');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('caches a miss for 10 minutes', async () => {
    let now = 1_000_000;
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ error: 'not found' }, 404));
    const resolver = new SonovaultTrackResolver({ apiKey: 'k', fetchImpl, now: () => now });

    expect(await resolver.resolve(REQ)).toBeNull();
    expect(await resolver.resolve(REQ)).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now += 10 * 60_000 + 1;
    await resolver.resolve(REQ);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('caches links without one for the provider as a miss for that provider', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({ links: [{ platform: 'Apple Music', url: 'https://music.apple.com/x' }] }),
    );
    const resolver = new SonovaultTrackResolver({ apiKey: 'k', fetchImpl });

    expect(await resolver.resolve(REQ)).toBeNull();
    expect(await resolver.resolve(REQ)).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('never caches a server error or network failure', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({}, 500))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse(LINKS));
    const resolver = new SonovaultTrackResolver({ apiKey: 'k', fetchImpl });

    expect(await resolver.resolve(REQ)).toBeNull();
    expect(await resolver.resolve(REQ)).toBeNull();
    expect(await resolver.resolve(REQ)).toBe('spotify:track:0DiWol3AO6WpXZgp0goxAV');
  });

  it('stops calling once its own limit (18/min) is spent', async () => {
    let now = 1_000_000;
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({}, 500));
    const resolver = new SonovaultTrackResolver({ apiKey: 'k', fetchImpl, now: () => now });

    for (let i = 0; i < 20; i += 1) await resolver.resolve(REQ);
    expect(fetchImpl).toHaveBeenCalledTimes(18);

    now += 60_001;
    await resolver.resolve(REQ);
    expect(fetchImpl).toHaveBeenCalledTimes(19);
  });

  it('times out a slow lookup as a miss', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const resolver = new SonovaultTrackResolver({ apiKey: 'k', fetchImpl });

    const pending = resolver.resolve(REQ);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await pending).toBeNull();
  });
});

describe('ProviderIsrcTrackResolver', () => {
  function harness(opts: { daily?: number; budget?: number; results?: Track[] } = {}) {
    const repositories = createInMemoryRepositories();
    const search = vi.fn(
      async (_q: string, _limit?: number) =>
        opts.results ?? [
          {
            uri: 'spotify:track:fromSearch',
            name: 'One More Time',
            artist: 'Daft Punk',
            albumArt: null,
            durationMs: 1,
          },
        ],
    );
    const provider: IStreamingProvider & ISupportsSearch = {
      providerId: 'spotify',
      displayName: 'Spotify',
      async connect() {},
      async disconnect() {},
      isConnected: () => true,
      async refreshCredentials() {
        return {};
      },
      getCapabilities: () =>
        defineCapabilities('spotify', {
          [PROVIDER_FEATURES.Search]: {
            id: PROVIDER_FEATURES.Search,
            supported: true,
            access: 'guest',
            reliability: 'native',
          },
        }),
      search,
    };
    const cooldowns = new ProviderCooldowns();
    const router = new StreamingRouter({
      providerConnections: repositories.providerConnections,
      registry: { spotify: () => provider } as unknown as ProviderRegistry,
      context: { fetch: globalThis.fetch },
      cooldowns,
    });
    void repositories.providerConnections.upsert({
      accountId: 'acc-1',
      providerId: 'spotify',
      accessToken: 'tok',
    });
    const limiter = createSearchRateLimiter({
      ...DEFAULT_SEARCH_PACING,
      searchDailyLimit: opts.daily ?? 10,
      searchBudgetLimit: opts.budget ?? 10,
    });
    const resolver = new ProviderIsrcTrackResolver({
      streamingRouter: router,
      searchRateLimiter: limiter,
    });
    return { resolver, search, limiter, cooldowns };
  }

  it('searches the provider by ISRC and spends a daily and a budget unit', async () => {
    const { resolver, search, limiter } = harness();

    expect(await resolver.resolve(REQ)).toBe('spotify:track:fromSearch');
    expect(search).toHaveBeenCalledWith(`isrc:${ISRC}`, expect.any(Number));
    expect(limiter.peekSync(SEARCH_DAILY_SCOPE, 'spotify').remaining).toBe(9);
    expect(limiter.peekSync(SEARCH_BUDGET_SCOPE, 'spotify').remaining).toBe(9);
  });

  it('never calls the provider when the daily cap is spent', async () => {
    const { resolver, search, limiter } = harness({ daily: 1 });
    limiter.tryApply(SEARCH_DAILY_SCOPE, 'spotify');

    expect(await resolver.resolve(REQ)).toBeNull();
    expect(search).not.toHaveBeenCalled();
    expect(limiter.peekSync(SEARCH_BUDGET_SCOPE, 'spotify').remaining).toBe(10);
  });

  it('never calls the provider when the budget is spent', async () => {
    const { resolver, search, limiter } = harness({ budget: 1 });
    limiter.tryApply(SEARCH_BUDGET_SCOPE, 'spotify');

    expect(await resolver.resolve(REQ)).toBeNull();
    expect(search).not.toHaveBeenCalled();
    expect(limiter.peekSync(SEARCH_DAILY_SCOPE, 'spotify').remaining).toBe(10);
  });

  it('never calls the provider while its search cooldown is open', async () => {
    const { resolver, search, cooldowns, limiter } = harness();
    cooldowns.record('acc-1', 'spotify', 'search', 600);

    expect(await resolver.resolve(REQ)).toBeNull();
    expect(search).not.toHaveBeenCalled();
    expect(limiter.peekSync(SEARCH_DAILY_SCOPE, 'spotify').remaining).toBe(10);
  });

  it('answers null when the provider finds nothing native', async () => {
    const { resolver } = harness({ results: [] });
    expect(await resolver.resolve(REQ)).toBeNull();
  });
});

describe('resolver chain order', () => {
  it('answers from the catalog without any network call', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({}));
    const chain = new TrackResolverChain([
      fixed('catalog', 'spotify:track:cached'),
      new SonovaultTrackResolver({ apiKey: 'k', fetchImpl }),
    ]);

    expect(await chain.resolve(REQ)).toEqual({
      uri: 'spotify:track:cached',
      resolverId: 'catalog',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uses Sonovault when the catalog misses', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({ links: [{ platform: 'spotify', id: 'abc123' }] }),
    );
    const providerFallback = fixed('provider', 'spotify:track:fromProvider');
    const chain = new TrackResolverChain([
      fixed('catalog', null),
      new SonovaultTrackResolver({ apiKey: 'k', fetchImpl }),
      providerFallback,
    ]);

    expect(await chain.resolve(REQ)).toEqual({
      uri: 'spotify:track:abc123',
      resolverId: 'sonovault',
    });
    expect(providerFallback.resolve).not.toHaveBeenCalled();
  });
});
