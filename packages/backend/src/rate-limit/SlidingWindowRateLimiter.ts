/**
 * In-memory sliding-window rate limiter implementing `RateLimitService`.
 *
 * Each `(scope, key)` keeps a log of the timestamps it was allowed at. A call
 * is allowed while fewer than `limit` timestamps fall inside the last
 * `windowMs`; a refused call is not logged, so hammering while refused never
 * extends the wait. A refusal's `retryAfterMs` is the time until the oldest
 * logged call leaves the window.
 *
 * The guest search route uses the synchronous `tryApply` / `peekSync` so its
 * admission step can check and spend several counters with no awaits in
 * between. The async `RateLimitService` methods wrap them.
 *
 * State is per process. That is right for a single-process Node server; on
 * Cloudflare Workers each isolate gets its own counters (and so its own
 * search budget).
 */

import type { RateLimitDecision, RateLimitScope, RateLimitService } from '@opendj/abuse';
import type { SearchPacingConfig } from '../config.js';

export interface RateLimitRule {
  /** Calls allowed per window. Positive integer. */
  limit: number;
  /** Window length in ms. Positive integer. */
  windowMs: number;
}

export interface ScopeRateLimitRule extends RateLimitRule {
  /** Per-key overrides within the scope (e.g. the shared `anon` key). */
  keys?: Record<string, RateLimitRule>;
}

export interface SlidingWindowRateLimiterOptions {
  /** Rules per scope. Applying a scope with no rule throws. */
  scopes: Partial<Record<RateLimitScope, ScopeRateLimitRule>>;
  /** Injectable clock for tests. Default Date.now. */
  now?: () => number;
}

/** Guest search scope. Keys: `searchGuestKey(slotId)` or `SEARCH_ANON_KEY`. */
export const SEARCH_SCOPE = 'search' satisfies RateLimitScope;
/** Spotify-call budget scope. Key: the provider id (one API key per deployment). */
export const SEARCH_BUDGET_SCOPE = 'search_budget' satisfies RateLimitScope;
/** Shared key for searches that carry no valid guest identity. */
export const SEARCH_ANON_KEY = 'anon';

export function searchGuestKey(slotId: string): string {
  return `guest:${slotId}`;
}

/** Drop idle logs after this many operations so churned keys don't accumulate. */
const SWEEP_EVERY_OPS = 1_000;

export class SlidingWindowRateLimiter implements RateLimitService {
  private readonly now: () => number;
  private readonly scopes: Map<string, ScopeRateLimitRule>;
  private readonly maxWindowMs: number;
  /** Allowed-call timestamps, oldest first, per `(scope, key)`. */
  private readonly logs = new Map<string, number[]>();
  private opsSinceSweep = 0;

  constructor(options: SlidingWindowRateLimiterOptions) {
    this.now = options.now ?? Date.now;
    this.scopes = new Map();
    let maxWindowMs = 0;
    for (const [scope, rule] of Object.entries(options.scopes)) {
      if (rule === undefined) continue;
      assertRule(scope, rule);
      maxWindowMs = Math.max(maxWindowMs, rule.windowMs);
      for (const [key, keyRule] of Object.entries(rule.keys ?? {})) {
        assertRule(`${scope}/${key}`, keyRule);
        maxWindowMs = Math.max(maxWindowMs, keyRule.windowMs);
      }
      this.scopes.set(scope, rule);
    }
    this.maxWindowMs = maxWindowMs;
  }

  /** Spend one call if allowed. A refusal changes no state. */
  tryApply(scope: RateLimitScope, key: string): RateLimitDecision {
    const rule = this.ruleFor(scope, key);
    const now = this.now();
    const id = logKey(scope, key);
    const log = this.prune(id, rule, now);
    this.maybeSweep(now);
    if (log.length >= rule.limit) return refusal(rule, log, now);
    log.push(now);
    if (log.length === 1) this.logs.set(id, log);
    return { ok: true, retryAfterMs: 0, remaining: rule.limit - log.length, ...rule };
  }

