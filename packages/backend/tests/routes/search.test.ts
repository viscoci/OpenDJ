/**
 * /api/v1/sessions/:id/search — search proxy route.
 *
 * Uses a hand-rolled mock provider implementing IStreamingProvider +
 * ISupportsSearch. No real network calls.
 */

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
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
import { StreamingRouter } from '../../src/providers/streaming/StreamingRouter.js';
import type { ProviderRegistry } from '../../src/providers/streaming/providerRegistry.js';

class MockSearchProvider implements IStreamingProvider, ISupportsSearch {
  readonly providerId = 'mock-streamer';
  readonly displayName = 'Mock Streamer';
  private connected = false;
  private lastQuery: string | null = null;
  private resultsToReturn: Track[] = [];

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
      moderationEnabled: false,
      voteSkipMode: 'fixed',
      voteSkipThreshold: 5,
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
