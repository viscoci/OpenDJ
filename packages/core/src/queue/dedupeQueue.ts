import { type QueueItem } from '../types/queue.js';

/**
 * Returns a copy of `items` with duplicate trackUris collapsed to their first
 * non-rejected occurrence. Rejected items are kept in their original positions
 * (they don't shadow live items, and they don't get deduped against each other).
 *
 * Order of input is preserved. Useful both for host displays and as an input
 * to canEnqueue when the host has "block duplicate requests" enabled.
 */
export function dedupeQueue(items: QueueItem[]): QueueItem[] {
  const seen = new Set<string>();
  const result: QueueItem[] = [];
  for (const item of items) {
    if (item.status === 'rejected') {
      result.push(item);
      continue;
    }
    if (seen.has(item.trackUri)) {
      continue;
    }
    seen.add(item.trackUri);
    result.push(item);
  }
  return result;
}
