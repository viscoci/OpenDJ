import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import { createDeps } from '../src/deps.js';
import { createInMemoryRepositories } from '../src/repositories/in-memory/index.js';
import { DeezerSearchSource } from '../src/search-sources/DeezerSearchSource.js';
import { SonovaultSearchSource } from '../src/search-sources/SonovaultSearchSource.js';

function fakeConfig(overrides: Partial<Config> = {}): Config {
  return {
    databaseUrl: 'postgres://localhost/test',
    baseUrl: 'http://localhost:8888',
    loginProviders: {},
    postLoginPath: '/',
    postProviderCallbackPath: '/host/dashboard',
    maxSongsPerGuest: 3,
    maxGuestsPerSession: null,
    moderationEnabledDefault: false,
    ...overrides,
  };
}

function build(
  config: Config,
  fetchImpl: typeof fetch = vi.fn<typeof fetch>(),
  repositories = createInMemoryRepositories(),
) {
  return createDeps({
    config,
    repositories,
    realtime: 'none',
    fetchImpl,
  });
}

describe('createDeps — search sources and track resolution', () => {
  it('keeps the default order and wires no external source by default', () => {
    const deps = build(fakeConfig());
    expect(deps.searchSources).toEqual(['provider', 'catalog']);
    expect(deps.externalSearchSources).toEqual({});
    expect(deps.trackResolver.ids).toEqual(['catalog', 'provider']);
  });

  it('wires Deezer only when SEARCH_SOURCES lists it', () => {
    const deps = build(fakeConfig({ searchSources: ['deezer', 'catalog', 'provider'] }));
    expect(deps.searchSources).toEqual(['deezer', 'catalog', 'provider']);
    expect(deps.externalSearchSources.deezer).toBeInstanceOf(DeezerSearchSource);
  });

  it("ranks Deezer hits with the catalog's request counts", async () => {
    const item = (title: string, artist: string, rank: number, isrc: string) => ({
      id: rank,
      title,
      isrc,
      duration: 200,
      rank,
      artist: { name: artist },
      album: { cover_medium: null },
    });
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              item('Mr. Brightside', 'Part Time Killer', 500_000, 'QZAAA2000001'),
              item('Mr. Brightside', 'ItaloBrothers', 420_000, 'DEA621500001'),
            ],
          }),
        ),
    );
    const repositories = createInMemoryRepositories();
    await repositories.providerConnections.upsert({
      accountId: 'acc-1',
      providerId: 'spotify',
      accessToken: 'tok',
    });
    const deps = build(
      fakeConfig({ searchSources: ['deezer', 'catalog'] }),
      fetchImpl,
      repositories,
    );
    deps.trackCatalog.recordRequested('acc-1', {
      uri: 'spotify:track:italo',
      name: 'Mr. Brightside',
      artist: 'ItaloBrothers',
      albumArt: null,
      durationMs: 200_000,
      isrc: 'DEA621500001',
    });
    await deps.trackCatalog.whenIdle();

    const results = await deps.externalSearchSources.deezer!.search('mr brightside', 5, {
      accountId: 'acc-1',
      providerId: 'spotify',
    });

    expect(results !== 'unavailable' && results[0]?.artistName).toBe('ItaloBrothers');
  });

  it('wires Sonovault search when SEARCH_SOURCES lists it and a key is set', () => {
    const deps = build(
      fakeConfig({
        searchSources: ['deezer', 'catalog', 'sonovault', 'provider'],
        sonovaultApiKey: 'sv-key',
      }),
    );
    expect(deps.externalSearchSources.sonovault).toBeInstanceOf(SonovaultSearchSource);
    expect(deps.searchSources).toEqual(['deezer', 'catalog', 'sonovault', 'provider']);
  });

  it('leaves Sonovault search off when a key is set but SEARCH_SOURCES omits it', () => {
    const deps = build(fakeConfig({ sonovaultApiKey: 'sv-key' }));
    expect(deps.externalSearchSources.sonovault).toBeUndefined();
  });

  it('disables a listed Sonovault search without a key and warns at startup', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const deps = build(fakeConfig({ searchSources: ['sonovault', 'provider'] }));
      expect(deps.externalSearchSources.sonovault).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/sonovault.*SONOVAULT_API_KEY/i));
    } finally {
      warn.mockRestore();
    }
  });

  it('adds Sonovault between the catalog and the provider when a key is set', () => {
    const deps = build(fakeConfig({ sonovaultApiKey: 'sv-key' }));
    expect(deps.trackResolver.ids).toEqual(['catalog', 'sonovault', 'provider']);
  });

  it('verifies Spotify resolutions by default', () => {
    expect(build(fakeConfig()).trackResolver.verifiedProviders).toEqual(['spotify']);
  });

  it('wires no verifier when track verification is off', () => {
    expect(build(fakeConfig({ trackVerify: false })).trackResolver.verifiedProviders).toEqual([]);
  });
});
