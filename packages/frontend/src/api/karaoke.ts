import type { HttpClient } from './http.js';
import type { KaraokeClaimWire } from './types.js';

/** Response envelope of POST /karaoke/claims. */
export interface KaraokeClaimResponse {
  claim: KaraokeClaimWire & { queueItemId: string };
}

/**
 * Karaoke resource — `/api/v1/sessions/:id/karaoke/*`.
 *
 * Mic claims on queue items. Guest actions authenticate with the slot token
 * (same Bearer scheme as queue requests); host claim removal rides the
 * cookie session with the `queue:moderate` claim.
 *
 * A claim can also be bundled directly with a track request — see
 * `RequestTrackBody.karaoke` on the queue resource.
 */
export class KaraokeApi {
  constructor(private readonly http: HttpClient) {}

  /**
   * Claim a mic on a queue item. Any guest in the session may claim an open
   * mic (duets welcome), not just the requester. Server-side rejections:
   * `karaoke_off`, `item_not_claimable`, `mics_full`, `already_claimed`,
   * `invalid_display_name`.
   */
  claim(
    sessionId: string,
    slotToken: string,
    body: { queueItemId: string; displayName: string },
  ): Promise<KaraokeClaimResponse['claim']> {
    return this.http
      .request<KaraokeClaimResponse>(
        `/api/v1/sessions/${encodeURIComponent(sessionId)}/karaoke/claims`,
        { method: 'POST', body, slotToken },
      )
      .then((r) => r.claim);
  }

  /**
   * Remove the guest's OWN claim from an item. Only allowed while the item
   * is still waiting (400 `item_not_waiting` once it's playing).
   */
  removeClaim(sessionId: string, queueItemId: string, slotToken: string): Promise<{ ok: true }> {
    return this.http.request(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/karaoke/claims/${encodeURIComponent(queueItemId)}`,
      { method: 'DELETE', slotToken },
    );
  }

  /**
   * Host override: remove ANY guest's claim (works even mid-song).
   * Cookie-authenticated; requires the `queue:moderate` claim.
   */
  hostRemoveClaim(sessionId: string, queueItemId: string, guestId: string): Promise<{ ok: true }> {
    return this.http.request(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/karaoke/claims/${encodeURIComponent(queueItemId)}`,
      { method: 'DELETE', query: { guestId } },
    );
  }
}
