/**
 * Cross-package constants. Shared by hosted and OSS deployments.
 *
 * See docs/agent-brief.md §"Constants".
 */

/** Maximum unique guests per session on the hosted free tier. */
export const HOSTED_FREE_TIER_GUEST_CAP = 12;

/** Default cap on simultaneously-active queue items per guest. */
export const DEFAULT_SONGS_PER_GUEST_CAP = 3;

/** A guest slot expires when its last_heartbeat is older than this. */
export const SLOT_HEARTBEAT_TIMEOUT_MS = 5 * 60 * 1000;

/** How often the slot expiry sweep runs (OSS) / Durable Object alarm fires (hosted). */
export const SLOT_EXPIRY_SWEEP_INTERVAL_MS = 60 * 1000;

/** Default Spotify OAuth scopes for music-provider connections. */
export const SPOTIFY_SCOPES = ['user-read-playback-state', 'user-modify-playback-state'] as const;

export type SpotifyScope = (typeof SPOTIFY_SCOPES)[number];
