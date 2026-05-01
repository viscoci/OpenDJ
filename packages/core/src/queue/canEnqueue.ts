import type { Guest } from '../types/guest.js';
import type { QueueItem } from '../types/queue.js';
import type { Session } from '../types/session.js';
import { enforcePerGuestCap } from './enforcePerGuestCap.js';

export type CanEnqueueResult =
  | { ok: true }
  | { ok: false; reason: 'session_ended' | 'guest_session_mismatch' | 'cap_reached' };

/**
 * Decide whether a guest is allowed to enqueue ANOTHER track right now.
 *
 * Checks (in order):
 * 1. Session is still live (not ended).
 * 2. Guest belongs to this session.
 * 3. Guest has not hit the per-guest cap (`session.songsPerGuestCap`).
 *
 * Duplicate-track detection is intentionally NOT here — that's `dedupeQueue`'s
 * job and is conditionally applied based on host settings.
 *
 * Provider availability ("no active device") is also intentionally not here —
 * that's the StreamingRouter's job.
 */
export function canEnqueue(
  session: Session,
  guest: Guest,
  existingItems: QueueItem[],
  now: Date,
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
  return { ok: true };
}
