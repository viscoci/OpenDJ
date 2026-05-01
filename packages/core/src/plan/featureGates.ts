import { isPaidOrOss, type Account } from '../types/account.js';

/**
 * Free-tier accounts on the hosted product can still create sessions; the
 * limit is enforced as a per-session guest cap, not at the create-session step.
 *
 * Returns `true` for every plan today. Reserved as a hook for future "your
 * subscription is past-due" / "trial expired" gating without changing call sites.
 */
export function canStartSession(_account: Account): boolean {
  return true;
}

export function canUseCustomDomain(account: Account): boolean {
  return isPaidOrOss(account.plan);
}

export function canDisableBranding(account: Account): boolean {
  return isPaidOrOss(account.plan);
}

export function canUseZones(account: Account): boolean {
  return isPaidOrOss(account.plan);
}

export function canUseAnalytics(account: Account): boolean {
  return isPaidOrOss(account.plan);
}
