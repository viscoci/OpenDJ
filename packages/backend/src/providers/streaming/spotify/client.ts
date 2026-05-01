/**
 * Thin Spotify Web API client used by `SpotifyProvider`.
 *
 * Lives separately so the provider class stays focused on the mapping work,
 * and so a future refresh-on-401 retry layer has a clean place to land.
 */

import { InvalidProviderCredentialsError } from '@opendj/core';
import { NoActiveDeviceError, SpotifyApiError } from './errors.js';

const BASE_URL = 'https://api.spotify.com';

interface SpotifyErrorBody {
  error?: { status?: number; message?: string; reason?: string };
}

export interface SpotifyClientOptions {
  accessToken: string;
  fetchImpl: typeof fetch;
  baseUrl?: string;
}

export class SpotifyClient {
  private readonly baseUrl: string;
  constructor(private readonly options: SpotifyClientOptions) {
    this.baseUrl = (options.baseUrl ?? BASE_URL).replace(/\/$/, '');
  }

  /**
   * Issue a request and return the Response (caller decides whether to parse JSON
   * or treat 204 as void). Throws structured errors for known Spotify failure
   * shapes; unknown 5xx surface as `SpotifyApiError`.
   */
  async request(method: string, path: string): Promise<Response> {
    const response = await this.options.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${this.options.accessToken}`,
      },
    });
    if (response.ok || response.status === 204) return response;
    if (response.status === 401) {
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
}

function safeParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
