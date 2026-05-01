/**
 * Shared public types used across @opendj/core providers, queue, plan,
 * and downstream packages.
 *
 * No runtime imports — types only (with a small handful of pure helpers).
 */

export * from './account.js';
export * from './session.js';
export * from './guest.js';
export * from './queue.js';

/**
 * A track from any streaming provider, identified by its provider-native URI.
 *
 * Example URIs:
 * - Spotify: `spotify:track:3n3Ppam7vgaVa1iaRUc9Lp`
 * - Soundtrack: `soundtrack:track:abcd1234`
 */
export interface Track {
  /** Provider-native URI. Globally unique within (provider, env). */
  uri: string;
  name: string;
  artist: string;
  /** Direct URL to the album art. `null` when the provider has no art. */
  albumArt: string | null;
  durationMs: number;
}

/**
 * A playback zone exposed by a multi-zone provider (e.g. Soundtrack Your Brand).
 *
 * Single-zone providers (e.g. Spotify) may expose a synthetic default zone or
 * mark zone capabilities as unsupported; see ProviderCapabilities.
 */
export interface Zone {
  id: string;
  name: string;
  isDefault: boolean;
}

/**
 * Current playback snapshot for a zone. Returned by ISupportsNowPlayingRead.
 */
export interface NowPlayingTrack extends Track {
  /** Current playback position. Always between 0 and durationMs. */
  progressMs: number;
  isPlaying: boolean;
  zoneId: string;
}

/**
 * Provider-specific credential payload (access tokens, refresh tokens, account IDs, etc.).
 *
 * Stored encrypted in the `provider_connections` table. Never log raw values.
 */
export type ProviderCredentials = Record<string, string>;
