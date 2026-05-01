import type { QueueItem, QueueItemStatus } from '@opendj/core';

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
}

/**
 * Lossy projection from the durable QueueItem to the realtime summary.
 */
export function toQueueItemSummary(item: QueueItem): QueueItemSummary {
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
  };
}
