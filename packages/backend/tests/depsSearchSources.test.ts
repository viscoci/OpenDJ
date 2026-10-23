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

function build(config: Config, fetchImpl: typeof fetch = vi.fn<typeof fetch>()) {
  return createDeps({
    config,
    repositories: createInMemoryRepositories(),
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
