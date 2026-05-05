import type { HttpClient } from './http.js';

/**
 * Playback control — `POST /api/v1/sessions/:id/playback/{skip,pause,resume}`.
 * Host-only (cookie session + `provider:control_playback` claim). Each
 * route 200s on success, 501 if the provider doesn't implement the action,
 * 503 if no provider is connected, 502 on provider-side error.
 *
 * Plus `voteSkip` — guest action over slot-token auth.
 */
export class PlaybackApi {
  constructor(private readonly http: HttpClient) {}

  skip(sessionId: string): Promise<{ ok: true }> {
    return this.http.request<{ ok: true }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/playback/skip`,
      { method: 'POST' },
    );
  }

  pause(sessionId: string): Promise<{ ok: true }> {
    return this.http.request<{ ok: true }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/playback/pause`,
      { method: 'POST' },
    );
  }

  resume(sessionId: string): Promise<{ ok: true }> {
    return this.http.request<{ ok: true }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/playback/resume`,
      { method: 'POST' },
    );
  }

  /**
   * Guest action: cast a vote-to-skip the currently-playing track.
   * Authenticated by the guest's slot token. Returns the new aggregate
   * count + threshold; `thresholdReached: true` means the server has
   * already triggered a provider-side skip.
   */
  voteSkip(
    sessionId: string,
    slotToken: string,
  ): Promise<{
    count: number;
    threshold: number;
    thresholdReached: boolean;
    trackUri: string;
  }> {
    return this.http.request(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/playback/skip-vote`,
      { method: 'POST', slotToken },
    );
  }
}
