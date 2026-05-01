import { describe, expect, it, vi } from 'vitest';
import { LrclibAdapter } from '../../src/providers/lrclib.js';

function fakeFetch(impl: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    return impl(url, init);
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('LrclibAdapter.getBestMatch', () => {
  it('calls /api/get with track/artist/album/duration (seconds)', async () => {
    const fetchImpl = fakeFetch(() =>
      jsonResponse({
        id: 42,
        trackName: 'Hello',
        artistName: 'World',
        albumName: 'Album',
        duration: 200,
        instrumental: false,
        plainLyrics: 'plain text',
        syncedLyrics: '[00:01.00]first\n[00:03.00]second',
      }),
    );
    const adapter = new LrclibAdapter({ fetchImpl });
    const doc = await adapter.getBestMatch({
      trackName: 'Hello',
      artistName: 'World',
      albumName: 'Album',
      durationMs: 200_000,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const call = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    const url = String(call[0]);
    expect(url).toContain('/api/get?');
    expect(url).toContain('track_name=Hello');
    expect(url).toContain('artist_name=World');
    expect(url).toContain('album_name=Album');
    expect(url).toContain('duration=200');

    expect(doc).not.toBeNull();
    expect(doc!.id).toBe('lrclib:42');
    expect(doc!.source).toBe('lrclib');
    expect(doc!.providerLyricsId).toBe(42);
    expect(doc!.isSynced).toBe(true);
    expect(doc!.lines).toHaveLength(2);
    expect(doc!.matchConfidence).toBe('high');
    expect(doc!.attribution).toContain('LRCLIB');
    expect(doc!.durationMs).toBe(200_000);
    expect(doc!.rawLrc).toContain('[00:01.00]');
    expect(doc!.plainText).toBe('plain text');
  });

  it('returns null on 404', async () => {
    const fetchImpl = fakeFetch(() => new Response('', { status: 404 }));
    const adapter = new LrclibAdapter({ fetchImpl });
    const doc = await adapter.getBestMatch({ trackName: 'No', artistName: 'Match' });
    expect(doc).toBeNull();
  });

  it('returns null when fetch throws (never lets playback fail on lyrics)', async () => {
    const fetchImpl = fakeFetch(() => {
      throw new Error('network down');
    });
    const adapter = new LrclibAdapter({ fetchImpl });
    const doc = await adapter.getBestMatch({ trackName: 'a', artistName: 'b' });
    expect(doc).toBeNull();
  });

  it('returns null when JSON parse fails', async () => {
    const fetchImpl = fakeFetch(
      () =>
        new Response('not-json', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const adapter = new LrclibAdapter({ fetchImpl });
    const doc = await adapter.getBestMatch({ trackName: 'a', artistName: 'b' });
    expect(doc).toBeNull();
  });

  it('marks isSynced=false when only plainLyrics returned', async () => {
    const fetchImpl = fakeFetch(() =>
      jsonResponse({
        id: 1,
        trackName: 't',
        artistName: 'a',
        plainLyrics: 'just plain',
        syncedLyrics: null,
      }),
    );
    const adapter = new LrclibAdapter({ fetchImpl });
    const doc = await adapter.getBestMatch({ trackName: 't', artistName: 'a' });
    expect(doc!.isSynced).toBe(false);
    expect(doc!.lines).toEqual([]);
    expect(doc!.plainText).toBe('just plain');
    expect(doc!.rawLrc).toBeUndefined();
  });

  it('omits duration param when not provided', async () => {
    const fetchImpl = fakeFetch(() =>
      jsonResponse({ id: 1, trackName: 't', artistName: 'a', syncedLyrics: '[00:00]x' }),
    );
    const adapter = new LrclibAdapter({ fetchImpl });
    await adapter.getBestMatch({ trackName: 't', artistName: 'a' });
    const url = String(
      (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0],
    );
    expect(url).not.toContain('duration=');
  });
});

describe('LrclibAdapter.search', () => {
  it('calls /api/search and returns medium-confidence docs', async () => {
    const fetchImpl = fakeFetch(() =>
      jsonResponse([
        { id: 1, trackName: 'Hello', artistName: 'World', syncedLyrics: '[00:01.00]a' },
        { id: 2, trackName: 'Hello', artistName: 'World', syncedLyrics: null, plainLyrics: 'p' },
      ]),
    );
    const adapter = new LrclibAdapter({ fetchImpl });
    const docs = await adapter.search({ trackName: 'Hello', artistName: 'World' });
    expect(docs).toHaveLength(2);
    expect(docs[0]?.matchConfidence).toBe('medium');
    expect(docs[0]?.isSynced).toBe(true);
    expect(docs[1]?.isSynced).toBe(false);

    const url = String(
      (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0],
    );
    expect(url).toContain('/api/search?');
  });

  it('returns empty array on non-OK response', async () => {
    const fetchImpl = fakeFetch(() => new Response('', { status: 500 }));
    const adapter = new LrclibAdapter({ fetchImpl });
    const docs = await adapter.search({ trackName: 't', artistName: 'a' });
    expect(docs).toEqual([]);
  });

  it('returns empty array when fetch throws', async () => {
    const fetchImpl = fakeFetch(() => {
      throw new Error('boom');
    });
    const adapter = new LrclibAdapter({ fetchImpl });
    const docs = await adapter.search({ trackName: 't', artistName: 'a' });
    expect(docs).toEqual([]);
  });
});

describe('LrclibAdapter — config', () => {
  it('respects a custom baseUrl', async () => {
    const fetchImpl = fakeFetch(() => jsonResponse({ id: 1, trackName: 't', artistName: 'a' }));
    const adapter = new LrclibAdapter({ baseUrl: 'https://example.test/lyrics', fetchImpl });
    await adapter.getBestMatch({ trackName: 't', artistName: 'a' });
    const url = String(
      (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0],
    );
    expect(url).toMatch(/^https:\/\/example\.test\/lyrics\/get\?/);
  });

  it('strips trailing slash from baseUrl', async () => {
    const fetchImpl = fakeFetch(() => jsonResponse({ id: 1, trackName: 't', artistName: 'a' }));
    const adapter = new LrclibAdapter({ baseUrl: 'https://example.test/api/', fetchImpl });
    await adapter.getBestMatch({ trackName: 't', artistName: 'a' });
    const url = String(
      (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0],
    );
    expect(url).toMatch(/^https:\/\/example\.test\/api\/get\?/);
  });

  it('sends a User-Agent header by default', async () => {
    const fetchImpl = fakeFetch(() => jsonResponse({ id: 1, trackName: 't', artistName: 'a' }));
    const adapter = new LrclibAdapter({ fetchImpl });
    await adapter.getBestMatch({ trackName: 't', artistName: 'a' });
    const init = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![1] as
      | RequestInit
      | undefined;
    const headers = init?.headers as Record<string, string>;
    expect(headers['user-agent']).toContain('OpenDJ');
  });
});
