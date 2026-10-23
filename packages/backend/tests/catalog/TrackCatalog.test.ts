import { describe, expect, it, vi } from 'vitest';
import type { Track } from '@opendj/core';
import { TrackCatalog } from '../../src/catalog/TrackCatalog.js';
import {
  createInMemoryRepositories,
  InMemoryTrackCatalogRepository,
} from '../../src/repositories/in-memory/index.js';
import type { Repositories, TrackCatalogRepository } from '../../src/repositories/types.js';

const ACCOUNT = 'acct-1';

const TRACKS: Track[] = [
  {
    uri: 'spotify:track:1',
    name: 'Crazy in Love',
    artist: 'Beyoncé',
    albumArt: 'https://art/1',
    durationMs: 236_000,
  },
  { uri: 'spotify:track:2', name: 'Halo', artist: 'Beyoncé', albumArt: null, durationMs: 261_000 },
];

function catalogFor(repositories: Repositories, logger?: Pick<Console, 'error'>): TrackCatalog {
  return new TrackCatalog({
    repository: repositories.trackCatalog,
    queueItems: repositories.queueItems,
    sessions: repositories.sessions,
    providerConnections: repositories.providerConnections,
    ...(logger && { logger }),
  });
}

async function seedSession(
  repositories: Repositories,
  name: string,
  accountId = ACCOUNT,
): Promise<string> {
  const session = await repositories.sessions.create({
    accountId,
    name,
    qrSlug: `slug-${name}`,
  });
  return session.id;
}

async function connectSpotify(repositories: Repositories, accountId = ACCOUNT): Promise<void> {
  await repositories.providerConnections.upsert({
    accountId,
    providerId: 'spotify',
    accessToken: 'tok',
  });
}

describe('TrackCatalog', () => {
  it('records provider results as seen and counts repeats', async () => {
    const repositories = createInMemoryRepositories();
    const catalog = catalogFor(repositories);

    catalog.recordSeen('spotify', TRACKS);
    catalog.recordSeen('spotify', TRACKS.slice(0, 1));
    await catalog.whenIdle();

    const rows = await repositories.trackCatalog.findAll();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.trackUri === 'spotify:track:1')).toMatchObject({
      providerId: 'spotify',
      trackName: 'Crazy in Love',
      artistName: 'Beyoncé',
      albumArtUrl: 'https://art/1',
      durationMs: 236_000,
      timesSeen: 2,
      timesRequested: 0,
    });
    expect(await catalog.search('spotify', 'crazy', 10)).toMatchObject([
      { trackUri: 'spotify:track:1', timesSeen: 2 },
    ]);
  });

  it("records a queue request against the account's provider", async () => {
    const repositories = createInMemoryRepositories();
    await connectSpotify(repositories);
    const catalog = catalogFor(repositories);

    catalog.recordRequested(ACCOUNT, TRACKS[1]!);
    await catalog.whenIdle();

    expect(await repositories.trackCatalog.findAll()).toMatchObject([
      { providerId: 'spotify', trackUri: 'spotify:track:2', timesRequested: 1, timesSeen: 0 },
    ]);
    expect(await catalog.search('spotify', 'halo', 10)).toHaveLength(1);
  });

  it('logs a failed write and never throws', async () => {
    const repositories = createInMemoryRepositories();
    const failing: TrackCatalogRepository = {
      findAll: async () => [],
      search: async () => [],
      upsertMany: async () => {
        throw new Error('db down');
      },
    };
    const logger = { error: vi.fn() };
    const catalog = catalogFor({ ...repositories, trackCatalog: failing }, logger);

    expect(() => catalog.recordSeen('spotify', TRACKS)).not.toThrow();
    await expect(catalog.whenIdle()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });

  it('serves nothing (and logs) when the catalog cannot be loaded', async () => {
    const repositories = createInMemoryRepositories();
    const broken: TrackCatalogRepository = {
      findAll: async () => {
        throw new Error('db down');
      },
      search: async () => [],
      upsertMany: async () => undefined,
    };
    const logger = { error: vi.fn() };
    const catalog = catalogFor({ ...repositories, trackCatalog: broken }, logger);

    await expect(catalog.search('spotify', 'halo', 10)).resolves.toEqual([]);
    expect(logger.error).toHaveBeenCalled();
  });

  it('backfills an empty catalog from the queue items of every session', async () => {
    const repositories = createInMemoryRepositories();
    await connectSpotify(repositories);
    const s1 = await seedSession(repositories, 's1');
    const s2 = await seedSession(repositories, 's2');
    const orphan = await seedSession(repositories, 's3', 'acct-without-provider');
    const items: Array<[string, Track]> = [
      [s1, TRACKS[0]!],
      [s2, TRACKS[0]!],
      [s2, TRACKS[1]!],
      [orphan, TRACKS[1]!],
    ];
    for (const [sessionId, track] of items) {
      await repositories.queueItems.create({
        sessionId,
        guestId: 'g',
        trackUri: track.uri,
        trackName: track.name,
        artistName: track.artist,
        albumArtUrl: track.albumArt,
        durationMs: track.durationMs,
      });
    }
    const catalog = catalogFor(repositories);

    const results = await catalog.search('spotify', 'beyonce', 10);

    expect(results.map((r) => [r.trackUri, r.timesRequested])).toEqual([
      ['spotify:track:1', 2],
      ['spotify:track:2', 1],
    ]);
    const rows = await repositories.trackCatalog.findAll();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.providerId === 'spotify')).toBe(true);
  });

  it('does not backfill a catalog that already has rows', async () => {
    const repositories = createInMemoryRepositories();
    await connectSpotify(repositories);
    const s1 = await seedSession(repositories, 's1');
    await repositories.queueItems.create({
      sessionId: s1,
      guestId: 'g',
      trackUri: 'spotify:track:queued',
      trackName: 'Queued Song',
      artistName: 'Someone',
    });
    const repo = new InMemoryTrackCatalogRepository();
    await repo.upsertMany([
      {
        providerId: 'spotify',
        trackUri: 'spotify:track:existing',
        trackName: 'Existing',
        artistName: 'Someone',
        albumArtUrl: null,
        durationMs: null,
        seenIncrement: 1,
        requestedIncrement: 0,
        seenAt: new Date(),
      },
    ]);
    const catalog = catalogFor({ ...repositories, trackCatalog: repo });

    expect(await catalog.search('spotify', 'queued', 10)).toEqual([]);
    expect(await repo.findAll()).toHaveLength(1);
  });

  it('keeps entries across a fresh instance over the same repository', async () => {
    const repositories = createInMemoryRepositories();
    const first = catalogFor(repositories);
    first.recordSeen('spotify', TRACKS);
    await first.whenIdle();

    const second = catalogFor(repositories);

    expect(await second.search('spotify', 'halo', 10)).toMatchObject([
      { trackUri: 'spotify:track:2', trackName: 'Halo', timesSeen: 1 },
    ]);
  });

  it('keeps the in-memory index current with later writes', async () => {
    const repositories = createInMemoryRepositories();
    const catalog = catalogFor(repositories);
    expect(await catalog.search('spotify', 'halo', 10)).toEqual([]);

    catalog.recordSeen('spotify', TRACKS);
    await catalog.whenIdle();

    expect(await catalog.search('spotify', 'halo', 10)).toHaveLength(1);
    expect(await catalog.search('other-provider', 'halo', 10)).toEqual([]);
  });
});

