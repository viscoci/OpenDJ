import type { HttpClient } from './http.js';
import type { GuestIdentityRequest, GuestIdentityResponse } from './types.js';

/**
 * Guest resource — `/api/v1/guest/*`.
 *
 * The fingerprint → slot-token handshake. The frontend computes a stable
 * per-device fingerprint locally; the backend salts + hashes before persist.
 */
export class GuestApi {
  constructor(private readonly http: HttpClient) {}

  /**
   * Register or refresh the guest's slot for a session.
   *
   * Idempotent — calling repeatedly with the same fingerprint returns the
   * same slot token. Promotion-on-free happens server-side; the client just
   * polls (or subscribes to `guest_slots.updated` via realtime).
   */
  identity(sessionId: string, body: GuestIdentityRequest): Promise<GuestIdentityResponse> {
    return this.http.request<GuestIdentityResponse>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/guest/identity`,
      { method: 'POST', body },
    );
  }

  /**
   * Heartbeat — keeps the slot alive against the inactivity sweep.
   * Send roughly every 30 seconds while the page is foregrounded.
   */
  heartbeat(sessionId: string, slotToken: string): Promise<void> {
    return this.http.request<void>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/guest/heartbeat`,
      { method: 'POST', slotToken },
    );
  }
}
