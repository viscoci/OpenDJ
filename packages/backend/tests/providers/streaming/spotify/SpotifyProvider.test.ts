import { describe, expect, it, vi } from 'vitest';
import {
  InvalidProviderCredentialsError,
  isFeatureSupported,
  PROVIDER_FEATURES,
  supportsQueueTrack,
  supportsSearch,
  supportsSkipTrack,
  supportsVolumeSetAbsolute,
} from '@opendj/core';
import {
  NoActiveDeviceError,
  SpotifyApiError,
} from '../../../../src/providers/streaming/spotify/errors.js';
import { SpotifyProvider } from '../../../../src/providers/streaming/spotify/SpotifyProvider.js';

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

async function connected(impl: Parameters<typeof fakeFetch>[0]) {
  const fetchImpl = fakeFetch(impl);
  const provider = new SpotifyProvider({ fetchImpl });
  await provider.connect({ accessToken: 'AT' });
  return { provider, fetchImpl };
}

describe('SpotifyProvider — capabilities', () => {
  it('declares supported playback / queue / search / volume features', () => {
    const caps = new SpotifyProvider().getCapabilities();
    expect(caps.providerId).toBe('spotify');
    expect(isFeatureSupported(caps, PROVIDER_FEATURES.Search)).toBe(true);
    expect(isFeatureSupported(caps, PROVIDER_FEATURES.QueueTrack)).toBe(true);
    expect(isFeatureSupported(caps, PROVIDER_FEATURES.NowPlayingRead)).toBe(true);
    expect(isFeatureSupported(caps, PROVIDER_FEATURES.SkipTrack)).toBe(true);
    expect(isFeatureSupported(caps, PROVIDER_FEATURES.Pause)).toBe(true);
    expect(isFeatureSupported(caps, PROVIDER_FEATURES.Resume)).toBe(true);
    expect(isFeatureSupported(caps, PROVIDER_FEATURES.VolumeRead)).toBe(true);
    expect(isFeatureSupported(caps, PROVIDER_FEATURES.VolumeSetAbsolute)).toBe(true);
  });

  it('declares zones unsupported (Spotify uses devices)', () => {
    const caps = new SpotifyProvider().getCapabilities();
    expect(isFeatureSupported(caps, PROVIDER_FEATURES.ZonesRead)).toBe(false);
  });
});

describe('SpotifyProvider — connect / type guards', () => {
  it('throws when connect is called without an accessToken', async () => {
    await expect(new SpotifyProvider().connect({})).rejects.toThrow(/accessToken/);
  });

  it('after connect, capability + duck-typing guards both pass', async () => {
    const { provider } = await connected(() => jsonResponse({}));
    expect(supportsSearch(provider)).toBe(true);
    expect(supportsQueueTrack(provider)).toBe(true);
    expect(supportsSkipTrack(provider)).toBe(true);
    expect(supportsVolumeSetAbsolute(provider)).toBe(true);
  });

  it('disconnect clears the client', async () => {
    const { provider } = await connected(() => jsonResponse({}));
    await provider.disconnect();
    expect(provider.isConnected()).toBe(false);
  });
});

describe('SpotifyProvider.search', () => {
  it('GETs /v1/search with q + type=track + limit and maps results', async () => {
    const { provider, fetchImpl } = await connected(() =>
      jsonResponse({
        tracks: {
          items: [
            {
              uri: 'spotify:track:abc',
              name: 'Hello',
              artists: [{ name: 'A' }, { name: 'B' }],
              album: {
                images: [
                  { url: 'https://i/640.jpg', width: 640 },
                  { url: 'https://i/300.jpg', width: 300 },
                ],
              },
              duration_ms: 200_000,
            },
          ],
        },
      }),
    );
    const tracks = await provider.search('hello world', 5);
    const url = String(
      (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0],
    );
    expect(url).toContain('/v1/search?');
    expect(url).toContain('q=hello+world');
    expect(url).toContain('type=track');
    expect(url).toContain('limit=5');

    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toEqual({
      uri: 'spotify:track:abc',
      name: 'Hello',
      artist: 'A, B',
      albumArt: 'https://i/300.jpg',
      durationMs: 200_000,
    });
  });

  it('returns empty array when Spotify omits tracks block', async () => {
    const { provider } = await connected(() => jsonResponse({}));
    expect(await provider.search('x')).toEqual([]);
  });
});

