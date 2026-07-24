import type { HttpClient } from './http.js';
import type { LyricsDocument } from '@opendj/lyrics';
import type { LyricsFeedbackBody } from './types.js';

/**
 * Lyrics resource — `/api/v1/lyrics/*`.
 *
 * Lookup is cached server-side. Feedback updates the cache's report counters
 * and may trigger auto-suppression at the moderation threshold.
 */
export class LyricsApi {
  constructor(private readonly http: HttpClient) {}

  /** Cache-fronted lookup. Mirrors GET /api/v1/lyrics/lookup. */
  lookup(input: {
    trackName: string;
    artistName: string;
    albumName?: string;
    durationMs?: number;
    providerTrackUri?: string;
  }): Promise<LyricsDocument | null> {
    return this.http
      .request<{ match: LyricsDocument | null }>('/api/v1/lyrics/lookup', { query: { ...input } })
      .then((r) => r.match);
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
