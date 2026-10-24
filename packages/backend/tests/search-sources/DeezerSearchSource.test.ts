/**
 * DeezerSearchSource — public Deezer search mapped to provider-agnostic
 * `opendj:isrc:` tracks. fetch is always mocked; no network.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DeezerSearchSource,
  type DeezerSearchSourceOptions,
} from '../../src/search-sources/DeezerSearchSource.js';
import { isrcFromTrackUri, isrcTrackUri } from '../../src/search-sources/isrc.js';

const CTX = { accountId: 'acc-1', providerId: 'spotify' };

const DEEZER_BODY = {
  data: [
    {
      id: 3135553,
      title: 'One More Time',
      isrc: 'GBDUW0000053',
      duration: 320,
      artist: { name: 'Daft Punk' },
      album: { cover_medium: 'https://cdn.deezer/cover-250.jpg' },
    },
    {
      id: 42,
      title: 'No ISRC Here',
      duration: 100,
      artist: { name: 'Nobody' },
      album: { cover_medium: null },
    },
    {
      id: 43,
      title: 'Lowercase isrc',
      isrc: 'usrc17607839',
      duration: 200,
      artist: { name: 'Someone' },
      album: {},
    },
  ],
  total: 3,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sourceWith(
  fetchImpl: typeof fetch,
  opts: {
    rateLimit?: number;
    now?: () => number;
    timeoutMs?: number;
    requestedCounts?: DeezerSearchSourceOptions['requestedCounts'];
  } = {},
) {
  return new DeezerSearchSource({ fetchImpl, ...opts });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('isrc helpers', () => {
  it('round-trips an opendj ISRC uri and normalises case and hyphens', () => {
    expect(isrcTrackUri('gb-duw-00-00053')).toBe('opendj:isrc:GBDUW0000053');
    expect(isrcFromTrackUri('opendj:isrc:GBDUW0000053')).toBe('GBDUW0000053');
    expect(isrcFromTrackUri('spotify:track:abc')).toBeNull();
    expect(isrcFromTrackUri('opendj:isrc:not-an-isrc')).toBeNull();
  });
});

describe('DeezerSearchSource', () => {
  it('queries the public search API and maps results to opendj:isrc tracks', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(DEEZER_BODY));
    const source = sourceWith(fetchImpl);

    const results = await source.search('one more time', 5, CTX);

    expect(source.id).toBe('deezer');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchImpl.mock.calls[0]![0]));
    expect(url.origin + url.pathname).toBe('https://api.deezer.com/search');
    expect(url.searchParams.get('q')).toBe('one more time');
    expect(url.searchParams.get('limit')).toBe('25');
    expect(url.searchParams.get('order')).toBe('RANKING');
    expect([...url.searchParams.keys()]).toEqual(['q', 'limit', 'order']);
    expect(results).toEqual([
      {
        trackUri: 'opendj:isrc:GBDUW0000053',
        trackName: 'One More Time',
        artistName: 'Daft Punk',
        albumArtUrl: 'https://cdn.deezer/cover-250.jpg',
        durationMs: 320_000,
        isrc: 'GBDUW0000053',
      },
      {
        trackUri: 'opendj:isrc:USRC17607839',
        trackName: 'Lowercase isrc',
        artistName: 'Someone',
        albumArtUrl: null,
        durationMs: 200_000,
        isrc: 'USRC17607839',
      },
    ]);
  });

  it.each([
    ['an HTTP error', async () => jsonResponse({}, 500)],
    ['an error body', async () => jsonResponse({ error: { type: 'Exception', code: 4 } })],
    ['a body without data', async () => jsonResponse({ nope: true })],
    [
      'a network failure',
      async (): Promise<Response> => {
        throw new TypeError('fetch failed');
      },
    ],
  ])('answers unavailable on %s', async (_label, impl) => {
    const source = sourceWith(vi.fn<typeof fetch>(impl));
    expect(await source.search('x', 5, CTX)).toBe('unavailable');
  });

  it('answers unavailable once its own limiter is spent, without calling Deezer', async () => {
    let now = 1_000_000;
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(DEEZER_BODY));
    const source = sourceWith(fetchImpl, { rateLimit: 2, now: () => now });

    expect(await source.search('a', 5, CTX)).not.toBe('unavailable');
    expect(await source.search('b', 5, CTX)).not.toBe('unavailable');
    expect(await source.search('c', 5, CTX)).toBe('unavailable');
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    now += 5_001;
    expect(await source.search('d', 5, CTX)).not.toBe('unavailable');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('times out a slow Deezer call as unavailable', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const source = sourceWith(fetchImpl, { timeoutMs: 3_000 });

    const pending = source.search('slow', 5, CTX);
    await vi.advanceTimersByTimeAsync(3_000);

    expect(await pending).toBe('unavailable');
  });
});

/** A Deezer search item shaped like the live API's. */
let nextId = 1;
function deezerItem(title: string, artist: string, rank: number, isrc: string) {
  nextId += 1;
  return {
    id: nextId,
    title,
    title_short: title,
    isrc,
    duration: 222,
    rank,
    artist: { id: nextId * 10, name: artist },
    album: { id: nextId * 100, cover_medium: `https://cdn.deezer/${nextId}.jpg` },
  };
}

