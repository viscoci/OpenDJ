/**
 * /api/v1/sessions/:id/search — search proxy route.
 *
 * Uses a hand-rolled mock provider implementing IStreamingProvider +
 * ISupportsSearch. No real network calls.
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
  InMemoryProviderConnectionRepository,
  InMemorySessionRepository,
} from '../../src/repositories/in-memory/index.js';
import { searchRoutes } from '../../src/routes/search.js';
import { ProviderRateLimitedError } from '../../src/providers/streaming/ProviderCooldowns.js';
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
  async search(query: string, limit = 20): Promise<Track[]> {
    this.calls += 1;
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
  } = {},
) {
  const sessions = new InMemorySessionRepository();
  const providerConnections = new InMemoryProviderConnectionRepository();

  const mockProvider = new MockSearchProvider();
  mockProvider.setResults(SAMPLE_TRACKS);
  const muteProvider = new NoSearchProvider();
  const registry: ProviderRegistry = {
    'mock-streamer': () => mockProvider,
    'mute-provider': () => muteProvider,
  } as unknown as ProviderRegistry;

  const router = new StreamingRouter({
    providerConnections,
    registry,
    context: { fetch: globalThis.fetch },
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
    }),
  );
  return { app, sessionId, mockProvider };
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
    mockProvider.failWith = new ProviderRateLimitedError('mock-streamer', now + 120_000, now);

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
