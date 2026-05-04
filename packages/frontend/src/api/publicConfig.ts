import type { HttpClient } from './http.js';

/**
 * Public configuration resource — `GET /api/v1/config/public`.
 *
 * Returns boolean flags only — useful for hiding UI affordances that depend
 * on backend env vars (Spotify creds, OAuth login providers). Never returns
 * the underlying client IDs / secrets.
 */

export interface PublicConfig {
  loginProviders: {
    google: boolean;
    apple: boolean;
    facebook: boolean;
  };
  musicProviders: {
    spotify: boolean;
  };
}

export class PublicConfigApi {
  constructor(private readonly http: HttpClient) {}

  get(): Promise<PublicConfig> {
    return this.http.request<PublicConfig>('/api/v1/config/public');
  }
}
