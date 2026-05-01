import type { QueueItem } from '../types/queue.js';
import { countActiveItemsForGuest } from './countActiveItemsForGuest.js';

/**
 * Returns `true` when the guest is AT OR OVER the cap (i.e. enqueueing another
 * item should be blocked). Returns `false` when the guest still has room.
 *
 * Naming follows brief: "enforce" means "would this enforcement reject a new
 * request?". Callers typically use it as a gate:
 *
 * ```ts
 * if (enforcePerGuestCap(items, guest.id, session.songsPerGuestCap)) {
 *   throw new CapReachedError();
 * }
 * ```
 */
export function enforcePerGuestCap(items: QueueItem[], guestId: string, cap: number): boolean {
  if (cap <= 0) return true;
  return countActiveItemsForGuest(items, guestId) >= cap;
}
