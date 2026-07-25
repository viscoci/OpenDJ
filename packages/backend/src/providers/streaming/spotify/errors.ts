import { OpenDjError } from '@opendj/core';

/**
 * Spotify reports "no active device" as a 404 with `error.reason='NO_ACTIVE_DEVICE'`
 * on playback-control endpoints. This is a routine condition (host's player
 * went idle), not a fatal error — UI should prompt the host to start playback
 * on a device, not log an exception.
 *
 * Brief §"Music provider OAuth flow":
 *   "If host has no active Spotify playback device, return
 *    `{ error: 'no_active_device' }` with a 400 — never silently accept a
 *    queue request that can't play."
 */
export class NoActiveDeviceError extends OpenDjError {
  constructor() {
    super('Spotify has no active device. Host must start playback on a device first.');
  }
}

/**
 * Generic Spotify Web API failure. Carries HTTP status and the response body
 * text so route handlers can surface meaningful errors.
 *
 * `retryAfterSec` is set on 429 responses when Spotify sent a `Retry-After`
 * header. Extended rate-limit penalties report values in the tens of minutes
 * — callers that poll MUST honor it instead of retrying on their own
 * schedule, or the penalty window keeps sliding.
 */
export class SpotifyApiError extends OpenDjError {
  readonly status: number;
  readonly responseBody: string;
  readonly retryAfterSec: number | null;
  constructor(status: number, responseBody: string, retryAfterSec: number | null = null) {
    super(`Spotify Web API returned ${status}: ${responseBody}`);
    this.status = status;
    this.responseBody = responseBody;
    this.retryAfterSec = retryAfterSec;
  }
}
