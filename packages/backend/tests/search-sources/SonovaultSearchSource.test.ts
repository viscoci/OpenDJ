/**
 * SonovaultSearchSource — Sonovault's artist + title search mapped to
 * provider-agnostic `opendj:isrc:` tracks. fetch is always mocked; no network.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseArtistTitleQuery,
  SONOVAULT_SEARCH_RESERVE,
  SonovaultSearchSource,
} from '../../src/search-sources/SonovaultSearchSource.js';
import {
  createSonovaultLimiter,
  SONOVAULT_SCOPE,
  SonovaultTrackResolver,
} from '../../src/track-resolution/SonovaultTrackResolver.js';

const CTX = { accountId: 'acc-1', providerId: 'spotify' };

const DAFT_PUNK = {
  id: 'sv-1',
  title: 'One More Time',
  artists: [{ name: 'Daft Punk' }],
  isrc: 'GBDUW0000053',
  duration: 320,
  releases: [{ title: 'Discovery' }],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sourceWith(
  fetchImpl: typeof fetch,
  opts: Partial<ConstructorParameters<typeof SonovaultSearchSource>[0]> = {},
) {
  return new SonovaultSearchSource({
    apiKey: 'sv-key',
    fetchImpl,
    logger: { warn: () => {} },
    ...opts,
  });
}

function calledParams(fetchImpl: ReturnType<typeof vi.fn>, call = 0): URLSearchParams {
  const url = new URL(String(fetchImpl.mock.calls[call]![0]));
  return url.searchParams;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('parseArtistTitleQuery', () => {
  it.each([
    ['Daft Punk - One More Time', 'Daft Punk', 'One More Time'],
    ['Daft Punk – One More Time', 'Daft Punk', 'One More Time'],
    ['Daft Punk — One More Time', 'Daft Punk', 'One More Time'],
    ['  Daft Punk  -  One More Time  ', 'Daft Punk', 'One More Time'],
  ])('splits %j on a dash, artist first then swapped', (query, artist, title) => {
    expect(parseArtistTitleQuery(query)).toEqual([
      { artist, title },
      { artist: title, title: artist },
    ]);
  });

  it('splits on the first dash so a title can keep its own dash', () => {
    expect(parseArtistTitleQuery('Queen - Bohemian Rhapsody - Remastered')?.[0]).toEqual({
      artist: 'Queen',
      title: 'Bohemian Rhapsody - Remastered',
    });
  });

  it("splits on the last ' by ', title first, case-insensitively, with no swap", () => {
    expect(parseArtistTitleQuery('Stand By Me BY Ben E. King')).toEqual([
      { artist: 'Ben E. King', title: 'Stand By Me' },
    ]);
    expect(parseArtistTitleQuery('one more time by daft punk')).toEqual([
      { artist: 'daft punk', title: 'one more time' },
    ]);
  });

  it.each([
    ['one more time'],
    ['Daft Punk-One More Time'],
    ['Jay-Z'],
    ['standby me'],
    [' - One More Time'],
    ['Daft Punk - '],
    ['by Daft Punk'],
    ['One More Time by '],
  ])('finds no artist and title in %j', (query) => {
    expect(parseArtistTitleQuery(query)).toBeNull();
  });
});

describe('SonovaultSearchSource', () => {
  it('has the sonovault id', () => {
    expect(sourceWith(vi.fn<typeof fetch>()).id).toBe('sonovault');
  });

  it('skips a query without a separator without any request', async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    expect(await sourceWith(fetchImpl).search('one more time', 10, CTX)).toBe('unavailable');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('asks with artist, title, limit, and the api key, and maps tracks to opendj:isrc uris', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse([DAFT_PUNK]));

    const result = await sourceWith(fetchImpl).search('Daft Punk - One More Time', 7, CTX);

    expect(result).toEqual([
      {
        trackUri: 'opendj:isrc:GBDUW0000053',
        trackName: 'One More Time',
        artistName: 'Daft Punk',
        albumArtUrl: null,
        durationMs: 320_000,
        isrc: 'GBDUW0000053',
      },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchImpl.mock.calls[0]![0]));
    expect(`${url.origin}${url.pathname}`).toBe('https://api.sonovault.now/v1/tracks/search');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      artist: 'Daft Punk',
      title: 'One More Time',
      limit: '7',
    });
    const headers = new Headers(fetchImpl.mock.calls[0]![1]?.headers);
    expect(headers.get('x-api-key')).toBe('sv-key');
  });

  it('retries a dash query swapped when the first order finds nothing', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse([DAFT_PUNK]));

    const result = await sourceWith(fetchImpl).search('One More Time - Daft Punk', 10, CTX);

    expect(result).toMatchObject([{ trackUri: 'opendj:isrc:GBDUW0000053' }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(calledParams(fetchImpl, 0).get('artist')).toBe('One More Time');
    expect(calledParams(fetchImpl, 1).get('artist')).toBe('Daft Punk');
    expect(calledParams(fetchImpl, 1).get('title')).toBe('One More Time');
  });

  it('answers an empty list after both dash orders find nothing (two requests at most)', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ data: [] }));

    expect(await sourceWith(fetchImpl).search('a - b', 10, CTX)).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("asks a ' by ' query once, title on the left", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse([]));

    expect(await sourceWith(fetchImpl).search('One More Time by Daft Punk', 10, CTX)).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(calledParams(fetchImpl).get('title')).toBe('One More Time');
    expect(calledParams(fetchImpl).get('artist')).toBe('Daft Punk');
  });

  it.each([
    ['a top-level array', [DAFT_PUNK]],
    ['{ data }', { data: [DAFT_PUNK] }],
    ['{ results }', { results: [DAFT_PUNK] }],
    ['{ tracks }', { tracks: [DAFT_PUNK] }],
  ])('reads %s', async (_label, body) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(body));

    const result = await sourceWith(fetchImpl).search('Daft Punk - One More Time', 10, CTX);

    expect(result).toMatchObject([{ trackUri: 'opendj:isrc:GBDUW0000053' }]);
  });

  it('joins artist names, accepts string artists, and reads seconds or ms durations', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse([
        {
          title: 'Get Lucky',
          artists: [{ name: 'Daft Punk' }, { name: 'Pharrell Williams' }, { id: 'no-name' }],
          isrc: 'usqx91300108',
          duration: 248_000,
        },
        { title: 'Song', artists: ['A', 'B'], isrc: 'GB-AAA-00-00001', duration: 'long' },
        { title: 'Short', artists: [{ name: 'C' }], isrc: 'GBAAA0000002', duration: 9_999 },
      ]),
    );

    const result = await sourceWith(fetchImpl).search('x - y', 10, CTX);

    expect(result).toEqual([
      {
        trackUri: 'opendj:isrc:USQX91300108',
        trackName: 'Get Lucky',
        artistName: 'Daft Punk, Pharrell Williams',
        albumArtUrl: null,
        durationMs: 248_000,
        isrc: 'USQX91300108',
      },
      {
        trackUri: 'opendj:isrc:GBAAA0000001',
        trackName: 'Song',
        artistName: 'A, B',
        albumArtUrl: null,
        durationMs: null,
        isrc: 'GBAAA0000001',
      },
      {
        trackUri: 'opendj:isrc:GBAAA0000002',
        trackName: 'Short',
        artistName: 'C',
        albumArtUrl: null,
        durationMs: 9_999_000,
        isrc: 'GBAAA0000002',
      },
    ]);
  });

  it('skips items without a valid ISRC, title, or artist, and junk entries', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse([
        { title: 'No ISRC', artists: [{ name: 'A' }], duration: 100 },
        { title: 'Bad ISRC', artists: [{ name: 'A' }], isrc: 'nope' },
        { artists: [{ name: 'A' }], isrc: 'GBAAA0000003' },
        { title: 'No artists', isrc: 'GBAAA0000004' },
        null,
        'junk',
        DAFT_PUNK,
      ]),
    );

    const result = await sourceWith(fetchImpl).search('Daft Punk - One More Time', 10, CTX);

    expect(result).toMatchObject([{ isrc: 'GBDUW0000053' }]);
  });

  it('retries swapped when the first order found only isrc-less items', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse([{ title: 'No ISRC', artists: [{ name: 'A' }] }]),
    );

    expect(await sourceWith(fetchImpl).search('a - b', 10, CTX)).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['an HTTP error', () => jsonResponse({ error: 'boom' }, 500)],
    ['a 429', () => jsonResponse({ error: 'slow down' }, 429)],
    ['an unknown body shape', () => jsonResponse({ items: 'nope' })],
    ['a non-JSON body', () => new Response('<html>', { status: 200 })],
  ])('answers unavailable on %s', async (_label, respond) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => respond());

    expect(await sourceWith(fetchImpl).search('a - b', 10, CTX)).toBe('unavailable');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('answers unavailable on a network failure', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError('fetch failed');
    });

    expect(await sourceWith(fetchImpl).search('a - b', 10, CTX)).toBe('unavailable');
  });

  it('answers unavailable when the swapped retry fails', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse({}, 503));

    expect(await sourceWith(fetchImpl).search('a - b', 10, CTX)).toBe('unavailable');
  });

  it('aborts and answers unavailable after the timeout', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );

    const pending = sourceWith(fetchImpl, { timeoutMs: 1_000 }).search('a - b', 10, CTX);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await pending).toBe('unavailable');
  });

  describe('shared Sonovault budget', () => {
    it('spends the limiter it shares with the resolver', async () => {
      let now = 0;
      const limiter = createSonovaultLimiter(() => now);
      const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse([]));
      const source = sourceWith(fetchImpl, { limiter });
      const before = limiter.peekSync(SONOVAULT_SCOPE, 'global').remaining;

      await source.search('a - b', 10, CTX);

      expect(limiter.peekSync(SONOVAULT_SCOPE, 'global').remaining).toBe(before - 2);
      now += 60_000;
      expect(limiter.peekSync(SONOVAULT_SCOPE, 'global').remaining).toBe(before);
    });

    it('leaves the reserved calls to resolution and answers unavailable', async () => {
      const limiter = createSonovaultLimiter(() => 0);
      const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse([DAFT_PUNK]));
      const source = sourceWith(fetchImpl, { limiter });
      const total = limiter.peekSync(SONOVAULT_SCOPE, 'global').limit;

      let answered = 0;
      for (let i = 0; i < total; i++) {
        if ((await source.search(`artist ${i} - title`, 10, CTX)) !== 'unavailable') answered++;
      }

      expect(answered).toBe(total - SONOVAULT_SEARCH_RESERVE);
      expect(limiter.peekSync(SONOVAULT_SCOPE, 'global').remaining).toBe(SONOVAULT_SEARCH_RESERVE);

      const resolverFetch = vi.fn<typeof fetch>(async () =>
        jsonResponse({ links: [{ platform: 'spotify', id: '0DiWol3AO6WpXZgp0goxAV' }] }),
      );
      const resolver = new SonovaultTrackResolver({
        apiKey: 'sv-key',
        fetchImpl: resolverFetch,
        limiter,
        logger: { warn: () => {} },
      });
      expect(
        await resolver.resolve({ accountId: 'acc-1', isrc: 'GBDUW0000053', providerId: 'spotify' }),
      ).toBe('spotify:track:0DiWol3AO6WpXZgp0goxAV');
    });

    it('does not send the swapped retry when only the reserve is left', async () => {
      const limiter = createSonovaultLimiter(() => 0);
      const total = limiter.peekSync(SONOVAULT_SCOPE, 'global').limit;
      for (let i = 0; i < total - SONOVAULT_SEARCH_RESERVE - 1; i++) {
        limiter.tryApply(SONOVAULT_SCOPE, 'global');
      }
      const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse([]));

      expect(await sourceWith(fetchImpl, { limiter }).search('a - b', 10, CTX)).toBe('unavailable');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('builds its own Sonovault limiter when none is shared', async () => {
      const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse([DAFT_PUNK]));
      const source = sourceWith(fetchImpl, { now: () => 0 });

      let answered = 0;
      for (let i = 0; i < 30; i++) {
        if ((await source.search(`artist ${i} - title`, 10, CTX)) !== 'unavailable') answered++;
      }
      expect(answered).toBeGreaterThan(0);
      expect(answered).toBeLessThan(30);
    });
  });
});
