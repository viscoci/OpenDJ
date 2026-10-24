import { describe, expect, it } from 'vitest';
import type { Config } from '../../src/config.js';
import { createDeps } from '../../src/deps.js';
import { createInMemoryRepositories } from '../../src/repositories/in-memory/index.js';
import { SEARCH_DAILY_SCOPE } from '../../src/rate-limit/SlidingWindowRateLimiter.js';

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

const HALO = {
  uri: 'spotify:track:halo',
  name: 'Halo',
  artist: 'Beyoncé',
  albumArt: null,
  durationMs: 261_000,
};

describe('createDeps — search daily cap', () => {
  it('builds the daily scope from searchDailyLimit, defaulting to 400 per 24h', () => {
    const defaults = createDeps({
      config: fakeConfig(),
      repositories: createInMemoryRepositories(),
      realtime: 'none',
    });
    expect(defaults.searchRateLimiter.peekSync(SEARCH_DAILY_SCOPE, 'spotify')).toMatchObject({
      limit: 400,
      windowMs: 86_400_000,
    });

    const custom = createDeps({
      config: fakeConfig({ searchDailyLimit: 7 }),
      repositories: createInMemoryRepositories(),
      realtime: 'none',
    });
    expect(custom.searchRateLimiter.peekSync(SEARCH_DAILY_SCOPE, 'spotify').limit).toBe(7);
  });
});

describe('createDeps — local track catalog', () => {
  it('keeps catalog entries across a fresh deps instance over the same repositories', async () => {
    const repositories = createInMemoryRepositories();
    const first = createDeps({ config: fakeConfig(), repositories, realtime: 'none' });
    first.trackCatalog.recordSeen('spotify', [HALO]);
    await first.trackCatalog.whenIdle();

    const second = createDeps({ config: fakeConfig(), repositories, realtime: 'none' });

    expect(await second.trackCatalog.search('spotify', 'halo', 10)).toMatchObject([
      { trackUri: HALO.uri, timesSeen: 1 },
    ]);
  });

  it('backfills an empty catalog from queue items at boot without blocking createDeps', async () => {
    const repositories = createInMemoryRepositories();
    await repositories.providerConnections.upsert({
      accountId: 'acct-1',
      providerId: 'spotify',
      accessToken: 'tok',
    });
    const session = await repositories.sessions.create({
      accountId: 'acct-1',
      name: 'Old party',
      qrSlug: 'old-party',
    });
    await repositories.queueItems.create({
      sessionId: session.id,
      guestId: 'g',
      trackUri: HALO.uri,
      trackName: HALO.name,
      artistName: HALO.artist,
    });

    const deps = createDeps({ config: fakeConfig(), repositories, realtime: 'none' });
    expect(await repositories.trackCatalog.findAll()).toEqual([]);
    await deps.trackCatalog.whenIdle();

    expect(await repositories.trackCatalog.findAll()).toMatchObject([
      { providerId: 'spotify', trackUri: HALO.uri, timesRequested: 1 },
    ]);
  });

  it('records requests accepted by the queue service', async () => {
    const repositories = createInMemoryRepositories();
    await repositories.providerConnections.upsert({
      accountId: 'acct-1',
      providerId: 'spotify',
      accessToken: 'tok',
    });
    const session = await repositories.sessions.create({
      accountId: 'acct-1',
      name: 'Party',
      qrSlug: 'party',
      moderationEnabled: true,
    });
    await repositories.guests.create({ sessionId: session.id, fingerprint: 'fp-1', userId: null });
    await repositories.guestSlots.create({
      sessionId: session.id,
      fingerprintHash: 'fp-1',
      slotToken: 'slot-1',
      status: 'active',
    });
    const deps = createDeps({ config: fakeConfig(), repositories, realtime: 'none' });
    // Let the boot backfill finish first so it can't also count this request.
    await deps.trackCatalog.whenIdle();

    await deps.queueService.requestTrack({
      sessionId: session.id,
      slotToken: 'slot-1',
      track: HALO,
    });
    await deps.trackCatalog.whenIdle();

    expect(await repositories.trackCatalog.findAll()).toMatchObject([
      { providerId: 'spotify', trackUri: HALO.uri, timesRequested: 1, timesSeen: 0 },
    ]);
  });
});
