import type { HttpClient } from './http.js';

/**
 * Connected music-provider resource — `/api/v1/provider/connections/*`.
 *
 * `me()` lists the current account's connections (no tokens — just metadata).
 * `startConnectUrl(providerId)` returns the URL the browser should navigate to
 * to start a music-provider OAuth handshake; the backend issues a 302 to the
 * provider's authorize endpoint.
 */

export interface ProviderConnectionWire {
  providerId: string;
  providerAccountId: string | null;
  displayName: string | null;
  connectedByUserId: string | null;
  connectedAt: string;
  updatedAt: string;
}

export class ProviderConnectionsApi {
  constructor(private readonly http: HttpClient) {}

  /** List the current account's connected providers. */
  async me(): Promise<ProviderConnectionWire[]> {
    const res = await this.http.request<{ connections: ProviderConnectionWire[] }>(
      '/api/v1/provider/connections/me',
    );
    return res.connections;
  }

  /**
   * Build the URL the browser must navigate to to start the OAuth flow for a
   * music provider (e.g. Spotify). The backend redirects to the provider's
   * authorize endpoint.
   */
  startConnectUrl(providerId: 'spotify' | string): string {
    return `/api/v1/provider/connections/${encodeURIComponent(providerId)}/start`;
  }
}
