/**
 * Modular feature interfaces. A provider implements only the ISupports*
 * interfaces it can fulfill, then declares matching capability descriptors.
 *
 * Routes and UI MUST check capability + type guard before calling any of these
 * methods on the base IStreamingProvider type.
 *
 * See docs/agent-brief.md §"Provider Architecture" → "Modular provider feature interfaces".
 */

import type { NowPlayingTrack, Track, Zone } from '../types/index.js';

/**
 * Outcome of a queue/playlist mutation. Providers may translate a single
 * "queue this track" intent into different concrete behaviors:
 *
 * - 'queued': injected into the active queue
 * - 'playlist_switched': active playlist was changed (some providers can't inject)
 * - 'pending_host_action': host approval needed before the action commits
 */
export interface QueueResult {
  success: boolean;
  status: 'queued' | 'playlist_switched' | 'pending_host_action';
  message?: string;
}

export interface PlaylistSummary {
  uri: string;
  name: string;
  description?: string | null;
  trackCount?: number;
  imageUrl?: string | null;
}

export interface ISupportsSearch {
  search(query: string, limit?: number): Promise<Track[]>;
}

export interface ISupportsZonesRead {
  listZones(): Promise<Zone[]>;
}

export interface ISupportsNowPlayingRead {
  getNowPlaying(zoneId?: string): Promise<NowPlayingTrack | null>;
}

export interface ISupportsQueueTrack {
  queueTrack(track: Track, zoneId?: string): Promise<QueueResult>;
}

/**
 * Read what's queued up to play on the provider AFTER the current track.
 * Spotify exposes this via `GET /v1/me/player/queue`. Used by the realtime
 * snapshot so the host UI + TV can show the actual playback queue, not
 * just OpenDJ-mediated guest requests.
 */
export interface ISupportsQueueRead {
  getQueue(zoneId?: string): Promise<Track[]>;
}

export interface ISupportsPlaylistSwitch {
  switchPlaylist(playlistUri: string, zoneId?: string): Promise<QueueResult>;
}

export interface ISupportsSkipTrack {
  skipTrack(zoneId?: string): Promise<void>;
}

export interface ISupportsPause {
  pause(zoneId?: string): Promise<void>;
}

export interface ISupportsResume {
  resume(zoneId?: string): Promise<void>;
}

export interface ISupportsVolumeRead {
  getVolume(zoneId?: string): Promise<{ volumePercent: number }>;
}

export interface ISupportsVolumeSetAbsolute {
  setVolume(volumePercent: number, zoneId?: string): Promise<void>;
}

export interface ISupportsVolumeStep {
  increaseVolume(stepPercent?: number, zoneId?: string): Promise<void>;
  decreaseVolume(stepPercent?: number, zoneId?: string): Promise<void>;
}

export interface ISupportsPlaylistsRead {
  listPlaylists(
    limit?: number,
    cursor?: string,
  ): Promise<{ items: PlaylistSummary[]; nextCursor?: string }>;
}

export interface ISupportsPlaylistTracksRead {
  listPlaylistTracks(
    playlistUri: string,
    limit?: number,
    cursor?: string,
  ): Promise<{ items: Track[]; nextCursor?: string }>;
}

export interface ISupportsPlaylistTracksAdd {
  addTracksToPlaylist(playlistUri: string, trackUris: string[]): Promise<void>;
}

/**
 * A discoverable playback device the provider can target. Modeled on
 * Spotify Connect's device list — the host UI uses it to switch which
 * speaker / phone / browser tab actually plays audio.
 */
export interface PlaybackDevice {
  id: string;
  name: string;
  type:
    | 'computer'
    | 'speaker'
    | 'phone'
    | 'tablet'
    | 'tv'
    | 'avr'
    | 'stb'
    | 'audio_dongle'
    | 'game_console'
    | 'cast_audio'
    | 'cast_video'
    | 'automobile'
    | 'unknown';
  isActive: boolean;
  /** Provider-controlled volume on this device (0-100), if known. */
  volumePercent?: number | null;
  /** Some devices restrict transfer (e.g. browser tabs that have lost focus). */
  isRestricted?: boolean;
}

export interface ISupportsDevices {
  /** List currently-known playback devices for the connected provider account. */
  getDevices(): Promise<PlaybackDevice[]>;
  /** Move active playback to the given device. Provider may keep current state (paused vs playing). */
  transferPlayback(deviceId: string, opts?: { play?: boolean }): Promise<void>;
}
