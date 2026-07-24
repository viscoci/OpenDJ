import type { Guest } from '../types/guest.js';
import type { QueueItem } from '../types/queue.js';
import type { Session } from '../types/session.js';
import { enforceConsecutiveCap } from './enforceConsecutiveCap.js';
import { enforcePerGuestCap } from './enforcePerGuestCap.js';

export type CanEnqueueResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'session_ended'
        | 'guest_session_mismatch'
        | 'cap_reached'
        | 'consecutive_cap_reached'
        | 'duplicate_request';
    };

/**
 * Decide whether a guest is allowed to enqueue ANOTHER track right now.
 *
 * Checks (in order):
 * 1. Session is still live (not ended).
 * 2. Guest belongs to this session.
 * 3. Guest has not hit the per-guest cap (`session.songsPerGuestCap`).
 * 4. Guest would not exceed the consecutive-songs cap
 *    (`session.maxConsecutivePerGuest`) at the tail of the waiting queue.
 * 5. When `session.allowDuplicates` is false, the track URI is not
 *    already in the active queue.
 *
 * Provider availability ("no active device") is intentionally not here —
 * that's the StreamingRouter's job.
 */
export function canEnqueue(
  session: Session,
  guest: Guest,
  existingItems: QueueItem[],
  now: Date,
  candidateTrackUri?: string,
): CanEnqueueResult {
  if (session.endedAt && session.endedAt.getTime() <= now.getTime()) {
    return { ok: false, reason: 'session_ended' };
  }
  if (guest.sessionId !== session.id) {
    return { ok: false, reason: 'guest_session_mismatch' };
  }
  if (enforcePerGuestCap(existingItems, guest.id, session.songsPerGuestCap)) {
    return { ok: false, reason: 'cap_reached' };
  }
  if (enforceConsecutiveCap(existingItems, guest.id, session.maxConsecutivePerGuest)) {
    return { ok: false, reason: 'consecutive_cap_reached' };
  }
  if (!session.allowDuplicates && candidateTrackUri !== undefined) {
    const isActiveStatus = (s: QueueItem['status']) =>
      s === 'pending' || s === 'approved' || s === 'queued' || s === 'playing';
    if (existingItems.some((i) => i.trackUri === candidateTrackUri && isActiveStatus(i.status))) {
      return { ok: false, reason: 'duplicate_request' };
    }
  }
  return { ok: true };
}
