import { HOSTED_FREE_TIER_GUEST_CAP } from '../constants.js';
import type { Account } from '../types/account.js';
import type { Session } from '../types/session.js';

/**
 * Maximum unique guests for this session, given the account's plan and any
 * per-session override.
 *
 * Resolution order:
 * 1. `session.guestCapOverride` if non-null — paid hosts can cap below the
 *    plan-default for crowd control. OSS deployments can also use this.
 * 2. Plan-default:
 *    - `oss` → Infinity (self-host has no cap)
 *    - `free` → HOSTED_FREE_TIER_GUEST_CAP (12)
 *    - `paid_*` → Infinity
 */
export function effectiveGuestCap(account: Account, session: Session): number {
  if (session.guestCapOverride !== null) {
    return session.guestCapOverride;
  }
  if (account.plan === 'free') {
    return HOSTED_FREE_TIER_GUEST_CAP;
  }
  return Number.POSITIVE_INFINITY;
}
