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
   * Register or refresh the guest's slot. Looked up by `eventSlug` (the
   * session's QR slug) — the backend resolves the session, performs cap
   * checks, and either issues an active slot, a queued slot, or a priority
   * re-entry.
   *
   * Idempotent — calling repeatedly with the same fingerprint hash returns
   * the same slot token.
   */
  identity(body: GuestIdentityRequest): Promise<GuestIdentityResponse> {
    return this.http.request<GuestIdentityResponse>('/api/v1/guest/identity', {
      method: 'POST',
      body,
    });
  }

  /**
   * Heartbeat — keeps the slot alive against the inactivity sweep.
   * Send roughly every 30 seconds while the page is foregrounded.
   */
  heartbeat(slotToken: string): Promise<{ status: string; queuePosition?: number }> {
    return this.http.request<{ status: string; queuePosition?: number }>(
      '/api/v1/guest/heartbeat',
      { method: 'POST', slotToken },
    );
  }
}
