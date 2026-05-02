import type { HttpClient } from './http.js';
import type { LyricsFeedbackBody, LyricsResponse } from './types.js';

/**
 * Lyrics resource — `/api/v1/lyrics/*`.
 *
 * Lookup is cached server-side. Feedback updates the cache's report counters
 * and may trigger auto-suppression at the moderation threshold.
 */
export class LyricsApi {
  constructor(private readonly http: HttpClient) {}

  lookupByTrackUri(trackUri: string): Promise<LyricsResponse | null> {
    return this.http
      .request<LyricsResponse | { lyrics: null }>('/api/v1/lyrics/lookup', {
        query: { trackUri },
      })
      .then((r) => ((r as { lyrics?: null }).lyrics === null ? null : (r as LyricsResponse)));
  }

  /**
   * Report an issue with cached lyrics. `kind` is open-ended — the backend
   * counts feedback per kind for moderation thresholds.
   */
  feedback(sessionId: string, trackUri: string, body: LyricsFeedbackBody): Promise<void> {
    return this.http.request<void>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/lyrics/feedback`,
      { method: 'POST', body: { trackUri, ...body } },
    );
  }
}
