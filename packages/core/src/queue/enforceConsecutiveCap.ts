import type { QueueItem } from '../types/queue.js';

/**
 * Statuses that make up the "waiting list" a new request would land at the
 * tail of. Narrower than `ACTIVE_QUEUE_STATUSES` — `playing` is excluded
 * because a track that's currently playing is no longer waiting.
 */
const WAITING_STATUSES: ReadonlyArray<QueueItem['status']> = ['pending', 'approved', 'queued'];

function isWaitingItem(item: QueueItem): boolean {
  return (WAITING_STATUSES as ReadonlyArray<QueueItem['status']>).includes(item.status);
}

function compareByRequestOrder(a: QueueItem, b: QueueItem): number {
  const byTime = a.createdAt.getTime() - b.createdAt.getTime();
  if (byTime !== 0) return byTime;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Returns `true` when enqueueing another item for `guestId` would exceed
 * `maxConsecutivePerGuest` — i.e. the LAST `cap` items of the waiting list
 * (pending/approved/queued, ordered by request time ascending, id ascending
 * tiebreak) exist and ALL belong to `guestId`.
 *
 * `cap === null` means unlimited (off) — never rejects.
 */
export function enforceConsecutiveCap(
  items: QueueItem[],
  guestId: string,
  cap: number | null,
): boolean {
  if (cap === null) return false;

  const waiting = items.filter(isWaitingItem).sort(compareByRequestOrder);
  if (waiting.length < cap) return false;

  const tail = waiting.slice(waiting.length - cap);
  return tail.every((item) => item.guestId === guestId);
}
