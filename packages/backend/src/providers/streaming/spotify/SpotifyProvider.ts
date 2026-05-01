/**
 * Spotify Web API provider.
 *
 * Built on `fetch` only — no `spotify-web-api-node`, which is Node-only and
 * unsuitable for Cloudflare Workers per brief.
 *
 * Coverage:
 * - Search (Track-only)
 * - Queue track
 * - Now playing (currently-playing)
 * - Skip / Pause / Resume
 * - Volume read (via currently-playing device) + set
 *
 * Spotify uses **devices**, not zones. The provider exposes a synthetic
 * `default` zone — UI can hide the zone selector for Spotify; brief §"Provider
 * Architecture" → "Emulated capabilities" notes this on the descriptor.
 *
 * No-active-device handling: Spotify returns 404 + `error.reason='NO_ACTIVE_DEVICE'`
 * on playback-control endpoints when the host's player is idle. The client
 * translates that into `NoActiveDeviceError` — routes map it to a 400.
 */

import {
  defineCapabilities,
  PROVIDER_FEATURES,
  type IStreamingProvider,
  type ISupportsNowPlayingRead,
  type ISupportsPause,
  type ISupportsQueueTrack,
  type ISupportsResume,
  type ISupportsSearch,
  type ISupportsSkipTrack,
  type ISupportsVolumeRead,
  type ISupportsVolumeSetAbsolute,
  type NowPlayingTrack,
  type ProviderCapabilities,
  type ProviderCredentials,
  type QueueResult,
  type Track,
} from '@opendj/core';
import { SpotifyClient } from './client.js';

const SYNTHETIC_DEFAULT_ZONE_ID = 'default';

const capabilities: ProviderCapabilities = defineCapabilities('spotify', {
  [PROVIDER_FEATURES.Search]: {
    id: PROVIDER_FEATURES.Search,
    supported: true,
    access: 'guest',
    reliability: 'native',
  },
  [PROVIDER_FEATURES.QueueTrack]: {
    id: PROVIDER_FEATURES.QueueTrack,
    supported: true,
    access: 'guest',
    reliability: 'native',
  },
  [PROVIDER_FEATURES.NowPlayingRead]: {
    id: PROVIDER_FEATURES.NowPlayingRead,
    supported: true,
    access: 'guest',
    reliability: 'native',
  },
  [PROVIDER_FEATURES.PlaybackProgressRead]: {
    id: PROVIDER_FEATURES.PlaybackProgressRead,
    supported: true,
    access: 'guest',
    reliability: 'native',
  },
  [PROVIDER_FEATURES.SkipTrack]: {
    id: PROVIDER_FEATURES.SkipTrack,
    supported: true,
    access: 'host',
    reliability: 'native',
  },
  [PROVIDER_FEATURES.Pause]: {
    id: PROVIDER_FEATURES.Pause,
    supported: true,
    access: 'host',
    reliability: 'native',
  },
  [PROVIDER_FEATURES.Resume]: {
    id: PROVIDER_FEATURES.Resume,
    supported: true,
    access: 'host',
    reliability: 'native',
  },
  [PROVIDER_FEATURES.VolumeRead]: {
    id: PROVIDER_FEATURES.VolumeRead,
    supported: true,
    access: 'host',
    reliability: 'native',
  },
  [PROVIDER_FEATURES.VolumeSetAbsolute]: {
    id: PROVIDER_FEATURES.VolumeSetAbsolute,
    supported: true,
    access: 'host',
    reliability: 'native',
  },
  [PROVIDER_FEATURES.ZonesRead]: {
    id: PROVIDER_FEATURES.ZonesRead,
    supported: false,
    access: 'host',
    reliability: 'unsupported',
    notes: 'Spotify uses devices, not OpenDJ zones. A synthetic "default" zone is exposed.',
  },
});

interface SpotifyArtist {
  name: string;
}

interface SpotifyImage {
  url: string;
  height?: number;
  width?: number;
}

interface SpotifyTrack {
  uri: string;
  name: string;
  artists: SpotifyArtist[];
  album: { images: SpotifyImage[] };
  duration_ms: number;
}

interface SpotifySearchResponse {
  tracks?: { items: SpotifyTrack[] };
}

interface SpotifyDevice {
  id: string;
  is_active: boolean;
  is_restricted: boolean;
  name: string;
  type: string;
  volume_percent: number | null;
}

interface SpotifyNowPlayingResponse {
  is_playing: boolean;
  progress_ms: number | null;
  item: SpotifyTrack | null;
  device: SpotifyDevice | null;
}

function joinArtists(artists: SpotifyArtist[]): string {
  return artists.map((a) => a.name).join(', ');
}

function pickAlbumArt(images: SpotifyImage[]): string | null {
  if (images.length === 0) return null;
  // Spotify lists images in descending size; the smallest is usually fine for thumbnails.
  // Pick the one closest to 300px, fall back to the smallest.
  const target = images.find((i) => i.width != null && i.width <= 300) ?? images[images.length - 1];
  return target?.url ?? null;
}

