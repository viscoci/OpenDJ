/**
 * Set-Cookie helpers for the OpenDJ session cookie.
 *
 * The `__Host-` prefix mandates:
 * - `Path=/`
 * - `Secure`
 * - No `Domain` attribute
 *
 * `SameSite=Lax` is the right balance for the same-origin reference deploy
 * (app + API on one host). Multi-subdomain deploys (e.g. `app.<root>` +
 * `api.<root>`) need `SameSite=None`; downstream callers can override the
 * helper at their entry point.
 *
 * `HttpOnly` keeps the token out of JavaScript.
 */

import { SESSION_COOKIE_NAME } from './AuthService.js';

export interface SessionCookieOptions {
  /** Cookie value: opaque session token from `AuthService.issueSession`. */
  value: string;
  /** Wall-clock expiry. Drives the `Expires` attribute. */
  expiresAt: Date;
  /** SameSite policy. Default `Lax`. */
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export function buildSessionCookie(options: SessionCookieOptions): string {
  const sameSite = options.sameSite ?? 'Lax';
  const parts = [
    `${SESSION_COOKIE_NAME}=${options.value}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    `SameSite=${sameSite}`,
    `Expires=${options.expiresAt.toUTCString()}`,
  ];
  return parts.join('; ');
}

/**
 * Build a Set-Cookie header value that clears the session cookie. Use on
 * `POST /api/v1/auth/logout` and on session-revocation paths.
 */
export function clearSessionCookie(sameSite: 'Strict' | 'Lax' | 'None' = 'Lax'): string {
  return [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'Secure',
    `SameSite=${sameSite}`,
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ].join('; ');
}
