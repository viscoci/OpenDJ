/**
 * Service interfaces for abuse prevention. Concrete implementations live in
 * @opendj/backend (where they have access to Postgres and the realtime room).
 *
 * Downstream consumers may layer additional analytics or dashboards on top;
 * these contracts must stay extension-friendly.
 */

import type { AbuseDecision } from './types/decision.js';
import type { ActionEvent, ActionEventInput } from './types/event.js';
import type { RateLimitDecision, RateLimitScope } from './types/scope.js';
import type { AbuseSubject } from './types/subject.js';

/**
 * Captures normalized abuse / analytics signals. Implementations write to the
 * `action_events` table and may forward summaries to the realtime room or to
 * private hosted analytics.
 */
export interface AbuseSignalService {
  recordActionEvent(input: ActionEventInput): Promise<ActionEvent>;
  /** Cheap fan-out for high-frequency events; implementations may batch. */
  recordActionEvents(inputs: ActionEventInput[]): Promise<ActionEvent[]>;
}

export interface RiskScoringInput {
  kind: ActionEventInput['kind'];
  sessionId?: string;
  accountId?: string;
  subjectHash?: string;
  /** Recent activity window summarized as counts. Implementations supply default windows. */
  recent?: {
    sameSubjectActions: number;
    sameSubjectRejections: number;
    sameSessionActions: number;
  };
}

/**
 * Evaluates a candidate action against rolling-window heuristics and returns
 * an AbuseDecision. Pure function over inputs + the in-memory state held by
 * the realtime room — no I/O during the hot path.
 */
export interface RiskScoringService {
  evaluate(input: RiskScoringInput): Promise<AbuseDecision>;
  /**
   * Read the persisted enforcement state for a subject. Used at session join
   * to restore status from prior visits.
   */
  getSubjectStatus(subjectHash: string): Promise<AbuseSubject | null>;
  /** Persist a new enforcement state (host block/unblock + automatic decisions). */
  updateSubject(subject: AbuseSubject): Promise<void>;
}

export interface RateLimitService {
  /**
   * Increment the counter for `(scope, key)` and return the resulting decision.
   * Implementations choose the algorithm (token bucket, fixed window, sliding
   * window) but must report consistent `limit`/`windowMs` for client-side display.
   */
  apply(scope: RateLimitScope, key: string): Promise<RateLimitDecision>;
  /** Read the current bucket without incrementing. Useful for dashboards. */
  peek(scope: RateLimitScope, key: string): Promise<RateLimitDecision>;
  /** Drop the counter for `(scope, key)` — used by host "unblock" actions. */
  reset(scope: RateLimitScope, key: string): Promise<void>;
}