  /** Current state without spending. `ok` says whether `tryApply` would succeed now. */
  peekSync(scope: RateLimitScope, key: string): RateLimitDecision {
    const rule = this.ruleFor(scope, key);
    const now = this.now();
    const log = this.prune(logKey(scope, key), rule, now);
    if (log.length >= rule.limit) return refusal(rule, log, now);
    return { ok: true, retryAfterMs: 0, remaining: rule.limit - log.length, ...rule };
  }

  resetSync(scope: RateLimitScope, key: string): void {
    this.logs.delete(logKey(scope, key));
  }

  async apply(scope: RateLimitScope, key: string): Promise<RateLimitDecision> {
    return this.tryApply(scope, key);
  }

  async peek(scope: RateLimitScope, key: string): Promise<RateLimitDecision> {
    return this.peekSync(scope, key);
  }

  async reset(scope: RateLimitScope, key: string): Promise<void> {
    this.resetSync(scope, key);
  }

  private ruleFor(scope: RateLimitScope, key: string): RateLimitRule {
    const rule = this.scopes.get(scope);
    if (!rule) throw new Error(`No rate limit configured for scope '${scope}'.`);
    const keyRule = rule.keys?.[key];
    return keyRule
      ? { limit: keyRule.limit, windowMs: keyRule.windowMs }
      : { limit: rule.limit, windowMs: rule.windowMs };
  }

  /**
   * Drop timestamps that have left the window. An entry logged at `t` counts
   * while `now < t + windowMs`. Returns the live log (a fresh empty array,
   * not yet stored, when the key has nothing in the window).
   */
  private prune(id: string, rule: RateLimitRule, now: number): number[] {
    const log = this.logs.get(id);
    if (!log) return [];
    const cutoff = now - rule.windowMs;
    let expired = 0;
    while (expired < log.length && log[expired]! <= cutoff) expired += 1;
    if (expired > 0) log.splice(0, expired);
    if (log.length === 0) {
      this.logs.delete(id);
      return [];
    }
    return log;
  }

  private maybeSweep(now: number): void {
    this.opsSinceSweep += 1;
    if (this.opsSinceSweep < SWEEP_EVERY_OPS) return;
    this.opsSinceSweep = 0;
    // Any log whose newest entry is older than the longest window is empty
    // under every rule, so it is safe to drop without knowing its rule.
    const cutoff = now - this.maxWindowMs;
    for (const [id, log] of this.logs) {
      if (log.length === 0 || log[log.length - 1]! <= cutoff) this.logs.delete(id);
    }
  }
}

/** Build the guest search limiter from pacing config. */
export function createSearchRateLimiter(
  pacing: SearchPacingConfig,
  now?: () => number,
): SlidingWindowRateLimiter {
  return new SlidingWindowRateLimiter({
    ...(now !== undefined && { now }),
    scopes: {
      [SEARCH_SCOPE]: {
        limit: pacing.searchGuestLimit,
        windowMs: pacing.searchWindowMs,
        keys: {
          [SEARCH_ANON_KEY]: { limit: pacing.searchAnonLimit, windowMs: pacing.searchWindowMs },
        },
      },
      [SEARCH_BUDGET_SCOPE]: {
        limit: pacing.searchBudgetLimit,
        windowMs: pacing.searchBudgetWindowMs,
      },
    },
  });
}

function refusal(rule: RateLimitRule, log: number[], now: number): RateLimitDecision {
  const oldest = log[0]!;
  return {
    ok: false,
    // Clamped to (0, windowMs] so a clock that steps backwards can't overstate the wait.
    retryAfterMs: Math.min(rule.windowMs, Math.max(1, oldest + rule.windowMs - now)),
    remaining: 0,
    ...rule,
  };
}

function assertRule(label: string, rule: RateLimitRule): void {
  if (!Number.isInteger(rule.limit) || rule.limit < 1) {
    throw new RangeError(`Rate limit '${label}': limit must be a positive integer.`);
  }
  if (!Number.isInteger(rule.windowMs) || rule.windowMs < 1) {
    throw new RangeError(`Rate limit '${label}': windowMs must be a positive integer.`);
  }
}

function logKey(scope: string, key: string): string {
  return `${scope}\u0000${key}`;
}
