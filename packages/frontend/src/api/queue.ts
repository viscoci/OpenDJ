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
 * - `request` requires a slot token (guests authenticate via `x-slot-token`).
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
      >(`/api/v1/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(itemId)}/moderate`, { method: 'POST', body })
      .then((r) => r.item);
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
   * Search the session's connected streaming provider.
   *
   * Public — no slot token required. Surfaces 503 `no_provider_connected`
   * (account hasn't linked a provider yet) and 501 `search_not_supported`
   * (provider has no search capability) as `ApiError`s.
   */
  search(sessionId: string, query: string, limit?: number): Promise<SearchResponse> {
    return this.http.request<SearchResponse>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/search`,
      {
        query: { q: query, ...(limit !== undefined && { limit }) },
      },
    );
  }
}
