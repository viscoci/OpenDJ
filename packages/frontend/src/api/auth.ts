import type { HttpClient } from './http.js';
import type { LoginRequest, MeResponse, RegisterRequest } from './types.js';

/**
 * Auth resource — `/api/v1/auth/*`.
 *
 * Cookie-based session: register/login set `__Host-opendj_session` via
 * `Set-Cookie`; subsequent requests carry the cookie automatically.
 */
export class AuthApi {
  constructor(private readonly http: HttpClient) {}

  /** Register with email + password. Returns the new user's `me` payload. */
  register(input: RegisterRequest): Promise<MeResponse> {
    return this.http.request<MeResponse>('/api/v1/auth/email/register', {
      method: 'POST',
      body: input,
    });
  }

  /** Log in with email + password. */
  login(input: LoginRequest): Promise<MeResponse> {
    return this.http.request<MeResponse>('/api/v1/auth/email/login', {
      method: 'POST',
      body: input,
    });
  }

  /** Resolve the current user (authenticated). 401 surfaces as `ApiError`. */
  me(): Promise<MeResponse> {
    return this.http.request<MeResponse>('/api/v1/auth/me');
  }

  /** Log the current session out. */
  logout(): Promise<void> {
    return this.http.request<void>('/api/v1/auth/logout', { method: 'POST' });
  }

  /**
   * Switch the active account on the current session. Returns the refreshed
   * `me` payload with new `claims`.
   */
  switchAccount(accountId: string): Promise<MeResponse> {
    return this.http.request<MeResponse>('/api/v1/auth/switch-account', {
      method: 'POST',
      body: { accountId },
    });
  }

  /**
   * Build the redirect URL the browser should follow to start an OAuth login
   * flow. The user's browser must navigate to this URL — the backend issues a
   * 302 to the provider's authorize endpoint.
   */
  oauthStartUrl(providerId: 'google' | 'apple' | 'facebook' | string): string {
    return `/api/v1/auth/oauth/${encodeURIComponent(providerId)}/start`;
  }
}
