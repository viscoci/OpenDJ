import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pg-proxy';
import { schema, type Database } from '@opendj/db';
import { DrizzleTrackCatalogRepository } from '../../src/repositories/drizzle/track-catalog.js';
import { InMemoryTrackCatalogRepository } from '../../src/repositories/in-memory/index.js';
import type { TrackCatalogRecord, TrackCatalogUpsert } from '../../src/repositories/types.js';

/**
 * In-memory vs Drizzle parity for `track_catalog`. No Postgres in unit tests:
 * a pg-proxy driver captures the SQL drizzle emits and answers with canned
 * rows (the in-memory repo's rows), so both repos must rank the same rows
 * the same way and emit an incrementing upsert.
 */
interface Captured {
  sql: string;
  params: unknown[];
}

function proxyDb(answer: (q: Captured) => unknown[][]) {
  const queries: Captured[] = [];
  const db = drizzle(
    async (sql, params) => {
      const q = { sql, params };
      queries.push(q);
      return { rows: answer(q) };
    },
    { schema },
  );
  return { db: db as unknown as Database, queries };
}

const columnNames = Object.keys(getTableColumns(schema.trackCatalog));

function rowArray(record: TrackCatalogRecord): unknown[] {
  const base: Record<string, unknown> = {
    id: `id-${record.trackUri}`,
    ...record,
    lastSeenAt: record.lastSeenAt.toISOString(),
  };
  return columnNames.map((name) => base[name]);
}

function upsert(overrides: Partial<TrackCatalogUpsert> & { trackUri: string }): TrackCatalogUpsert {
  return {
    providerId: 'spotify',
    trackName: 'Untitled',
    artistName: 'Nobody',
    albumArtUrl: null,
    durationMs: null,
    seenIncrement: 1,
    requestedIncrement: 0,
    seenAt: new Date('2026-10-20T00:00:00Z'),
    ...overrides,
  };
}

const ENTRIES: TrackCatalogUpsert[] = [
  upsert({ trackUri: 'u:crazy', trackName: 'Crazy in Love', artistName: 'Beyoncé' }),
  upsert({
    trackUri: 'u:halo',
    trackName: 'Halo',
    artistName: 'Beyonce',
    requestedIncrement: 3,
  }),
  upsert({ trackUri: 'u:dont', trackName: "Don't Stop Me Now", artistName: 'Queen' }),
  upsert({ trackUri: 'u:other', providerId: 'soundtrack', trackName: 'Halo', artistName: 'X' }),
];

describe('InMemoryTrackCatalogRepository', () => {
  it('increments counters on repeat upserts and keeps the latest metadata', async () => {
    const repo = new InMemoryTrackCatalogRepository();
    await repo.upsertMany([
      upsert({ trackUri: 'u:1', albumArtUrl: 'https://art/1', seenAt: new Date(1_000) }),
    ]);
    await repo.upsertMany([
      upsert({
        trackUri: 'u:1',
        trackName: 'Renamed',
        albumArtUrl: null,
        seenIncrement: 0,
        requestedIncrement: 1,
        seenAt: new Date(2_000),
      }),
      upsert({ trackUri: 'u:1', seenIncrement: 1, seenAt: new Date(500) }),
    ]);

    expect(await repo.findAll()).toEqual([
      {
        providerId: 'spotify',
        trackUri: 'u:1',
        trackName: 'Untitled',
        artistName: 'Nobody',
        albumArtUrl: 'https://art/1',
        durationMs: null,
        timesSeen: 2,
        timesRequested: 1,
        lastSeenAt: new Date(2_000),
      },
    ]);
  });
});

describe('InMemoryTrackCatalogRepository — ISRC', () => {
  it('keeps a known ISRC and finds rows by (provider, ISRC)', async () => {
    const repo = new InMemoryTrackCatalogRepository();
    await repo.upsertMany([upsert({ trackUri: 'u:1', isrc: 'USSM10304476' })]);
    await repo.upsertMany([upsert({ trackUri: 'u:1' })]);

    expect((await repo.findAll())[0]?.isrc).toBe('USSM10304476');
    expect(await repo.findByIsrc({ providerId: 'spotify', isrc: 'USSM10304476' })).toMatchObject([
      { trackUri: 'u:1' },
    ]);
    expect(await repo.findByIsrc({ providerId: 'soundtrack', isrc: 'USSM10304476' })).toEqual([]);
  });
});

