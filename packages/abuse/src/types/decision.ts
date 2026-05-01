/**
 * Abuse decisions returned by RiskScoringService.evaluate(...).
 *
 * - `allow`: request proceeds normally and is persisted.
 * - `throttle`: request is rejected; client should retry after `retryAfterMs`.
 * - `shadow_limit`: request appears to succeed from the user's perspective but
 *   is NOT persisted (used to limit known-bad actors without tipping them off).
 * - `require_host_review`: request is held for the host to approve/reject;
 *   client sees "submitted for review".
 * - `block`: request is hard-rejected with a reason.
 *
 * See docs/agent-brief.md §"Abuse prevention and backend analytics" → "Enforcement modes".
 */
export type AbuseDecision =
  | { action: 'allow' }
  | { action: 'throttle'; retryAfterMs: number; reason: string }
  | { action: 'shadow_limit'; reason: string }
  | { action: 'require_host_review'; reason: string }
  | { action: 'block'; reason: string };

export type AbuseAction = AbuseDecision['action'];

/**
 * Strictness ordering used when merging decisions from multiple signals.
 * Higher = stricter. `block` always wins.
 */
const SEVERITY: Record<AbuseAction, number> = {
  allow: 0,
  shadow_limit: 1,
  throttle: 2,
  require_host_review: 3,
  block: 4,
};

/** True when the user receives an immediate rejection (throttle/review/block). */
export function isUserVisibleRejection(decision: AbuseDecision): boolean {
  return (
    decision.action === 'throttle' ||
    decision.action === 'require_host_review' ||
    decision.action === 'block'
  );
}

/** True when the request is allowed to commit durable state. Allow only. */
export function isPersisted(decision: AbuseDecision): boolean {
  return decision.action === 'allow';
}

/** True when the user perceives success even if the action wasn't persisted. */
export function appearsSuccessful(decision: AbuseDecision): boolean {
  return decision.action === 'allow' || decision.action === 'shadow_limit';
}

/**
 * Pick the strictest of two decisions. Use to fold per-signal decisions into a
 * single final decision before responding.
 *
 * On ties (same action), the LEFT decision wins — this lets callers prioritize
 * earlier-evaluated signals (typically the cheaper / more authoritative ones).
 */
export function mergeDecisions(a: AbuseDecision, b: AbuseDecision): AbuseDecision {
  return SEVERITY[b.action] > SEVERITY[a.action] ? b : a;
}

/**
 * Fold an array of decisions into a single strictest decision. Returns
 * `{ action: 'allow' }` for an empty array.
 */
export function strictestDecision(decisions: AbuseDecision[]): AbuseDecision {
  let result: AbuseDecision = { action: 'allow' };
  for (const decision of decisions) {
    result = mergeDecisions(result, decision);
  }
  return result;
}

/** Narrow to a specific decision variant. */
export function isDecisionOfAction<T extends AbuseAction>(
  decision: AbuseDecision,
  action: T,
): decision is Extract<AbuseDecision, { action: T }> {
  return decision.action === action;
}