function rankedSource(
  items: ReturnType<typeof deezerItem>[],
  requestedCounts?: DeezerSearchSourceOptions['requestedCounts'],
  extra: Pick<DeezerSearchSourceOptions, 'confidentRank'> = {},
) {
  const fetchImpl = vi.fn<typeof fetch>(async () =>
    jsonResponse({ data: items, total: items.length }),
  );
  return {
    fetchImpl,
    source: new DeezerSearchSource({
      fetchImpl,
      ...(requestedCounts && { requestedCounts }),
      ...extra,
    }),
  };
}

const titles = (results: Awaited<ReturnType<DeezerSearchSource['search']>>) => {
  if (results === 'unavailable') throw new Error('unexpected unavailable');
  return results.map((r) => `${r.trackName} / ${r.artistName}`);
};

// Raw Deezer order for "mr brightside": cluttered with a remix, covers, and live takes.
const BRIGHTSIDE = [
  deezerItem('Mr. Brightside (Jacques Lu Cont Remix)', 'The Killers', 610_000, 'USUM70500001'),
  deezerItem('Mr. Brightside', 'Part Time Killer', 180_000, 'QZAAA2000001'),
  deezerItem('Mr. Brightside', 'ItaloBrothers', 420_000, 'DEA621500001'),
  deezerItem('Mr. Brightside (Live at Wembley Stadium)', 'The Killers', 450_000, 'USUM70700002'),
  deezerItem('Mr. Brightside', 'The Killers', 905_000, 'USIR20400274'),
  deezerItem('Mr. Brightside (Orchestra Ver.)', 'Vitamin Strings', 300_000, 'USA2P0900001'),
  deezerItem('Mr. Brightside - Karaoke Version', 'Karaoke Hits', 150_000, 'GBKRK0500001'),
  deezerItem('Mr. Brightside', 'The Killers', 700_000, 'USIR20400999'),
];

const CHA_CHA = [
  deezerItem('Cha Cha Slide', 'Party DJs', 210_000, 'QZBBB1900001'),
  deezerItem('Cha Cha Slide (Sped Up)', 'DJ Casper', 520_000, 'USA560400001'),
  deezerItem('Cha Cha Slide (TV Size)', 'Anime Party', 120_000, 'JPA000400001'),
  deezerItem('Cha-Cha Slide', 'DJ Casper', 880_000, 'USA560400002'),
  deezerItem('Cha Cha Slide (From "Shrek" Soundtrack)', 'Movie Hits', 330_000, 'USB560400003'),
];