describe('DrizzleTrackCatalogRepository', () => {
  it('upserts one deduplicated batch that increments the counters', async () => {
    const { db, queries } = proxyDb(() => []);
    const repo = new DrizzleTrackCatalogRepository(db);

    await repo.upsertMany([
      upsert({ trackUri: 'u:1' }),
      upsert({ trackUri: 'u:1', requestedIncrement: 1, seenIncrement: 0 }),
      upsert({ trackUri: 'u:2' }),
    ]);

    expect(queries).toHaveLength(1);
    const { sql, params } = queries[0]!;
    expect(sql).toMatch(/^insert into "track_catalog"/i);
    expect(sql).toMatch(/on conflict \("provider_id", ?"track_uri"\) do update set/i);
    expect(sql).toMatch(/"times_seen" = "track_catalog"\."times_seen" \+ excluded\."times_seen"/i);
    expect(sql).toMatch(
      /"times_requested" = "track_catalog"\."times_requested" \+ excluded\."times_requested"/i,
    );
    expect(sql).toMatch(/greatest\("track_catalog"\."last_seen_at", excluded\."last_seen_at"\)/i);
    expect(sql).toMatch(/coalesce\(excluded\."album_art_url", "track_catalog"\."album_art_url"\)/i);
    // Two rows, not three: duplicates in one batch are folded first.
    expect(params.filter((p) => p === 'u:1')).toHaveLength(1);
    expect(params.filter((p) => p === 'u:2')).toHaveLength(1);
  });

  it('writes the ISRC and never erases a known one', async () => {
    const { db, queries } = proxyDb(() => []);
    await new DrizzleTrackCatalogRepository(db).upsertMany([
      upsert({ trackUri: 'u:1', isrc: 'USSM10304476' }),
    ]);

    const { sql, params } = queries[0]!;
    expect(sql).toMatch(/"isrc"/);
    expect(sql).toMatch(/coalesce\(excluded\."isrc", "track_catalog"\."isrc"\)/i);
    expect(params).toContain('USSM10304476');
  });

  it('finds rows by provider and ISRC', async () => {
    const { db, queries } = proxyDb(() => []);
    expect(
      await new DrizzleTrackCatalogRepository(db).findByIsrc({
        providerId: 'spotify',
        isrc: 'USSM10304476',
      }),
    ).toEqual([]);
    expect(queries[0]!.sql).toMatch(/"provider_id" = \$1 and "track_catalog"\."isrc" = \$2/i);
    expect(queries[0]!.params).toEqual(['spotify', 'USSM10304476']);
  });

  it('skips the round trip for an empty batch', async () => {
    const { db, queries } = proxyDb(() => []);
    await new DrizzleTrackCatalogRepository(db).upsertMany([]);
    expect(queries).toHaveLength(0);
  });
});

describe('track catalog repository parity', () => {
  async function seeded(): Promise<{
    memory: InMemoryTrackCatalogRepository;
    drizzleRepo: DrizzleTrackCatalogRepository;
    queries: Captured[];
  }> {
    const memory = new InMemoryTrackCatalogRepository();
    await memory.upsertMany(ENTRIES);
    const rows = await memory.findAll();
    const { db, queries } = proxyDb((q) => {
      const providerFilter = q.params.find((p) => p === 'spotify' || p === 'soundtrack');
      return rows
        .filter((r) => providerFilter === undefined || r.providerId === providerFilter)
        .map(rowArray);
    });
    return { memory, drizzleRepo: new DrizzleTrackCatalogRepository(db), queries };
  }

  it('returns the same rows from findAll', async () => {
    const { memory, drizzleRepo } = await seeded();
    const sortByUri = (rows: TrackCatalogRecord[]) =>
      [...rows].sort((a, b) => a.trackUri.localeCompare(b.trackUri));
    expect(sortByUri(await drizzleRepo.findAll())).toEqual(sortByUri(await memory.findAll()));
  });

  it.each([
    ['beyonce', 10],
    ['BEYONCÉ', 1],
    ['halo', 10],
    ["don't st", 10],
    ['nothing here', 10],
  ])('ranks %j (limit %i) the same way', async (query, limit) => {
    const { memory, drizzleRepo, queries } = await seeded();

    const fromDrizzle = await drizzleRepo.search({ providerId: 'spotify', query, limit });
    const fromMemory = await memory.search({ providerId: 'spotify', query, limit });

    expect(fromDrizzle).toEqual(fromMemory);
    expect(fromMemory.every((r) => r.providerId === 'spotify')).toBe(true);
    expect(queries.at(-1)?.sql).toMatch(/where "track_catalog"\."provider_id" = \$1/i);
  });
});
