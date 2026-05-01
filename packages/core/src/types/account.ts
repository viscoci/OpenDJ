/**
 * Account / tenant.
 *
 * A user can belong to multiple accounts via account_memberships. OSS deployments
 * have exactly one account row with `plan: 'oss'`; hosted has many.
 *
 * Schema mirror: see docs/agent-brief.md §"Database schema" → `accounts`.
 */

export type Plan = 'free' | 'paid_monthly' | 'paid_event' | 'oss';

export interface Account {
  id: string;
  displayName: string;
  /** Hosted: /u/<slug>; OSS may ignore. Globally unique. */
  slug: string;
  plan: Plan;
  createdAt: Date;
}

/**
 * `oss` and any paid plan unlock paid-tier features. Free is the only constrained tier.
 */
export function isPaidOrOss(plan: Plan): boolean {
  return plan !== 'free';
}
