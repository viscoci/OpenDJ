/**
 * DeezerSearchSource — public Deezer search mapped to provider-agnostic
 * `opendj:isrc:` tracks. fetch is always mocked; no network.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeezerSearchSource } from '../../src/search-sources/DeezerSearchSource.js';
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
  opts: { rateLimit?: number; now?: () => number; timeoutMs?: number } = {},
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
    expect(url.searchParams.get('limit')).toBe('5');
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
