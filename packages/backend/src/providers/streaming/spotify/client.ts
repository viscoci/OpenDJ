/**
 * Thin Spotify Web API client used by `SpotifyProvider`.
 *
 * Owns the request lifecycle, structured error mapping, AND the access-token
 * refresh dance — when a request comes back 401 and refresh credentials are
 * available, the client trades the refresh token for a fresh access token
 * and replays the original request once. The persistence callback lets the
 * caller (StreamingRouter) write the new token back to provider_connections
 * so the next process restart doesn't lose it.
 */

import { InvalidProviderCredentialsError } from '@opendj/core';
import { NoActiveDeviceError, SpotifyApiError } from './errors.js';

const BASE_URL = 'https://api.spotify.com';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';

interface SpotifyErrorBody {
  error?: { status?: number; message?: string; reason?: string };
}

interface SpotifyTokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

export interface RefreshedTokens {
  accessToken: string;
  /**
   * Spotify *may* rotate the refresh token. When present, callers should
   * persist this too so future refreshes use the latest one.
   */
  refreshToken?: string;
  expiresAt?: Date;
  tokenType?: string;
}

export interface SpotifyClientOptions {
  accessToken: string;
  fetchImpl: typeof fetch;
  baseUrl?: string;
  /** Stored refresh token. Required for the refresh-on-401 flow. */
  refreshToken?: string;
  /** App-level Spotify client ID. Required for refresh. */
  clientId?: string;
  /** App-level Spotify client secret. Required for refresh. */
  clientSecret?: string;
  /**
   * Called whenever the client successfully exchanges a refresh token for
   * a fresh access token. Caller is expected to persist the new token to
   * provider_connections (or wherever the original token came from).
   */
  onTokenRefreshed?: (tokens: RefreshedTokens) => void | Promise<void>;
}

export class SpotifyClient {
  private readonly baseUrl: string;
  private accessToken: string;
  private refreshToken: string | undefined;
  /** When true a refresh attempt is in flight; serializes concurrent 401s. */
  private refreshInFlight: Promise<boolean> | null = null;

  constructor(private readonly options: SpotifyClientOptions) {
    this.baseUrl = (options.baseUrl ?? BASE_URL).replace(/\/$/, '');
    this.accessToken = options.accessToken;
    this.refreshToken = options.refreshToken;
  }

  /**
   * Issue a request and return the Response (caller decides whether to parse JSON
   * or treat 204 as void). Throws structured errors for known Spotify failure
   * shapes; unknown 5xx surface as `SpotifyApiError`.
   *
   * `body` (optional) is JSON-serialized and sent with `content-type:
   * application/json`. Spotify accepts JSON bodies on PUT/POST endpoints
   * like `/v1/me/player` (transfer playback).
   *
   * On 401 with refresh credentials available, the client refreshes the
   * access token and retries the request exactly once. `_isRetry` is the
   * recursion guard.
   */
  async request(
    method: string,
    path: string,
    opts: { body?: unknown } = {},
    _isRetry = false,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: `Bearer ${this.accessToken}`,
    };
    const init: RequestInit = { method, headers };
    if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    const response = await this.options.fetchImpl(`${this.baseUrl}${path}`, init);
    if (response.ok || response.status === 204) return response;

    if (response.status === 401) {
      if (!_isRetry && this.canRefresh()) {
        const refreshed = await this.refreshAccessToken();
        if (refreshed) {
          return this.request(method, path, opts, true);
        }
      }
      throw new InvalidProviderCredentialsError(
        'spotify',
        'Spotify rejected the access token (401).',
      );
    }
    const text = await response.text();
    if (response.status === 404) {
      const body = safeParse<SpotifyErrorBody>(text);
      if (body?.error?.reason === 'NO_ACTIVE_DEVICE') {
        throw new NoActiveDeviceError();
      }
    }
    throw new SpotifyApiError(response.status, text);
  }

  private canRefresh(): boolean {
    return Boolean(this.refreshToken && this.options.clientId && this.options.clientSecret);
  }

  /**
   * Trade the stored refresh token for a fresh access token. Returns true on
   * success. Concurrent callers share a single in-flight refresh so we don't
   * burn through Spotify's rate limit.
   */
  private async refreshAccessToken(): Promise<boolean> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = (async () => {
      try {
        const auth = base64Encode(`${this.options.clientId}:${this.options.clientSecret}`);
        const body = new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: this.refreshToken!,
        });
        const res = await this.options.fetchImpl(TOKEN_URL, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            authorization: `Basic ${auth}`,
            accept: 'application/json',
          },
          body: body.toString(),
        });
        if (!res.ok) return false;
        const json = (await res.json()) as SpotifyTokenResponse;
        if (!json.access_token) return false;

        this.accessToken = json.access_token;
        if (json.refresh_token) this.refreshToken = json.refresh_token;

        if (this.options.onTokenRefreshed) {
          const refreshed: RefreshedTokens = {
            accessToken: json.access_token,
          };
          if (json.refresh_token) refreshed.refreshToken = json.refresh_token;
          if (json.token_type) refreshed.tokenType = json.token_type;
          if (json.expires_in) {
            refreshed.expiresAt = new Date(Date.now() + json.expires_in * 1000);
          }
          await this.options.onTokenRefreshed(refreshed);
        }
        return true;
      } catch {
        return false;
      } finally {
        // Allow future refreshes after this one settles, regardless of
        // outcome.
        this.refreshInFlight = null;
      }
    })();
    return this.refreshInFlight;
  }
}

function safeParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * Base64-encode a UTF-8 string. Works in Node + Workers + browsers without
 * pulling in `Buffer`.
 */
function base64Encode(value: string): string {
  if (typeof btoa === 'function') return btoa(value);
  // Node fallback (when `btoa` is missing on older runtimes).
  const bufferCtor = (
    globalThis as { Buffer?: { from(s: string, e: string): { toString(e: string): string } } }
  ).Buffer;
  if (!bufferCtor) throw new Error('No btoa or Buffer available for base64 encoding');
  return bufferCtor.from(value, 'utf8').toString('base64');
}
