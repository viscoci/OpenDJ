import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  DEFAULT_PROVIDER_COOLDOWN_MAX_SEC,
  DEFAULT_SEARCH_PACING,
  loadConfig,
  resolveSearchPacing,
} from '../src/config.js';

const minimalEnv = {
  DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/opendj',
};

describe('loadConfig', () => {
  it('parses a minimal env with defaults', () => {
    const config = loadConfig(minimalEnv);
    expect(config.databaseUrl).toBe('postgres://postgres:postgres@localhost:5432/opendj');
    expect(config.baseUrl).toBe('http://localhost:8888');
    expect(config.maxSongsPerGuest).toBe(3);
    expect(config.maxGuestsPerSession).toBeNull();
    expect(config.moderationEnabledDefault).toBe(false);
    expect(config.spotify).toBeUndefined();
  });

  it('parses MAX_SONGS_PER_GUEST as integer', () => {
    expect(loadConfig({ ...minimalEnv, MAX_SONGS_PER_GUEST: '5' }).maxSongsPerGuest).toBe(5);
  });

  it('falls back when MAX_SONGS_PER_GUEST is unparseable', () => {
    expect(
      loadConfig({ ...minimalEnv, MAX_SONGS_PER_GUEST: 'not-a-number' }).maxSongsPerGuest,
    ).toBe(3);
  });

  it('treats empty MAX_GUESTS_PER_SESSION as null (unlimited)', () => {
    expect(
      loadConfig({ ...minimalEnv, MAX_GUESTS_PER_SESSION: '' }).maxGuestsPerSession,
    ).toBeNull();
  });

  it('parses MAX_GUESTS_PER_SESSION when set', () => {
    expect(loadConfig({ ...minimalEnv, MAX_GUESTS_PER_SESSION: '50' }).maxGuestsPerSession).toBe(
      50,
    );
  });

  it('parses MODERATION_ENABLED_DEFAULT as boolean', () => {
    expect(
      loadConfig({ ...minimalEnv, MODERATION_ENABLED_DEFAULT: 'true' }).moderationEnabledDefault,
    ).toBe(true);
    expect(
      loadConfig({ ...minimalEnv, MODERATION_ENABLED_DEFAULT: '1' }).moderationEnabledDefault,
    ).toBe(true);
    expect(
      loadConfig({ ...minimalEnv, MODERATION_ENABLED_DEFAULT: 'false' }).moderationEnabledDefault,
    ).toBe(false);
  });

  it('attaches a Spotify config block when both id + secret are set', () => {
    const config = loadConfig({
      ...minimalEnv,
      SPOTIFY_CLIENT_ID: 'abc',
      SPOTIFY_CLIENT_SECRET: 'secret',
    });
    expect(config.spotify).toEqual({
      clientId: 'abc',
      clientSecret: 'secret',
      redirectUri: 'http://localhost:8888/api/v1/provider/connections/spotify/callback',
    });
  });

  it('respects an explicit SPOTIFY_REDIRECT_URI', () => {
    const config = loadConfig({
      ...minimalEnv,
      SPOTIFY_CLIENT_ID: 'abc',
      SPOTIFY_CLIENT_SECRET: 'secret',
      SPOTIFY_REDIRECT_URI: 'https://example.test/cb',
    });
    expect(config.spotify?.redirectUri).toBe('https://example.test/cb');
  });

  it('omits Spotify when only one of id/secret is set', () => {
    const config = loadConfig({ ...minimalEnv, SPOTIFY_CLIENT_ID: 'abc' });
    expect(config.spotify).toBeUndefined();
  });

  it('throws ConfigError listing every issue when DATABASE_URL is missing', () => {
    try {
      loadConfig({});
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).issues.length).toBeGreaterThan(0);
    }
  });

  it('rejects a non-URL DATABASE_URL', () => {
    expect(() => loadConfig({ DATABASE_URL: 'not-a-url' })).toThrow(ConfigError);
  });

  it('defaults the search pacing fields when their env vars are absent', () => {
    const config = loadConfig(minimalEnv);
    expect(DEFAULT_SEARCH_PACING).toEqual({
      searchBudgetLimit: 3,
      searchBudgetWindowMs: 30_000,
      searchGuestLimit: 5,
      searchAnonLimit: 5,
      searchWindowMs: 30_000,
      searchSlowDownThresholdPct: 30,
      searchSlowDownDebounceMs: 1_200,
      searchSlowDownTtlSec: 30,
      searchDailyLimit: 400,
    });
    expect(resolveSearchPacing(config)).toEqual(DEFAULT_SEARCH_PACING);
    expect(config).toMatchObject(DEFAULT_SEARCH_PACING);
  });

  it('parses the search pacing env vars', () => {
    const config = loadConfig({
      ...minimalEnv,
      SEARCH_BUDGET_LIMIT: '8',
      SEARCH_BUDGET_WINDOW_MS: '60000',
      SEARCH_GUEST_LIMIT: '6',
      SEARCH_ANON_LIMIT: '4',
      SEARCH_WINDOW_MS: '20000',
      SEARCH_SLOWDOWN_THRESHOLD_PCT: '50',
      SEARCH_SLOWDOWN_DEBOUNCE_MS: '900',
      SEARCH_SLOWDOWN_TTL_SEC: '45',
      SEARCH_DAILY_LIMIT: '250',
    });
    expect(resolveSearchPacing(config)).toEqual({
      searchBudgetLimit: 8,
      searchBudgetWindowMs: 60_000,
      searchGuestLimit: 6,
      searchAnonLimit: 4,
      searchWindowMs: 20_000,
      searchSlowDownThresholdPct: 50,
      searchSlowDownDebounceMs: 900,
      searchSlowDownTtlSec: 45,
      searchDailyLimit: 250,
    });
  });

  it('falls back to defaults when a search pacing env var is unparseable', () => {
    expect(loadConfig({ ...minimalEnv, SEARCH_BUDGET_LIMIT: 'lots' }).searchBudgetLimit).toBe(3);
  });

  it.each([
    'SEARCH_BUDGET_LIMIT',
    'SEARCH_BUDGET_WINDOW_MS',
    'SEARCH_GUEST_LIMIT',
    'SEARCH_ANON_LIMIT',
    'SEARCH_WINDOW_MS',
    'SEARCH_SLOWDOWN_DEBOUNCE_MS',
    'SEARCH_SLOWDOWN_TTL_SEC',
    'SEARCH_DAILY_LIMIT',
  ])('rejects a non-positive %s', (name) => {
    expect(() => loadConfig({ ...minimalEnv, [name]: '0' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...minimalEnv, [name]: '-3' })).toThrow(ConfigError);
  });

  it('accepts a slow-down threshold of 0..100 and rejects values outside it', () => {
    expect(
      loadConfig({ ...minimalEnv, SEARCH_SLOWDOWN_THRESHOLD_PCT: '0' }).searchSlowDownThresholdPct,
    ).toBe(0);
    expect(
      loadConfig({ ...minimalEnv, SEARCH_SLOWDOWN_THRESHOLD_PCT: '100' })
        .searchSlowDownThresholdPct,
    ).toBe(100);
    expect(() => loadConfig({ ...minimalEnv, SEARCH_SLOWDOWN_THRESHOLD_PCT: '101' })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ ...minimalEnv, SEARCH_SLOWDOWN_THRESHOLD_PCT: '-1' })).toThrow(
      ConfigError,
    );
  });

  it('resolveSearchPacing fills defaults for a hand-built config missing the fields', () => {
    const { searchBudgetLimit: _a, searchAnonLimit: _b, ...partial } = loadConfig(minimalEnv);
    expect(resolveSearchPacing({ ...partial, searchAnonLimit: 9 })).toEqual({
      ...DEFAULT_SEARCH_PACING,
      searchAnonLimit: 9,
    });
  });

  it('defaults the persisted provider cooldown cap to 24h', () => {
    expect(DEFAULT_PROVIDER_COOLDOWN_MAX_SEC).toBe(86_400);
    expect(loadConfig(minimalEnv).providerCooldownMaxSec).toBe(86_400);
  });

  it('parses PROVIDER_COOLDOWN_MAX_SEC and rejects non-positive values', () => {
    expect(
      loadConfig({ ...minimalEnv, PROVIDER_COOLDOWN_MAX_SEC: '3600' }).providerCooldownMaxSec,
    ).toBe(3600);
    expect(
      loadConfig({ ...minimalEnv, PROVIDER_COOLDOWN_MAX_SEC: 'soon' }).providerCooldownMaxSec,
    ).toBe(86_400);
    expect(() => loadConfig({ ...minimalEnv, PROVIDER_COOLDOWN_MAX_SEC: '0' })).toThrow(
      ConfigError,
    );
  });

  it('attaches VALKEY_URL when provided', () => {
    const config = loadConfig({ ...minimalEnv, VALKEY_URL: 'redis://localhost:6379' });
    expect(config.valkeyUrl).toBe('redis://localhost:6379');
  });
});