describe('SpotifyProvider.queueTrack', () => {
  it('POSTs /v1/me/player/queue with uri-encoded uri', async () => {
    const { provider, fetchImpl } = await connected(() => new Response(null, { status: 204 }));
    const result = await provider.queueTrack({
      uri: 'spotify:track:abc:complex/with spaces',
      name: 't',
      artist: 'a',
      albumArt: null,
      durationMs: 100_000,
    });
    expect(result).toEqual({ success: true, status: 'queued' });
    const url = String(
      (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0],
    );
    expect(url).toContain('uri=spotify%3Atrack%3Aabc%3Acomplex');
  });

  it('translates 404 NO_ACTIVE_DEVICE into NoActiveDeviceError', async () => {
    const { provider } = await connected(
      () =>
        new Response(
          JSON.stringify({
            error: { status: 404, reason: 'NO_ACTIVE_DEVICE', message: 'no device' },
          }),
          { status: 404, headers: { 'content-type': 'application/json' } },
        ),
    );
    await expect(
      provider.queueTrack({
        uri: 'spotify:track:abc',
        name: 't',
        artist: 'a',
        albumArt: null,
        durationMs: 100_000,
      }),
    ).rejects.toBeInstanceOf(NoActiveDeviceError);
  });

  it('translates 401 into InvalidProviderCredentialsError', async () => {
    const { provider } = await connected(
      () =>
        new Response(JSON.stringify({ error: { status: 401, message: 'token expired' } }), {
          status: 401,
        }),
    );
    await expect(
      provider.queueTrack({
        uri: 'spotify:track:abc',
        name: 't',
        artist: 'a',
        albumArt: null,
        durationMs: 100_000,
      }),
    ).rejects.toBeInstanceOf(InvalidProviderCredentialsError);
  });

  it('surfaces other 4xx/5xx as SpotifyApiError', async () => {
    const { provider } = await connected(() => new Response('rate limited', { status: 429 }));
    await expect(
      provider.queueTrack({
        uri: 'spotify:track:abc',
        name: 't',
        artist: 'a',
        albumArt: null,
        durationMs: 100_000,
      }),
    ).rejects.toBeInstanceOf(SpotifyApiError);
  });
});

describe('SpotifyProvider.getNowPlaying', () => {
  it('returns null on 204 (nothing playing)', async () => {
    const { provider } = await connected(() => new Response(null, { status: 204 }));
    expect(await provider.getNowPlaying()).toBeNull();
  });

  it('returns null when item is null', async () => {
    const { provider } = await connected(() =>
      jsonResponse({ is_playing: false, progress_ms: null, item: null, device: null }),
    );
    expect(await provider.getNowPlaying()).toBeNull();
  });

  it('maps a playing track + device to NowPlayingTrack', async () => {
    const { provider } = await connected(() =>
      jsonResponse({
        is_playing: true,
        progress_ms: 12_345,
        item: {
          uri: 'spotify:track:abc',
          name: 'Hello',
          artists: [{ name: 'A' }],
          album: { images: [{ url: 'https://i/300.jpg', width: 300 }] },
          duration_ms: 200_000,
        },
        device: {
          id: 'dev-1',
          is_active: true,
          is_restricted: false,
          name: 'Phone',
          type: 'Smartphone',
          volume_percent: 70,
        },
      }),
    );
    const np = await provider.getNowPlaying();
    expect(np).toEqual({
      uri: 'spotify:track:abc',
      name: 'Hello',
      artist: 'A',
      albumArt: 'https://i/300.jpg',
      durationMs: 200_000,
      progressMs: 12_345,
      isPlaying: true,
      zoneId: 'dev-1',
    });
  });

  it('falls back to "default" zoneId when device is null', async () => {
    const { provider } = await connected(() =>
      jsonResponse({
        is_playing: true,
        progress_ms: 0,
        item: {
          uri: 'spotify:track:abc',
          name: 't',
          artists: [{ name: 'a' }],
          album: { images: [] },
          duration_ms: 100_000,
        },
        device: null,
      }),
    );
    const np = await provider.getNowPlaying();
    expect(np?.zoneId).toBe('default');
  });
});

describe('SpotifyProvider — playback control', () => {
  it('skipTrack POSTs /v1/me/player/next', async () => {
    const { provider, fetchImpl } = await connected(() => new Response(null, { status: 204 }));
    await provider.skipTrack();
    const url = String(
      (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0],
    );
    expect(url).toContain('/v1/me/player/next');
  });

  it('pause + resume hit the right endpoints', async () => {
    const calls: string[] = [];
    const fetchImpl = fakeFetch((url) => {
      calls.push(url);
      return new Response(null, { status: 204 });
    });
    const provider = new SpotifyProvider({ fetchImpl });
    await provider.connect({ accessToken: 'AT' });
    await provider.pause();
    await provider.resume();
    expect(calls[0]).toContain('/v1/me/player/pause');
    expect(calls[1]).toContain('/v1/me/player/play');
  });
});