describe('TrackCatalog — ISRC', () => {
  it('keeps the ISRC of a track and finds rows by (provider, ISRC)', async () => {
    const repositories = createInMemoryRepositories();
    const catalog = catalogFor(repositories);

    catalog.recordSeen('spotify', [{ ...TRACKS[0]!, isrc: 'USSM10304476' }, { ...TRACKS[1]! }]);
    // A later write without an ISRC never erases a known one.
    catalog.recordSeen('spotify', [{ ...TRACKS[0]! }]);
    await catalog.whenIdle();

    const rows = await repositories.trackCatalog.findAll();
    expect(rows.find((r) => r.trackUri === 'spotify:track:1')?.isrc).toBe('USSM10304476');
    expect(rows.find((r) => r.trackUri === 'spotify:track:2')?.isrc).toBeUndefined();
    expect(await catalog.search('spotify', 'crazy', 5)).toMatchObject([
      { trackUri: 'spotify:track:1', isrc: 'USSM10304476' },
    ]);
    expect(await catalog.findByIsrc('spotify', 'USSM10304476')).toMatchObject([
      { trackUri: 'spotify:track:1' },
    ]);
    expect(await catalog.findByIsrc('soundtrack', 'USSM10304476')).toEqual([]);
  });

  it('stores a requested track under its ISRC', async () => {
    const repositories = createInMemoryRepositories();
    await connectSpotify(repositories);
    const catalog = catalogFor(repositories);

    catalog.recordRequested(ACCOUNT, { ...TRACKS[1]!, isrc: 'USSM10900001' });
    await catalog.whenIdle();

    expect(await catalog.findByIsrc('spotify', 'USSM10900001')).toMatchObject([
      { trackUri: 'spotify:track:2', timesRequested: 1, isrc: 'USSM10900001' },
    ]);
  });
});