function toTrack(spotify: SpotifyTrack): Track {
  return {
    uri: spotify.uri,
    name: spotify.name,
    artist: joinArtists(spotify.artists),
    albumArt: pickAlbumArt(spotify.album.images),
    durationMs: spotify.duration_ms,
  };
}

export interface SpotifyProviderOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

export class SpotifyProvider
  implements
    IStreamingProvider,
    ISupportsSearch,
    ISupportsQueueTrack,
    ISupportsNowPlayingRead,
    ISupportsSkipTrack,
    ISupportsPause,
    ISupportsResume,
    ISupportsVolumeRead,
    ISupportsVolumeSetAbsolute
{
  readonly providerId = 'spotify';
  readonly displayName = 'Spotify';

  private client: SpotifyClient | null = null;
  private credentials: ProviderCredentials | null = null;

  constructor(private readonly options: SpotifyProviderOptions = {}) {}

  async connect(credentials: ProviderCredentials): Promise<void> {
    if (!credentials['accessToken']) {
      throw new Error('SpotifyProvider.connect requires an accessToken in credentials.');
    }
    this.credentials = { ...credentials };
    this.client = new SpotifyClient({
      accessToken: credentials['accessToken'],
      fetchImpl: this.options.fetchImpl ?? globalThis.fetch,
      ...(this.options.baseUrl !== undefined && { baseUrl: this.options.baseUrl }),
    });
  }

  async disconnect(): Promise<void> {
    this.client = null;
    this.credentials = null;
  }

  isConnected(): boolean {
    return this.client !== null;
  }

  async refreshCredentials(): Promise<ProviderCredentials> {
    // Token refresh is the StreamingRouter / token-refresh worker's job —
    // SpotifyProvider just reports its current credentials.
    return this.credentials ?? {};
  }

  getCapabilities(): ProviderCapabilities {
    return capabilities;
  }

  // ─── ISupportsSearch ──────────────────────────────────────────────────

  async search(query: string, limit = 20): Promise<Track[]> {
    const client = this.requireClient();
    const params = new URLSearchParams({ q: query, type: 'track', limit: String(limit) });
    const response = await client.request('GET', `/v1/search?${params.toString()}`);
    const body = (await response.json()) as SpotifySearchResponse;
    return (body.tracks?.items ?? []).map(toTrack);
  }

  // ─── ISupportsQueueTrack ──────────────────────────────────────────────

  async queueTrack(track: Track, _zoneId?: string): Promise<QueueResult> {
    const client = this.requireClient();
    await client.request('POST', `/v1/me/player/queue?uri=${encodeURIComponent(track.uri)}`);
    return { success: true, status: 'queued' };
  }

  // ─── ISupportsNowPlayingRead ─────────────────────────────────────────

  async getNowPlaying(_zoneId?: string): Promise<NowPlayingTrack | null> {
    const client = this.requireClient();
    const response = await client.request('GET', '/v1/me/player/currently-playing');
    if (response.status === 204) return null;
    const body = (await response.json()) as SpotifyNowPlayingResponse;
    if (!body.item) return null;
    const track = toTrack(body.item);
    return {
      ...track,
      progressMs: body.progress_ms ?? 0,
      isPlaying: body.is_playing,
      zoneId: body.device?.id ?? SYNTHETIC_DEFAULT_ZONE_ID,
    };
  }

  // ─── Playback control ────────────────────────────────────────────────

  async skipTrack(_zoneId?: string): Promise<void> {
    await this.requireClient().request('POST', '/v1/me/player/next');
  }

  async pause(_zoneId?: string): Promise<void> {
    await this.requireClient().request('PUT', '/v1/me/player/pause');
  }

  async resume(_zoneId?: string): Promise<void> {
    await this.requireClient().request('PUT', '/v1/me/player/play');
  }

  // ─── Volume ──────────────────────────────────────────────────────────

  /**
   * Spotify reports volume on the playback-state's `device` object. We use
   * `/v1/me/player` (not currently-playing) because that endpoint always
   * returns the device when there is one, even when paused.
   *
   * Returns `{ volumePercent: 0 }` when no device is active or the device
   * doesn't expose volume — callers should pair this with a check on
   * `getNowPlaying()` if they need to distinguish "muted" from "no device".
   */
  async getVolume(_zoneId?: string): Promise<{ volumePercent: number }> {
    const response = await this.requireClient().request('GET', '/v1/me/player');
    if (response.status === 204) return { volumePercent: 0 };
    const body = (await response.json()) as { device?: { volume_percent: number | null } };
    return { volumePercent: body.device?.volume_percent ?? 0 };
  }

  async setVolume(volumePercent: number, _zoneId?: string): Promise<void> {
    const clamped = Math.max(0, Math.min(100, Math.round(volumePercent)));
    await this.requireClient().request('PUT', `/v1/me/player/volume?volume_percent=${clamped}`);
  }

  private requireClient(): SpotifyClient {
    if (!this.client) {
      throw new Error('SpotifyProvider used before connect().');
    }
    return this.client;
  }
}