describe('SpotifyProvider — volume', () => {
  it('getVolume reads device.volume_percent from /v1/me/player', async () => {
    const { provider } = await connected(() =>
      jsonResponse({
        device: { volume_percent: 65 },
      }),
    );
    expect(await provider.getVolume()).toEqual({ volumePercent: 65 });
  });

  it('getVolume returns 0 on 204 (no active device)', async () => {
    const { provider } = await connected(() => new Response(null, { status: 204 }));
    expect(await provider.getVolume()).toEqual({ volumePercent: 0 });
  });

  it('getVolume returns 0 when device.volume_percent is null', async () => {
    const { provider } = await connected(() => jsonResponse({ device: { volume_percent: null } }));
    expect(await provider.getVolume()).toEqual({ volumePercent: 0 });
  });

  it('setVolume clamps to [0, 100] and rounds', async () => {
    const calls: string[] = [];
    const fetchImpl = fakeFetch((url) => {
      calls.push(url);
      return new Response(null, { status: 204 });
    });
    const provider = new SpotifyProvider({ fetchImpl });
    await provider.connect({ accessToken: 'AT' });
    await provider.setVolume(150);
    await provider.setVolume(-30);
    await provider.setVolume(72.6);
    expect(calls[0]).toContain('volume_percent=100');
    expect(calls[1]).toContain('volume_percent=0');
    expect(calls[2]).toContain('volume_percent=73');
  });
});

describe('SpotifyProvider — token refresh on 401', () => {
  it('refreshes the access token on 401, retries once, persists the new token', async () => {
    let apiCalls = 0;
    let tokenCalls = 0;
    const fetchImpl = fakeFetch(async (url, init) => {
      if (url.startsWith('https://accounts.spotify.com/api/token')) {
        tokenCalls += 1;
        const body = String(init?.body ?? '');
        expect(body).toContain('grant_type=refresh_token');
        expect(body).toContain('refresh_token=RT-old');
        expect((init?.headers as Record<string, string>)['authorization']).toBe(
          // base64('cid:csecret') === 'Y2lkOmNzZWNyZXQ='
          'Basic Y2lkOmNzZWNyZXQ=',
        );
        return jsonResponse({
          access_token: 'AT-new',
          refresh_token: 'RT-new',
          token_type: 'Bearer',
          expires_in: 3600,
        });
      }
      apiCalls += 1;
      const auth = (init?.headers as Record<string, string>)['authorization'];
      // First call carries the stale token (AT-old); after refresh the
      // retry carries AT-new.
      if (apiCalls === 1) {
        expect(auth).toBe('Bearer AT-old');
        return new Response('{"error":{"status":401}}', { status: 401 });
      }
      expect(auth).toBe('Bearer AT-new');
      return jsonResponse({ tracks: { items: [] } });
    });

    const persisted: Array<{ accessToken: string; refreshToken?: string }> = [];
    const provider = new SpotifyProvider({
      fetchImpl,
      clientId: 'cid',
      clientSecret: 'csecret',
    });
    provider.setOnTokenRefreshed((tokens) => {
      persisted.push({
        accessToken: tokens.accessToken,
        ...(tokens.refreshToken !== undefined && { refreshToken: tokens.refreshToken }),
      });
    });
    await provider.connect({ accessToken: 'AT-old', refreshToken: 'RT-old' });

    const tracks = await provider.search('whatever');
    expect(tracks).toEqual([]);
    expect(apiCalls).toBe(2);
    expect(tokenCalls).toBe(1);
    expect(persisted).toEqual([{ accessToken: 'AT-new', refreshToken: 'RT-new' }]);
  });

  it('falls back to InvalidProviderCredentialsError when refresh creds are missing', async () => {
    const fetchImpl = fakeFetch(async () => new Response('{}', { status: 401 }));
    const provider = new SpotifyProvider({ fetchImpl });
    // No clientId/clientSecret on the provider — refresh should be skipped
    // and the original 401 surfaces.
    await provider.connect({ accessToken: 'AT', refreshToken: 'RT' });
    await expect(provider.search('x')).rejects.toBeInstanceOf(InvalidProviderCredentialsError);
  });

  it('throws InvalidProviderCredentialsError when refresh itself fails', async () => {
    let apiCalls = 0;
    const fetchImpl = fakeFetch(async (url) => {
      if (url.startsWith('https://accounts.spotify.com/api/token')) {
        return new Response('{"error":"invalid_grant"}', { status: 400 });
      }
      apiCalls += 1;
      return new Response('{}', { status: 401 });
    });
    const provider = new SpotifyProvider({
      fetchImpl,
      clientId: 'cid',
      clientSecret: 'csecret',
    });
    await provider.connect({ accessToken: 'AT', refreshToken: 'RT' });
    await expect(provider.search('x')).rejects.toBeInstanceOf(InvalidProviderCredentialsError);
    // Only the initial request — refresh failed so we don't retry.
    expect(apiCalls).toBe(1);
  });
});
