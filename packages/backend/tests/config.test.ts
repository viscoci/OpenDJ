import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

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

  it('attaches VALKEY_URL when provided', () => {
    const config = loadConfig({ ...minimalEnv, VALKEY_URL: 'redis://localhost:6379' });
    expect(config.valkeyUrl).toBe('redis://localhost:6379');
  });
});
