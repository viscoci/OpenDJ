import type { HttpClient } from './http.js';

/**
 * Playback device list / activate — `/api/v1/sessions/:id/devices/*`.
 * Host-only (`provider:control_playback`). Used by the host dashboard to
 * pick which Spotify Connect endpoint should actually play audio.
 */

export interface PlaybackDeviceWire {
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
  volumePercent?: number | null;
  isRestricted?: boolean;
}

export class DevicesApi {
  constructor(private readonly http: HttpClient) {}

  /** List the host's playback devices. */
  async list(sessionId: string): Promise<{ devices: PlaybackDeviceWire[]; providerId: string }> {
    return this.http.request<{ devices: PlaybackDeviceWire[]; providerId: string }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/devices`,
    );
  }

  /**
   * Transfer playback to `deviceId`. `play=true` starts playback on the new
   * device; `play=false` (default) keeps the current paused/playing state.
   */
  async activate(
    sessionId: string,
    deviceId: string,
    opts: { play?: boolean } = {},
  ): Promise<{ ok: true; providerId: string; deviceId: string }> {
    return this.http.request<{ ok: true; providerId: string; deviceId: string }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/devices/${encodeURIComponent(deviceId)}/activate`,
      {
        method: 'POST',
        ...(opts.play !== undefined && { body: { play: opts.play } }),
      },
    );
  }
}
