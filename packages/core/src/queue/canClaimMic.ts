import type { KaraokeClaim } from '../types/karaoke.js';
import type { QueueItem } from '../types/queue.js';
import type { Session } from '../types/session.js';

export type CanClaimMicResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'karaoke_off' | 'item_not_claimable' | 'mics_full' | 'already_claimed';
    };

/**
 * Statuses a mic can still be claimed on: the waiting list
 * (pending/approved/queued) plus `playing` — late joiners may grab an open
 * mic while the song is on. `played`/`rejected` items are done.
 */
const CLAIMABLE_STATUSES: ReadonlyArray<QueueItem['status']> = [
  'pending',
  'approved',
  'queued',
  'playing',
];

/**
 * Decide whether `guestId` may claim a mic on `item` right now.
 *
 * Checks (in order):
 * 1. Karaoke is enabled for the session (`karaokeMode !== 'off'`).
 * 2. The item is still claimable (waiting or playing — see above).
 * 3. The guest doesn't already hold a claim on this item.
 * 4. The item's mics aren't full (`< session.karaokeMicCount`).
 *
 * Claims are open to ANY guest in the session (duets), not just the
 * requester. `existingClaims` may contain claims for other items — only
 * claims whose `queueItemId` matches `item.id` count.
 */
export function canClaimMic(
  session: Session,
  item: QueueItem,
  existingClaims: KaraokeClaim[],
  guestId: string,
): CanClaimMicResult {
  if (session.karaokeMode === 'off') {
    return { ok: false, reason: 'karaoke_off' };
  }
  if (!(CLAIMABLE_STATUSES as ReadonlyArray<QueueItem['status']>).includes(item.status)) {
    return { ok: false, reason: 'item_not_claimable' };
  }
  const claimsOnItem = existingClaims.filter((c) => c.queueItemId === item.id);
  // `already_claimed` is checked before `mics_full` so the sole claimant of
  // a full song gets the accurate reason instead of a misleading "full".
  if (claimsOnItem.some((c) => c.guestId === guestId)) {
    return { ok: false, reason: 'already_claimed' };
  }
  if (claimsOnItem.length >= session.karaokeMicCount) {
    return { ok: false, reason: 'mics_full' };
  }
  return { ok: true };
}
