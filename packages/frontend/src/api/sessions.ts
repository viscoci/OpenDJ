import type { NowPlayingTrack } from '@opendj/core';
import type { HttpClient } from './http.js';
import type {
  CreateSessionRequest,
  QueueItemSummaryWire,
  SessionEnvelope,
  SessionWire,
} from './types.js';

/**
 * One-shot snapshot for the public TV view — read-only, no auth. Backed by
 * `GET /api/v1/sessions/by-slug/:slug/tv-snapshot`. Combines session
 * metadata, the current playing track, recently-played history, the
 * approved queue, and the active guest count so the casting page can
 * paint a full first frame without a WS handshake.
 */
export interface TvSnapshotResponse {
  session: SessionWire;
  nowPlaying: NowPlayingTrack | null;
  recentlyPlayed: NowPlayingTrack[];
  queue: QueueItemSummaryWire[];
  activeGuestCount: number;
}

/**
 * Sessions resource — `/api/v1/sessions/*`.
 *
 * `getById` is public (guests use it to hydrate the request page). Mutations
 * require host claims — the cookie session is enough; no additional plumbing
 * here.
 */
export class SessionsApi {
  constructor(private readonly http: HttpClient) {}

  getById(sessionId: string): Promise<SessionWire> {
    return this.http
      .request<SessionEnvelope<SessionWire>>(`/api/v1/sessions/${encodeURIComponent(sessionId)}`)
      .then((r) => r.session);
  }

  /**
   * Resolve a session by its `qrSlug` — used by the guest landing page.
   * Backend route: `GET /api/v1/sessions/by-slug/:slug`.
   */
  getBySlug(qrSlug: string): Promise<SessionWire> {
    return this.http
      .request<
        SessionEnvelope<SessionWire>
      >(`/api/v1/sessions/by-slug/${encodeURIComponent(qrSlug)}`)
      .then((r) => r.session);
  }

  create(input: CreateSessionRequest): Promise<SessionWire> {
    return this.http
      .request<SessionEnvelope<SessionWire>>('/api/v1/sessions', { method: 'POST', body: input })
      .then((r) => r.session);
  }

  update(sessionId: string, input: Partial<CreateSessionRequest>): Promise<SessionWire> {
    return this.http
      .request<SessionEnvelope<SessionWire>>(`/api/v1/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'PATCH',
        body: input,
      })
      .then((r) => r.session);
  }

  /**
   * List sessions in the caller's `currentAccount`. Requires auth +
   * `session:read`. Used by the host dashboard.
   */
  listForCurrentAccount(): Promise<ReadonlyArray<SessionWire>> {
    return this.http
      .request<{ sessions: ReadonlyArray<SessionWire> }>('/api/v1/sessions')
      .then((r) => r.sessions);
  }

  /** End a session. Backend uses DELETE /:id (idempotent — already-ended sessions are returned as-is). */
  end(sessionId: string): Promise<SessionWire> {
    return this.http
      .request<SessionEnvelope<SessionWire>>(`/api/v1/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
      })
      .then((r) => r.session);
  }

  /**
   * One-shot read of the public casting state for `qrSlug`. Pulls the
   * realtime snapshot (when a room is materialized) merged with repo
   * fallbacks. Used by the `/tv/:slug` page so it can render a full first
   * frame before opening the realtime WebSocket for deltas.
   */
  tvSnapshot(qrSlug: string): Promise<TvSnapshotResponse> {
    return this.http.request<TvSnapshotResponse>(
      `/api/v1/sessions/by-slug/${encodeURIComponent(qrSlug)}/tv-snapshot`,
    );
  }
}
