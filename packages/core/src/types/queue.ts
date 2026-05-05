/**
 * Queue item domain type.
 *
 * Schema mirror: see docs/agent-brief.md §"Database schema" → `queue_items`.
 */

/**
 * `played` is a terminal status that the NowPlayingPoller flips approved
 * items into once Spotify's now-playing has moved past them. Like
 * `rejected`, it's NOT included in `ACTIVE_QUEUE_STATUSES` — past tracks
 * don't count against per-guest caps and don't appear in the visible
 * queue.
 */
export type QueueItemStatus = 'pending' | 'approved' | 'queued' | 'playing' | 'played' | 'rejected';

export interface QueueItem {
  id: string;
  sessionId: string;
  guestId: string;
  /** Provider-native track URI, e.g. spotify:track:xxx */
  trackUri: string;
  trackName: string;
  artistName: string;
  albumArtUrl: string | null;
  durationMs: number | null;
  status: QueueItemStatus;
  skipVotes: number;
  createdAt: Date;
  decidedAt: Date | null;
}

/**
 * Statuses where the item still occupies a "slot" against the per-guest cap and
 * counts toward the visible queue. Rejected items do not.
 */
export const ACTIVE_QUEUE_STATUSES: ReadonlyArray<QueueItemStatus> = [
  'pending',
  'approved',
  'queued',
  'playing',
];

export function isActiveQueueItem(item: QueueItem): boolean {
  return (ACTIVE_QUEUE_STATUSES as ReadonlyArray<QueueItemStatus>).includes(item.status);
}