describe('DeezerSearchSource ranking', () => {
  it('asks Deezer for 25 hits and returns at most the requested limit', async () => {
    const { source, fetchImpl } = rankedSource(BRIGHTSIDE);

    const results = await source.search('mr brightside', 3, CTX);

    const url = new URL(String(fetchImpl.mock.calls[0]![0]));
    expect(url.searchParams.get('limit')).toBe('25');
    expect(url.searchParams.get('order')).toBe('RANKING');
    expect(titles(results)).toHaveLength(3);
  });

  it('puts the original above remixes, live takes, orchestra and karaoke variants', async () => {
    const { source } = rankedSource(BRIGHTSIDE);

    const ordered = titles(await source.search('mr brightside', 20, CTX));

    expect(ordered[0]).toBe('Mr. Brightside / The Killers');
    // Every unmarked recording ranks above every marked variant.
    const lastPlain = Math.max(
      ordered.indexOf('Mr. Brightside / ItaloBrothers'),
      ordered.indexOf('Mr. Brightside / Part Time Killer'),
    );
    for (const variant of [
      'Mr. Brightside (Jacques Lu Cont Remix) / The Killers',
      'Mr. Brightside (Live at Wembley Stadium) / The Killers',
      'Mr. Brightside (Orchestra Ver.) / Vitamin Strings',
      'Mr. Brightside - Karaoke Version / Karaoke Hits',
    ]) {
      expect(ordered.indexOf(variant)).toBeGreaterThan(lastPlain);
    }
  });

  it('collapses duplicate releases of one recording, keeping the higher Deezer rank', async () => {
    const { source } = rankedSource(BRIGHTSIDE);

    const results = await source.search('mr brightside', 20, CTX);

    if (results === 'unavailable') throw new Error('unexpected unavailable');
    const killers = results.filter(
      (r) => r.trackName === 'Mr. Brightside' && r.artistName === 'The Killers',
    );
    expect(killers.map((r) => r.isrc)).toEqual(['USIR20400274']);
  });

  it('keeps a remix high when the query asks for one', async () => {
    const { source } = rankedSource(BRIGHTSIDE);

    const ordered = titles(await source.search('mr brightside remix', 20, CTX));

    expect(ordered[0]).toBe('Mr. Brightside (Jacques Lu Cont Remix) / The Killers');
  });

  it('demotes sped-up and TV-size takes but not a "From ..." soundtrack credit', async () => {
    const { source } = rankedSource(CHA_CHA);

    const ordered = titles(await source.search('cha cha slide', 20, CTX));

    expect(ordered[0]).toBe('Cha-Cha Slide / DJ Casper');
    const soundtrack = ordered.indexOf('Cha Cha Slide (From "Shrek" Soundtrack) / Movie Hits');
    expect(soundtrack).toBeLessThan(ordered.indexOf('Cha Cha Slide (Sped Up) / DJ Casper'));
    expect(soundtrack).toBeLessThan(ordered.indexOf('Cha Cha Slide (TV Size) / Anime Party'));
  });

  it("does not treat Taylor's Version as a variant", async () => {
    const { source } = rankedSource([
      deezerItem('Love Story (Live)', 'Taylor Swift', 600_000, 'USCJY0803275'),
      deezerItem("Love Story (Taylor's Version)", 'Taylor Swift', 590_000, 'USUG12100342'),
    ]);

    const ordered = titles(await source.search('love story', 20, CTX));

    expect(ordered[0]).toBe("Love Story (Taylor's Version) / Taylor Swift");
  });

  it('lifts tracks the local catalog says guests requested', async () => {
    const requestedCounts = vi.fn(async (_providerId: string, _isrcs: readonly string[]) => {
      return new Map([['DEA621500001', 3]]);
    });
    const { source } = rankedSource(
      [
        deezerItem('Mr. Brightside', 'Part Time Killer', 500_000, 'QZAAA2000001'),
        deezerItem('Mr. Brightside', 'ItaloBrothers', 420_000, 'DEA621500001'),
      ],
      requestedCounts,
    );

    const ordered = titles(await source.search('mr brightside', 20, CTX));

    expect(requestedCounts).toHaveBeenCalledWith(
      'spotify',
      expect.arrayContaining(['DEA621500001']),
    );
    expect(ordered[0]).toBe('Mr. Brightside / ItaloBrothers');
  });

  it('ranks without the requested bonus when the catalog lookup fails', async () => {
    const { source } = rankedSource(
      [
        deezerItem('Mr. Brightside', 'Part Time Killer', 500_000, 'QZAAA2000001'),
        deezerItem('Mr. Brightside', 'ItaloBrothers', 420_000, 'DEA621500001'),
      ],
      async () => {
        throw new Error('catalog down');
      },
    );

    const ordered = titles(await source.search('mr brightside', 20, CTX));

    expect(ordered[0]).toBe('Mr. Brightside / Part Time Killer');
  });

  it('puts hits that match every query word above ones that do not', async () => {
    const { source } = rankedSource([
      deezerItem('Brightside', 'Someone Else', 900_000, 'QZAAA2000021'),
      deezerItem('Mr. Brightside', 'The Killers', 800_000, 'USIR20400274'),
    ]);

    const ordered = titles(await source.search('killers brightside', 20, CTX));

    expect(ordered[0]).toBe('Mr. Brightside / The Killers');
  });

  it("keeps Deezer's order between equally scored hits", async () => {
    const { source } = rankedSource([
      deezerItem('Song A', 'Band', 100, 'QZAAA2000011'),
      deezerItem('Song B', 'Band', 100, 'QZAAA2000012'),
      deezerItem('Song C', 'Band', 100, 'QZAAA2000013'),
    ]);

    expect(titles(await source.search('song', 20, CTX))).toEqual([
      'Song A / Band',
      'Song B / Band',
      'Song C / Band',
    ]);
  });
});

