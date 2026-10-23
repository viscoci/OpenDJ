import type { HttpClient } from './http.js';
import type {
  ItemEnvelope,
  ItemsEnvelope,
  ModerateQueueItemBody,
  QueueItemSummaryWire,
  RequestTrackBody,
  SearchResponse,
} from './types.js';

/**
 * Queue resource — `/api/v1/sessions/:id/queue/*`.
 *
 * - `list` is callable by hosts (returns all statuses) or guests (the backend
 *   filters to currently-visible items).
 * - `request` requires a slot token (guests send `Authorization: Bearer <token>`).
 * - `moderate` requires a host claim — cookie session.
 * - `voteSkip` requires a slot token and is rate-limited per (item, slot).
 */
export class QueueApi {
  constructor(private readonly http: HttpClient) {}

  list(sessionId: string): Promise<ReadonlyArray<QueueItemSummaryWire>> {
    return this.http
      .request<
        ItemsEnvelope<QueueItemSummaryWire>
      >(`/api/v1/sessions/${encodeURIComponent(sessionId)}/queue`)
      .then((r) => r.items);
  }

  /**
   * Request a track. A `uri` that isn't native to the host's provider (an
   * `'external'` search result) is resolved by the server; when it can't be,
   * this rejects with 422 `track_unresolvable` and nothing is queued.
   */
  request(
    sessionId: string,
    slotToken: string,
    body: RequestTrackBody,
  ): Promise<QueueItemSummaryWire> {
    return this.http
      .request<
        ItemEnvelope<QueueItemSummaryWire>
      >(`/api/v1/sessions/${encodeURIComponent(sessionId)}/queue`, { method: 'POST', body, slotToken })
      .then((r) => r.item);
  }

  moderate(
    sessionId: string,
    itemId: string,
    body: ModerateQueueItemBody,
  ): Promise<QueueItemSummaryWire> {
    return this.http
      .request<
        ItemEnvelope<QueueItemSummaryWire>
      >(`/api/v1/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(itemId)}`, { method: 'PATCH', body })
      .then((r) => r.item);
  }

  /**
   * Guest removes their own queue item. Slot-token auth, owner-only on
   * the server. 400 `item_playing` when the track is currently on the
   * playhead — guests can only pull pending/approved/queued rows.
   */
  remove(sessionId: string, itemId: string, slotToken: string): Promise<{ ok: true }> {
    return this.http.request(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(itemId)}`,
      { method: 'DELETE', slotToken },
    );
  }

  voteSkip(
    sessionId: string,
    itemId: string,
    slotToken: string,
  ): Promise<{ votes: number; threshold: number }> {
    return this.http.request<{ votes: number; threshold: number }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(itemId)}/skip-vote`,
      { method: 'POST', slotToken },
    );
  }

  /**
   * Vote-to-skip a provider-queue track that has no OpenDJ counterpart
   * (host queued it via Spotify directly, playlist context, etc.).
   * Threshold semantics match `voteSkip` — server triggers the actual
   * skip when the count crosses `voteSkipThreshold`.
   */
  voteSkipProviderTrack(
    sessionId: string,
    trackUri: string,
    slotToken: string,
  ): Promise<{ count: number; threshold: number; thresholdReached: boolean }> {
    return this.http.request(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/queue/provider-vote-skip`,
      { method: 'POST', body: { trackUri }, slotToken },
    );
  }

  /**
   * Host force-rejects a provider-queue track. Cookie-authenticated host
   * action — bypasses the vote threshold. Server skips immediately if the
   * URI is currently playing; otherwise the next now-playing tick skips
   * when it lands. Returns `{skippedNow}` for UX feedback.
   */
  hostRejectProviderTrack(sessionId: string, trackUri: string): Promise<{ skippedNow: boolean }> {
    return this.http.request(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/queue/provider-reject`,
      { method: 'POST', body: { trackUri } },
    );
  }

  /**
   * Search the session's connected streaming provider.
   *
   * Optional guest auth — pass the slot token so the search counts against
   * that guest's limit; without one it shares the anonymous limit. Surfaces
   * these as `ApiError`s (branch on `code`; `payload.retryAfterSec` carries
   * the wait for the rate-limit codes):
   * - 429 `search_too_fast` — this guest is searching too quickly
   * - 503 `search_busy` — the deployment's search budget is spent
   * - 503 `search_daily_limit` — the deployment's daily search cap is spent
   * - 503 `provider_rate_limited` — the provider is rate limiting the account
   * - 503 `search_unavailable` — no configured search source could be asked
   * - 503 `no_provider_connected`, 501 `search_not_supported`
   *
   * While the provider can't be asked (busy, daily cap, provider limit), a
   * 200 may instead carry `source: 'local'` matches from tracks already seen
   * on this deployment, with `fallbackReason`; the refusals above only come
   * when nothing local matches. A deployment with `SEARCH_SOURCES` set may
   * answer from another source first: `source: 'external'` results carry
   * `opendj:isrc:<ISRC>` uris (and `isrc`), resolved to the host's provider
   * when requested.
   *
   * An aborted `signal` rejects with `NetworkError`; check `signal.aborted`
   * to tell a cancellation from a real network failure.
   */
  search(
    sessionId: string,
    query: string,
    limit?: number,
    options: { slotToken?: string; signal?: AbortSignal } = {},
  ): Promise<SearchResponse> {
    return this.http.request<SearchResponse>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/search`,
      {
        query: { q: query, ...(limit !== undefined && { limit }) },
        ...(options.slotToken !== undefined && { slotToken: options.slotToken }),
        ...(options.signal !== undefined && { signal: options.signal }),
      },
    );
  }
}
