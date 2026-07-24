import type { QueueItem, QueueItemStatus } from '@opendj/core';

/**
 * Broadcast-safe karaoke mic claim attached to a queue item. Carries only
 * what guest/TV views render — the singer's session-scoped guest id and
 * their sanitized display name.
 */
export interface KaraokeClaimSummary {
  guestId: string;
  displayName: string;
}

/**
 * Compact, broadcast-safe queue item shape sent over the realtime channel.
 *
 * Excludes server-only fields (`decidedAt` is included for moderation UIs;
 * fields that would be PII or session-internal should never reach guest clients).
 */
export interface QueueItemSummary {
  id: string;
  guestId: string;
  trackUri: string;
  trackName: string;
  artistName: string;
  albumArtUrl: string | null;
  durationMs: number | null;
  status: QueueItemStatus;
  skipVotes: number;
  createdAtEpochMs: number;
  decidedAtEpochMs: number | null;
  /** Mic claims on this item. Empty when none (never absent). */
  karaokeClaims: KaraokeClaimSummary[];
}

/**
 * Lossy projection from the durable QueueItem to the realtime summary.
 * `karaokeClaims` defaults to empty — callers with claim data attach it.
 */
export function toQueueItemSummary(
  item: QueueItem,
  karaokeClaims: KaraokeClaimSummary[] = [],
): QueueItemSummary {
  return {
    id: item.id,
    guestId: item.guestId,
    trackUri: item.trackUri,
    trackName: item.trackName,
    artistName: item.artistName,
    albumArtUrl: item.albumArtUrl,
    durationMs: item.durationMs,
    status: item.status,
    skipVotes: item.skipVotes,
    createdAtEpochMs: item.createdAt.getTime(),
    decidedAtEpochMs: item.decidedAt?.getTime() ?? null,
    karaokeClaims,
  };
}
