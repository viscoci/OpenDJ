/**
 * Add-time verification of a resolved track: the title check, the Spotify
 * oEmbed verifier, and how the resolver chain uses a verdict.
 * fetch is a mock; no network.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  parseSpotifyPageArtists,
  SpotifyOEmbedVerifier,
} from '../../src/track-resolution/SpotifyOEmbedVerifier.js';
import {
  compareArtists,
  compareTitles,
  type TrackVerifier,
} from '../../src/track-resolution/TrackVerifier.js';
import {
  TrackResolverChain,
  type TrackResolver,
} from '../../src/track-resolution/TrackResolver.js';

const quiet = { error: () => {}, warn: () => {} };

/** Spotify's oEmbed body (fields as seen live 2026-10-23), with `title` = the track name. */
function oembed(title: string): Response {
  return new Response(
    JSON.stringify({
      html: '<iframe title="Spotify Embed: x"></iframe>',
      iframe_url: 'https://open.spotify.com/embed/track/x?utm_source=oembed',
      width: 456,
      height: 152,
      version: '1.0',
      provider_name: 'Spotify',
      provider_url: 'https://spotify.com',
      type: 'rich',
      title,
      thumbnail_url: 'https://image-cdn-fa.spotifycdn.com/image/x',
      thumbnail_width: 300,
      thumbnail_height: 300,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

/** The public track page's HTML, reduced to the `<title>` it carries (as seen live 2026-10-23). */
function trackPage(title: string): Response {
  return new Response(
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><title>${title}</title>` +
      '<meta property="og:title" content="x"/></head><body><div id="main"></div></body></html>',
    { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

// Live <title>s of open.spotify.com/track/<id> pages.
const PAGE = {
  happyKen: 'Happy - song and lyrics by Ken | Spotify',
  getLucky:
    'Get Lucky (Radio Edit) [feat. Pharrell Williams and Nile Rodgers] - song and lyrics by Daft Punk, Pharrell Williams, Nile Rodgers | Spotify',
  pushIt: 'Push It - Radio Version - Song, Lyrics, and Music Video by Salt-N-Pepa | Spotify',
  bailando:
    'Bailando - (Originally Performed by Enrique Iglesias feat. Sean Paul) [Karaoke Version] - song and lyrics by HQ Deluxe | Spotify',
};

// Wrong recordings Sonovault mapped ISRCs to in the live 184-song test.
const WRONG: Array<[requested: string, candidate: string]> = [
  ['Happy', 'Happy (Karaoke Version)'],
  [
    'Bailando',
    'Bailando - (Originally Performed by Enrique Iglesias feat. Sean Paul) [Karaoke Version]',
  ],
  ['Waka Waka (This Time for Africa)', 'Waka Waka (This Time for Africa) [K-Mix]'],
];

// Legit variants of the requested recording.
const LEGIT: Array<[requested: string, candidate: string]> = [
  ['Get Lucky', 'Get Lucky (Radio Edit) [feat. Pharrell Williams and Nile Rodgers]'],
  [
    'Get Lucky (feat. Pharrell Williams & Nile Rodgers)',
    'Get Lucky (Radio Edit) [feat. Pharrell Williams and Nile Rodgers]',
  ],
  ['Shout', 'Shout'],
  ['Push It', 'Push It - Radio Version'],
  ['Wobble', 'Wobble'],
];

describe('compareTitles', () => {
  it.each(WRONG)('rejects %j → %j', (requested, candidate) => {
    expect(compareTitles(requested, candidate).ok).toBe(false);
  });

  it.each(LEGIT)('accepts %j → %j', (requested, candidate) => {
    expect(compareTitles(requested, candidate).ok).toBe(true);
  });

  it.each([
    ['Beyoncé', 'Beyonce'],
    ["Don't Stop Believin'", "Don't Stop Believin' - 2022 Remaster"],
    ['Bohemian Rhapsody', 'Bohemian Rhapsody - Remastered 2011'],
    ['Smells Like Teen Spirit', 'Smells Like Teen Spirit (Live)'],
    ['Seven Nation Army', 'Seven Nation Army feat. Nobody'],
  ])('normalises accents, remasters and suffixes: %j → %j', (requested, candidate) => {
    expect(compareTitles(requested, candidate).ok).toBe(true);
  });

  it('accepts a marker the requested name carries itself', () => {
    expect(compareTitles('Happy (Instrumental)', 'Happy - Instrumental').ok).toBe(true);
  });

  it.each([
    ['Hey Jude', 'Hey Jude - In the Style of The Beatles'],
    ['Wonderwall', 'Wonderwall (Tribute to Oasis)'],
    ['Hallelujah', 'Hallelujah - Cover'],
  ])('rejects other cover markers: %j → %j', (requested, candidate) => {
    expect(compareTitles(requested, candidate).ok).toBe(false);
  });

  it('rejects a different song', () => {
    expect(compareTitles('Happy', 'Blinding Lights').ok).toBe(false);
  });

  it('accepts token overlap of at least 0.6', () => {
    // 3 of 4 tokens shared.
    expect(compareTitles('I Gotta Feeling Tonight', 'I Gotta Feeling Today').ok).toBe(true);
    // 1 of 3 tokens shared.
    expect(compareTitles('Love Me Do', 'Love Story').ok).toBe(false);
  });
});

describe('SpotifyOEmbedVerifier', () => {
  const URI = 'spotify:track:01L8jB5ftBu1WmJEfVqsF4';

  it('asks the public oEmbed endpoint for the track', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => oembed('Shout'));
    const verifier = new SpotifyOEmbedVerifier({ fetchImpl, logger: quiet });

    expect(verifier.providerId).toBe('spotify');
    expect(await verifier.verify({ uri: URI, trackName: 'Shout' })).toEqual({ verdict: 'match' });

    const url = new URL(String(fetchImpl.mock.calls[0]![0]));
    expect(url.origin + url.pathname).toBe('https://open.spotify.com/oembed');
    expect(url.searchParams.get('url')).toBe(
      'https://open.spotify.com/track/01L8jB5ftBu1WmJEfVqsF4',
    );
  });

  it.each(WRONG)('rejects %j when Spotify names it %j', async (requested, title) => {
    const verifier = new SpotifyOEmbedVerifier({
      fetchImpl: vi.fn<typeof fetch>(async () => oembed(title)),
      logger: quiet,
    });
    expect(await verifier.verify({ uri: URI, trackName: requested })).toMatchObject({
      verdict: 'mismatch',
      title,
    });
  });

  it.each(LEGIT)('accepts %j when Spotify names it %j', async (requested, title) => {
    const verifier = new SpotifyOEmbedVerifier({
      fetchImpl: vi.fn<typeof fetch>(async () => oembed(title)),
      logger: quiet,
    });
    expect(await verifier.verify({ uri: URI, trackName: requested })).toEqual({ verdict: 'match' });
  });

  it.each([
    ['a network error', async () => Promise.reject(new Error('ECONNRESET'))],
    ['an HTTP error', async () => new Response('nope', { status: 500 })],
    ['a body without a title', async () => new Response('{}', { status: 200 })],
    ['a non-JSON body', async () => new Response('<html>', { status: 200 })],
  ] as Array<[string, () => Promise<Response>]>)('is unavailable on %s', async (_, impl) => {
    const verifier = new SpotifyOEmbedVerifier({
      fetchImpl: vi.fn<typeof fetch>(impl),
      logger: quiet,
    });
    expect(await verifier.verify({ uri: URI, trackName: 'Shout' })).toMatchObject({
      verdict: 'unavailable',
    });
  });

  it('is unavailable after its timeout', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const verifier = new SpotifyOEmbedVerifier({ fetchImpl, timeoutMs: 5, logger: quiet });
    expect(await verifier.verify({ uri: URI, trackName: 'Shout' })).toMatchObject({
      verdict: 'unavailable',
    });
  });

  it('is unavailable for a uri that is not a Spotify track', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => oembed('Shout'));
    const verifier = new SpotifyOEmbedVerifier({ fetchImpl, logger: quiet });
    expect(await verifier.verify({ uri: 'apple-music:track:1', trackName: 'Shout' })).toMatchObject(
      { verdict: 'unavailable' },
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('caches a title per uri for 24h', async () => {
    let now = 1_000_000;
    const fetchImpl = vi.fn<typeof fetch>(async () => oembed('Happy (Karaoke Version)'));
    const verifier = new SpotifyOEmbedVerifier({ fetchImpl, now: () => now, logger: quiet });

    await verifier.verify({ uri: URI, trackName: 'Happy' });
    expect(await verifier.verify({ uri: URI, trackName: 'Happy (Karaoke Version)' })).toEqual({
      verdict: 'match',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now += 24 * 60 * 60_000 + 1;
    await verifier.verify({ uri: URI, trackName: 'Happy' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not cache an unavailable answer', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('nope', { status: 503 }))
      .mockResolvedValueOnce(oembed('Shout'));
    const verifier = new SpotifyOEmbedVerifier({ fetchImpl, logger: quiet });

    expect((await verifier.verify({ uri: URI, trackName: 'Shout' })).verdict).toBe('unavailable');
    expect((await verifier.verify({ uri: URI, trackName: 'Shout' })).verdict).toBe('match');
  });

  it('stops calling past its limiter (60/min) and is unavailable', async () => {
    let now = 1_000_000;
    const fetchImpl = vi.fn<typeof fetch>(async () => oembed('Shout'));
    const verifier = new SpotifyOEmbedVerifier({ fetchImpl, now: () => now, logger: quiet });

    for (let i = 0; i < 60; i += 1) {
      expect(
        (await verifier.verify({ uri: `spotify:track:t${i}`, trackName: 'Shout' })).verdict,
      ).toBe('match');
    }
    expect((await verifier.verify({ uri: 'spotify:track:over', trackName: 'Shout' })).verdict).toBe(
      'unavailable',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(60);

    now += 60_000 + 1;
    expect((await verifier.verify({ uri: 'spotify:track:over', trackName: 'Shout' })).verdict).toBe(
      'match',
    );
  });
});

describe('parseSpotifyPageArtists', () => {
  it.each([
    [PAGE.happyKen, ['Ken']],
    [PAGE.getLucky, ['Daft Punk', 'Pharrell Williams', 'Nile Rodgers']],
    [PAGE.pushIt, ['Salt-N-Pepa']],
    [PAGE.bailando, ['HQ Deluxe']],
  ])('reads the artists from %j', (title, artists) => {
    expect(parseSpotifyPageArtists(`<html><head><title>${title}</title></head></html>`)).toEqual(
      artists,
    );
  });

  it('decodes HTML entities before splitting', () => {
    expect(
      parseSpotifyPageArtists(
        '<title>Don&#x27;t Cry - song and lyrics by Guns N&#39; Roses, Katrina &amp; The Waves | Spotify</title>',
      ),
    ).toEqual(["Guns N' Roses", 'Katrina', 'The Waves']);
  });

  it.each([
    ['no title', '<html><head></head></html>'],
    ['a title without "by"', '<title>Spotify - Web Player</title>'],
    ['an empty artist list', '<title>Happy - song and lyrics by  | Spotify</title>'],
  ])('answers null for %s', (_, html) => {
    expect(parseSpotifyPageArtists(html)).toBeNull();
  });
});

describe('compareArtists', () => {
  it.each([
    ['Daft Punk', ['Daft Punk', 'Pharrell Williams', 'Nile Rodgers']],
    ['Pharrell Williams', ['Daft Punk', 'Pharrell Williams', 'Nile Rodgers']],
    ['Daft Punk feat. Pharrell Williams', ['Daft Punk', 'Pharrell Williams']],
    ['Salt-N-Pepa', ['Salt-N-Pepa']],
    ['The Killers', ['Killers']],
    ['Killers', ['The Killers']],
    ['Beyoncé', ['Beyonce']],
    ['Sinead O’Connor', ["Sinéad O'Connor"]],
    ['Katrina & The Waves', ['Katrina', 'The Waves']],
    ['Katrina and the Waves', ['Katrina', 'The Waves']],
    ['Pharrell', ['Pharrell Williams']],
  ])('accepts %j among %j', (requested, page) => {
    expect(compareArtists(requested, page).ok).toBe(true);
  });

  it.each([
    ['Pharrell Williams', ['Ken']],
    ['Enrique Iglesias', ['HQ Deluxe']],
    ['Kenny Rogers', ['Ken']],
    ['Oasis', ['The Wonderwalls']],
  ])('rejects %j among %j', (requested, page) => {
    expect(compareArtists(requested, page).ok).toBe(false);
  });
});

describe('SpotifyOEmbedVerifier with the track page', () => {
  const ID = '01p9iQOsSKnmEJABkbkzWT';
  const URI = `spotify:track:${ID}`;

  /** oEmbed answers `oembedTitle`; the track page answers `page()`. */
  function routed(oembedTitle: string, page: () => Promise<Response> | Response) {
    return vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      return url.pathname === '/oembed' ? oembed(oembedTitle) : page();
    });
  }

  it('fetches the public track page with a browser User-Agent', async () => {
    const fetchImpl = routed('Happy', () => trackPage(PAGE.happyKen));
    const verifier = new SpotifyOEmbedVerifier({ fetchImpl, logger: quiet });
    await verifier.verify({ uri: URI, trackName: 'Happy', artistName: 'Pharrell Williams' });

    const pageCall = fetchImpl.mock.calls.find(
      ([input]) => new URL(String(input)).pathname !== '/oembed',
    );
    expect(pageCall).toBeDefined();
    expect(String(pageCall![0])).toBe(`https://open.spotify.com/track/${ID}`);
    const headers = new Headers(pageCall![1]?.headers);
    expect(headers.get('user-agent')).toMatch(/Mozilla\/5\.0/);
    expect(pageCall![1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('rejects a same-titled recording by another artist (Happy by Ken for Pharrell Williams)', async () => {
    const verifier = new SpotifyOEmbedVerifier({
      fetchImpl: routed('Happy', () => trackPage(PAGE.happyKen)),
      logger: quiet,
    });
    expect(
      await verifier.verify({ uri: URI, trackName: 'Happy', artistName: 'Pharrell Williams' }),
    ).toMatchObject({
      verdict: 'mismatch',
      title: 'Happy',
      reason: expect.stringContaining('artist'),
    });
  });

  it('accepts Get Lucky for Daft Punk', async () => {
    const verifier = new SpotifyOEmbedVerifier({
      fetchImpl: routed('Get Lucky (Radio Edit) [feat. Pharrell Williams and Nile Rodgers]', () =>
        trackPage(PAGE.getLucky),
      ),
      logger: quiet,
    });
    expect(
      await verifier.verify({ uri: URI, trackName: 'Get Lucky', artistName: 'Daft Punk' }),
    ).toEqual({ verdict: 'match' });
  });

  it('accepts the "Song, Lyrics, and Music Video by" phrasing (Push It by Salt-N-Pepa)', async () => {
    const verifier = new SpotifyOEmbedVerifier({
      fetchImpl: routed('Push It - Radio Version', () => trackPage(PAGE.pushIt)),
      logger: quiet,
    });
    expect(
      await verifier.verify({ uri: URI, trackName: 'Push It', artistName: 'Salt-N-Pepa' }),
    ).toEqual({ verdict: 'match' });
  });

  it('accepts a "The" prefix and accents that differ from the page', async () => {
    const verifier = new SpotifyOEmbedVerifier({
      fetchImpl: routed('Mr. Brightside', () =>
        trackPage('Mr. Brightside - song and lyrics by The Killers | Spotify'),
      ),
      logger: quiet,
    });
    expect(
      await verifier.verify({ uri: URI, trackName: 'Mr. Brightside', artistName: 'Killers' }),
    ).toEqual({ verdict: 'match' });

    const accented = new SpotifyOEmbedVerifier({
      fetchImpl: routed('Halo', () => trackPage('Halo - song and lyrics by Beyoncé | Spotify')),
      logger: quiet,
    });
    expect(await accented.verify({ uri: URI, trackName: 'Halo', artistName: 'Beyonce' })).toEqual({
      verdict: 'match',
    });
  });

  it('accepts a Deezer-style "Katrina & The Waves" against the page (entity-encoded)', async () => {
    const verifier = new SpotifyOEmbedVerifier({
      fetchImpl: routed('Walking On Sunshine', () =>
        trackPage('Walking On Sunshine - song and lyrics by Katrina &amp; The Waves | Spotify'),
      ),
      logger: quiet,
    });
    expect(
      await verifier.verify({
        uri: URI,
        trackName: 'Walking On Sunshine',
        artistName: 'Katrina & The Waves',
      }),
    ).toEqual({ verdict: 'match' });
  });

  it('decodes numeric entities in page artists (Guns N&#39; Roses)', async () => {
    const verifier = new SpotifyOEmbedVerifier({
      fetchImpl: routed("Sweet Child O' Mine", () =>
        trackPage('Sweet Child O&#x27; Mine - song and lyrics by Guns N&#39; Roses | Spotify'),
      ),
      logger: quiet,
    });
    expect(
      await verifier.verify({
        uri: URI,
        trackName: "Sweet Child O' Mine",
        artistName: "Guns N' Roses",
      }),
    ).toEqual({ verdict: 'match' });
  });

  it('still rejects on a title cover marker without fetching the page', async () => {
    const fetchImpl = routed('Happy (Karaoke Version)', () => trackPage(PAGE.happyKen));
    const verifier = new SpotifyOEmbedVerifier({ fetchImpl, logger: quiet });
    expect(
      await verifier.verify({ uri: URI, trackName: 'Happy', artistName: 'Pharrell Williams' }),
    ).toMatchObject({ verdict: 'mismatch', reason: expect.stringContaining('cover marker') });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('skips the page without a requested artist (title-only)', async () => {
    const fetchImpl = routed('Happy', () => trackPage(PAGE.happyKen));
    const verifier = new SpotifyOEmbedVerifier({ fetchImpl, logger: quiet });
    expect(await verifier.verify({ uri: URI, trackName: 'Happy' })).toEqual({ verdict: 'match' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a network error', async () => Promise.reject(new Error('ECONNRESET'))],
    ['an HTTP error', async () => new Response('nope', { status: 429 })],
    ['a page without a parsable title', async () => new Response('<html></html>', { status: 200 })],
  ] as Array<[string, () => Promise<Response>]>)(
    'falls back to the title-only decision on %s',
    async (_, page) => {
      const verifier = new SpotifyOEmbedVerifier({
        fetchImpl: routed('Happy', page),
        logger: quiet,
      });
      expect(
        await verifier.verify({ uri: URI, trackName: 'Happy', artistName: 'Pharrell Williams' }),
      ).toEqual({ verdict: 'match' });
    },
  );

  it('falls back to title-only when the page times out', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (new URL(String(input)).pathname === '/oembed') return oembed('Happy');
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    });
    const verifier = new SpotifyOEmbedVerifier({ fetchImpl, timeoutMs: 5, logger: quiet });
    expect(
      await verifier.verify({ uri: URI, trackName: 'Happy', artistName: 'Pharrell Williams' }),
    ).toEqual({ verdict: 'match' });
  });

  it('caches page artists per uri for 24h and does not cache a failed page', async () => {
    let now = 1_000_000;
    const pages = vi
      .fn<() => Response>()
      .mockReturnValueOnce(new Response('nope', { status: 503 }))
      .mockImplementation(() => trackPage(PAGE.happyKen));
    const fetchImpl = routed('Happy', pages);
    const verifier = new SpotifyOEmbedVerifier({ fetchImpl, now: () => now, logger: quiet });
    const req = { uri: URI, trackName: 'Happy', artistName: 'Pharrell Williams' };

    expect((await verifier.verify(req)).verdict).toBe('match'); // page failed → title-only
    expect((await verifier.verify(req)).verdict).toBe('mismatch');
    expect((await verifier.verify(req)).verdict).toBe('mismatch');
    expect(await verifier.verify({ ...req, artistName: 'Ken' })).toEqual({ verdict: 'match' });
    expect(pages).toHaveBeenCalledTimes(2);

    now += 24 * 60 * 60_000 + 1;
    await verifier.verify(req);
    expect(pages).toHaveBeenCalledTimes(3);
  });

  it('shares the 60/min limiter with oEmbed', async () => {
    const fetchImpl = routed('Happy', () => trackPage(PAGE.happyKen));
    const verifier = new SpotifyOEmbedVerifier({ fetchImpl, now: () => 1_000_000, logger: quiet });
    const req = (uri: string) => ({ uri, trackName: 'Happy', artistName: 'Pharrell Williams' });

    // 30 uris × (oEmbed + page) = 60 calls.
    for (let i = 0; i < 30; i += 1) {
      expect((await verifier.verify(req(`spotify:track:t${i}`))).verdict).toBe('mismatch');
    }
    expect(fetchImpl).toHaveBeenCalledTimes(60);
    expect((await verifier.verify(req('spotify:track:over'))).verdict).toBe('unavailable');
    expect(fetchImpl).toHaveBeenCalledTimes(60);
  });
});

describe('TrackResolverChain with verifiers', () => {
  const REQ = {
    accountId: 'acc-1',
    providerId: 'spotify',
    isrc: 'USSM11300080',
    trackName: 'Happy',
    artistName: 'Pharrell Williams',
  };

  function fixed(id: string, uri: string | null): TrackResolver {
    return { id, resolve: vi.fn(async () => uri) };
  }

  function verifierWith(
    titles: Record<string, string | Error>,
  ): TrackVerifier & { verify: ReturnType<typeof vi.fn> } {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input)).searchParams.get('url') ?? '';
      const title = titles[url.split('/').pop() ?? ''];
      if (title === undefined) return new Response('nope', { status: 404 });
      if (title instanceof Error) throw title;
      return oembed(title);
    });
    const verifier = new SpotifyOEmbedVerifier({ fetchImpl, logger: quiet });
    return Object.assign(verifier, { verify: vi.fn(verifier.verify.bind(verifier)) });
  }

  it('moves past a rejected answer to the next resolver', async () => {
    const verifier = verifierWith({ karaoke: 'Happy (Karaoke Version)', real: 'Happy' });
    const chain = new TrackResolverChain(
      [fixed('sonovault', 'spotify:track:karaoke'), fixed('provider', 'spotify:track:real')],
      quiet,
      { verifiers: [verifier] },
    );

    expect(await chain.resolve(REQ)).toEqual({ uri: 'spotify:track:real', resolverId: 'provider' });
    expect(verifier.verify).toHaveBeenCalledWith({
      uri: 'spotify:track:karaoke',
      trackName: 'Happy',
      artistName: 'Pharrell Williams',
    });
  });

  it('answers null when every answer is rejected', async () => {
    const verifier = verifierWith({ karaoke: 'Happy (Karaoke Version)' });
    const chain = new TrackResolverChain([fixed('sonovault', 'spotify:track:karaoke')], quiet, {
      verifiers: [verifier],
    });
    expect(await chain.resolve(REQ)).toBeNull();
  });

  it('logs a rejection', async () => {
    const warn = vi.fn();
    const chain = new TrackResolverChain(
      [fixed('sonovault', 'spotify:track:karaoke')],
      { error: () => {}, warn },
      { verifiers: [verifierWith({ karaoke: 'Happy (Karaoke Version)' })] },
    );
    await chain.resolve(REQ);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('rejected'));
  });

  it('accepts (fail-open) and logs when the verifier is unavailable', async () => {
    const warn = vi.fn();
    const chain = new TrackResolverChain(
      [fixed('sonovault', 'spotify:track:down'), fixed('provider', 'spotify:track:real')],
      { error: () => {}, warn },
      { verifiers: [verifierWith({ down: new Error('ECONNRESET') })] },
    );
    expect(await chain.resolve(REQ)).toEqual({
      uri: 'spotify:track:down',
      resolverId: 'sonovault',
    });
    expect(warn).toHaveBeenCalled();
  });

  it('accepts when the verifier throws', async () => {
    const throwing: TrackVerifier = {
      providerId: 'spotify',
      verify: async () => {
        throw new Error('boom');
      },
    };
    const chain = new TrackResolverChain([fixed('sonovault', 'spotify:track:x')], quiet, {
      verifiers: [throwing],
    });
    expect(await chain.resolve(REQ)).toEqual({ uri: 'spotify:track:x', resolverId: 'sonovault' });
  });

  it('never verifies a catalog hit', async () => {
    const verifier = verifierWith({ karaoke: 'Happy (Karaoke Version)' });
    const chain = new TrackResolverChain([fixed('catalog', 'spotify:track:karaoke')], quiet, {
      verifiers: [verifier],
    });
    expect(await chain.resolve(REQ)).toEqual({
      uri: 'spotify:track:karaoke',
      resolverId: 'catalog',
    });
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it('accepts without a verifier for the provider', async () => {
    const verifier = verifierWith({});
    const chain = new TrackResolverChain([fixed('sonovault', 'apple-music:track:1')], quiet, {
      verifiers: [verifier],
    });
    expect(await chain.resolve({ ...REQ, providerId: 'apple-music' })).toEqual({
      uri: 'apple-music:track:1',
      resolverId: 'sonovault',
    });
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it('accepts without a requested track name to compare against', async () => {
    const verifier = verifierWith({ karaoke: 'Happy (Karaoke Version)' });
    const chain = new TrackResolverChain([fixed('sonovault', 'spotify:track:karaoke')], quiet, {
      verifiers: [verifier],
    });
    const { trackName: _drop, ...noName } = REQ;
    expect(await chain.resolve(noName)).toEqual({
      uri: 'spotify:track:karaoke',
      resolverId: 'sonovault',
    });
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it('lists the providers it verifies', () => {
    expect(
      new TrackResolverChain([], quiet, { verifiers: [verifierWith({})] }).verifiedProviders,
    ).toEqual(['spotify']);
    expect(new TrackResolverChain([]).verifiedProviders).toEqual([]);
  });
});