// Live "mr brightside": Deezer has no original, only a remix, covers, and karaoke.
const BRIGHTSIDE_COVERS_ONLY = [
  deezerItem('Mr. Brightside (Jacques Lu Cont Remix)', 'The Killers', 610_000, 'USUM70500001'),
  deezerItem('Mr. Brightside', 'Part Time Killer', 354_521, 'QZAAA2000001'),
  deezerItem('Mr. Brightside', 'ItaloBrothers', 300_000, 'DEA621500001'),
  deezerItem('Mr. Brightside (Live)', 'The Killers', 480_000, 'USUM70700002'),
  deezerItem('Mr. Brightside - Karaoke Version', 'Karaoke Hits', 150_000, 'GBKRK0500001'),
];

const BASKET_CASE = [
  deezerItem('Basket Case', 'Green Day', 883_330, 'USRE19900154'),
  deezerItem('Basket Case (Karaoke Version)', 'Karaoke Hits', 120_000, 'GBKRK0500002'),
];

describe('DeezerSearchSource confidence', () => {
  const confidence = async (
    items: ReturnType<typeof deezerItem>[],
    query: string,
    confidentRank?: number,
  ) => {
    const { source } = rankedSource(
      items,
      undefined,
      confidentRank !== undefined ? { confidentRank } : {},
    );
    const answer = await source.searchWithConfidence(query, 20, CTX);
    if (answer === 'unavailable') throw new Error('unexpected unavailable');
    return answer;
  };

  it('is not confident when only covers and remixes come back (live mr brightside)', async () => {
    const answer = await confidence(BRIGHTSIDE_COVERS_ONLY, 'mr brightside');
    expect(answer.confident).toBe(false);
    expect(answer.tracks.length).toBeGreaterThan(0);
  });

  it('is confident for a popular non-variant hit that matches every query word', async () => {
    expect((await confidence(BASKET_CASE, 'basket case')).confident).toBe(true);
    expect(
      (
        await confidence(
          [deezerItem('September', 'Earth, Wind & Fire', 934_544, 'USSM17800845')],
          'september',
        )
      ).confident,
    ).toBe(true);
  });

  it('is always confident for queries shorter than 3 non-space characters', async () => {
    expect((await confidence(BRIGHTSIDE_COVERS_ONLY, 'mr')).confident).toBe(true);
    expect((await confidence(BRIGHTSIDE_COVERS_ONLY, ' m r ')).confident).toBe(true);
  });

  it('is not confident when every popular hit is a variant', async () => {
    const variantsOnly = [
      deezerItem('Mr. Brightside (Remix)', 'The Killers', 900_000, 'USUM70500011'),
      deezerItem('Mr. Brightside (Live)', 'The Killers', 800_000, 'USUM70500012'),
    ];
    expect((await confidence(variantsOnly, 'mr brightside')).confident).toBe(false);
    // ...unless the query asks for that variant.
    expect((await confidence(variantsOnly, 'mr brightside remix')).confident).toBe(true);
  });

  it('is not confident when the matching original ranks below the threshold', async () => {
    const lowRank = [deezerItem('Mr. Brightside', 'The Killers', 400_000, 'USIR20400274')];
    expect((await confidence(lowRank, 'mr brightside')).confident).toBe(false);
    expect((await confidence(lowRank, 'mr brightside', 300_000)).confident).toBe(true);
  });

  it('is not confident when the popular hit misses a query word', async () => {
    const other = [deezerItem('Brightside', 'Someone Else', 900_000, 'QZAAA2000021')];
    expect((await confidence(other, 'mr brightside')).confident).toBe(false);
  });

  it('answers the same tracks as search()', async () => {
    const { source } = rankedSource(BRIGHTSIDE);
    const answer = await source.searchWithConfidence('mr brightside', 3, CTX);
    if (answer === 'unavailable') throw new Error('unexpected unavailable');
    expect(answer.tracks).toEqual(await source.search('mr brightside', 3, CTX));
    expect(answer.confident).toBe(true);
  });
});
