import type { KaraokeClaim } from '../types/karaoke.js';
import type { QueueItem } from '../types/queue.js';

export type CanRemoveClaimResult =
  | { ok: true }
  | { ok: false; reason: 'not_claim_owner' | 'item_not_waiting' };

/**
 * Waiting statuses — a guest may back out of a mic while the song hasn't
 * started. Once it's `playing` (or done) the claim is locked in; only the
 * host can remove it then.
 */
const WAITING_STATUSES: ReadonlyArray<QueueItem['status']> = ['pending', 'approved', 'queued'];

/**
 * Decide whether `guestId` may remove `claim` from `item`.
 *
 * Guests may only remove their OWN claim, and only while the item is still
 * waiting (pending/approved/queued). Host removal bypasses this rule
 * entirely — services call it with an explicit host override instead.
 */
export function canRemoveClaim(
  item: QueueItem,
  claim: KaraokeClaim,
  guestId: string,
): CanRemoveClaimResult {
  if (claim.guestId !== guestId) {
    return { ok: false, reason: 'not_claim_owner' };
  }
  if (!(WAITING_STATUSES as ReadonlyArray<QueueItem['status']>).includes(item.status)) {
    return { ok: false, reason: 'item_not_waiting' };
  }
  return { ok: true };
}
