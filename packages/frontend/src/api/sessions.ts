import type { HttpClient } from './http.js';
import type { CreateSessionRequest, SessionEnvelope, SessionWire } from './types.js';

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
}
