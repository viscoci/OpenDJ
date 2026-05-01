import type { Session } from '../types/session.js';

/**
 * Decide whether a track has accumulated enough skip votes to be skipped,
 * based on the session's voteSkipMode + voteSkipThreshold.
 *
 * - `fixed`: skipVotes >= threshold
 * - `percentage`: (skipVotes / totalActiveGuests) * 100 >= threshold;
 *   returns false if totalActiveGuests is 0 (no guests = no consensus)
 * - `host_approval`: always false; the host approves manually via a different
 *   route. The vote count is still tracked for display.
 */
export function canSkip(session: Session, skipVotes: number, totalActiveGuests: number): boolean {
  if (skipVotes <= 0) return false;
  switch (session.voteSkipMode) {
    case 'fixed':
      return skipVotes >= session.voteSkipThreshold;
    case 'percentage': {
      if (totalActiveGuests <= 0) return false;
      const pct = (skipVotes / totalActiveGuests) * 100;
      return pct >= session.voteSkipThreshold;
    }
    case 'host_approval':
      return false;
  }
}
