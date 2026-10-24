import { describe, expect, it } from 'vitest';
import {
  mergeCatalogUpserts,
  normalizeSearchText,
  rankCatalogMatches,
} from '../../src/catalog/catalogSearch.js';
import type { TrackCatalogRecord } from '../../src/repositories/types.js';

function record(overrides: Partial<TrackCatalogRecord> & { trackUri: string }): TrackCatalogRecord {
  return {
    providerId: 'spotify',
    trackName: 'Untitled',
    artistName: 'Nobody',
    albumArtUrl: null,
    durationMs: null,
    timesSeen: 0,
    timesRequested: 0,
    lastSeenAt: new Date('2026-10-01T00:00:00Z'),
    ...overrides,
  };
}

function uris(records: ReadonlyArray<TrackCatalogRecord>): string[] {
  return records.map((r) => r.trackUri);
}

describe('normalizeSearchText', () => {
  it('lowercases, strips accents and punctuation, and collapses spaces', () => {
    expect(normalizeSearchText('  Beyoncé — Crazy   in Love!! ')).toBe('beyonce crazy in love');
    expect(normalizeSearchText("Don't Stop Me Now")).toBe('dont stop me now');
    expect(normalizeSearchText('Sigur Rós / Hoppípolla')).toBe('sigur ros hoppipolla');
    expect(normalizeSearchText('!!!')).toBe('');
  });
});

describe('rankCatalogMatches', () => {
  const crazy = record({
    trackUri: 'spotify:track:crazy',
    trackName: 'Crazy in Love',
    artistName: 'Beyoncé',
  });
  const halo = record({ trackUri: 'spotify:track:halo', trackName: 'Halo', artistName: 'Beyonce' });
  const dont = record({
    trackUri: 'spotify:track:dont',
    trackName: "Don't Stop Me Now",
    artistName: 'Queen',
  });

  it('matches accent-insensitively and ignores punctuation in the query', () => {
    expect(uris(rankCatalogMatches([crazy, halo, dont], 'BEYONCÉ', 10)).sort()).toEqual(
      [crazy.trackUri, halo.trackUri].sort(),
    );
    expect(uris(rankCatalogMatches([crazy, halo, dont], 'beyonce', 10)).sort()).toEqual(
      [crazy.trackUri, halo.trackUri].sort(),
    );
    expect(uris(rankCatalogMatches([crazy, halo, dont], 'dont stop', 10))).toEqual([dont.trackUri]);
    expect(uris(rankCatalogMatches([crazy, halo, dont], "don't, stop!", 10))).toEqual([
      dont.trackUri,
    ]);
  });

  it('prefix-matches every query token against the name and artist tokens', () => {
    expect(uris(rankCatalogMatches([crazy, halo, dont], 'cra lov bey', 10))).toEqual([
      crazy.trackUri,
    ]);
    expect(uris(rankCatalogMatches([crazy, halo, dont], 'que sto', 10))).toEqual([dont.trackUri]);
    // Every token must match; a token in the middle of a word is not a prefix.
    expect(rankCatalogMatches([crazy, halo, dont], 'crazy zzz', 10)).toEqual([]);
    expect(rankCatalogMatches([crazy, halo, dont], 'razy', 10)).toEqual([]);
    expect(rankCatalogMatches([crazy, halo, dont], '???', 10)).toEqual([]);
  });

  it('ranks exact phrase, then times requested, then times seen, then recency', () => {
    const phrase = record({
      trackUri: 'u:phrase',
      trackName: 'Love Song',
      artistName: 'Adele',
    });
    const requested = record({
      trackUri: 'u:requested',
      trackName: 'Song of Love',
      artistName: 'X',
      timesRequested: 5,
    });
    const seen = record({
      trackUri: 'u:seen',
      trackName: 'Songs about Love',
      artistName: 'Y',
      timesRequested: 1,
      timesSeen: 9,
    });
    const recent = record({
      trackUri: 'u:recent',
      trackName: 'Lovesong',
      artistName: 'Z songs',
      timesRequested: 1,
      timesSeen: 2,
      lastSeenAt: new Date('2026-10-20T00:00:00Z'),
    });
    const old = record({
      trackUri: 'u:old',
      trackName: 'Lovers songbook',
      artistName: 'W',
      timesRequested: 1,
      timesSeen: 2,
      lastSeenAt: new Date('2026-09-01T00:00:00Z'),
    });

    const ranked = rankCatalogMatches([old, recent, seen, requested, phrase], 'love song', 10);

    expect(uris(ranked)).toEqual(['u:phrase', 'u:requested', 'u:seen', 'u:recent', 'u:old']);
  });

  it('returns at most `limit` results', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      record({ trackUri: `u:${i}`, trackName: `Song ${i}`, timesSeen: i }),
    );
    const ranked = rankCatalogMatches(many, 'song', 5);
    expect(uris(ranked)).toEqual(['u:29', 'u:28', 'u:27', 'u:26', 'u:25']);
  });
});

describe('mergeCatalogUpserts', () => {
  it('folds duplicate (provider, uri) entries in one batch into one', () => {
    const merged = mergeCatalogUpserts([
      {
        providerId: 'spotify',
        trackUri: 'u:1',
        trackName: 'Old name',
        artistName: 'A',
        albumArtUrl: 'https://art/1',
        durationMs: 1,
        seenIncrement: 1,
        requestedIncrement: 0,
        seenAt: new Date('2026-10-01T00:00:00Z'),
      },
      {
        providerId: 'spotify',
        trackUri: 'u:1',
        trackName: 'New name',
        artistName: 'A',
        albumArtUrl: null,
        durationMs: 2,
        seenIncrement: 0,
        requestedIncrement: 1,
        seenAt: new Date('2026-10-02T00:00:00Z'),
      },
      {
        providerId: 'other',
        trackUri: 'u:1',
        trackName: 'Other',
        artistName: 'B',
        albumArtUrl: null,
        durationMs: null,
        seenIncrement: 1,
        requestedIncrement: 0,
        seenAt: new Date('2026-10-01T00:00:00Z'),
      },
    ]);

    expect(merged).toHaveLength(2);
    expect(merged[0]).toEqual({
      providerId: 'spotify',
      trackUri: 'u:1',
      trackName: 'New name',
      artistName: 'A',
      albumArtUrl: 'https://art/1',
      durationMs: 2,
      seenIncrement: 1,
      requestedIncrement: 1,
      seenAt: new Date('2026-10-02T00:00:00Z'),
    });
  });
});
