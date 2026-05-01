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
