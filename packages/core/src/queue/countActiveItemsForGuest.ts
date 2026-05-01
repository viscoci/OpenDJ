import { isActiveQueueItem, type QueueItem } from '../types/queue.js';

/**
 * Count queue items belonging to `guestId` whose status still occupies a slot
 * (pending / approved / queued / playing). Rejected items are ignored.
 */
export function countActiveItemsForGuest(items: QueueItem[], guestId: string): number {
  let count = 0;
  for (const item of items) {
    if (item.guestId === guestId && isActiveQueueItem(item)) {
      count += 1;
    }
  }
  return count;
}
