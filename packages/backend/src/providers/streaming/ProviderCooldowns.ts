/**
 * Per-account streaming-provider rate-limit cooldowns.
 *
 * Spotify rate limits are per app + user token, but the StreamingRouter
 * builds a fresh provider instance for every `getProvider` call — so any
 * backoff kept on a provider (or on one caller, like the NowPlayingPoller)
 * is invisible to every other caller. Observed live: the poller backed off
 * after a 429 while guest requests kept hitting `/me/player/queue`, and a
 * poller restart forgot its backoff and hit Spotify again inside a 15-hour
 * `Retry-After` window.
 *
 * This registry is the single shared source of truth. The router hands each
 * provider a `guardFetch`-wrapped fetch, so:
 *   - any 429 (from any caller) opens a cooldown for `(accountId, providerId)`
 *     lasting the provider's `Retry-After` (default 30s when absent);
 *   - while the cooldown is open, every call for that account fails fast
 *     with `ProviderRateLimitedError` — no request reaches the provider,
 *     so the penalty window is never extended by our own retries.
 *
 * In-memory: a process restart forgets open cooldowns, which costs exactly
 * one rejected call before the provider re-announces its `Retry-After`.
 */

import { OpenDjError } from '@opendj/core';

/** Window used when a 429 arrives without a usable `Retry-After`. */
const DEFAULT_RETRY_AFTER_SEC = 30;

/**
 * Thrown instead of making a provider call while the account is cooling
 * down. Carries `status: 429` + `retryAfterSec` so existing 429 handlers
 * (NowPlayingPoller backoff, route error mapping) treat it exactly like the
 * provider's own 429.
 */
export class ProviderRateLimitedError extends OpenDjError {
  readonly status = 429;
  readonly providerId: string;
  readonly untilEpochMs: number;
  readonly retryAfterSec: number;
  constructor(providerId: string, untilEpochMs: number, nowEpochMs: number) {
    const retryAfterSec = Math.max(1, Math.ceil((untilEpochMs - nowEpochMs) / 1000));
    super(`${providerId} is rate limiting this account; retry in ${retryAfterSec}s.`);
    this.providerId = providerId;
    this.untilEpochMs = untilEpochMs;
    this.retryAfterSec = retryAfterSec;
  }
}

export interface RateLimitedEvent {
  accountId: string;
  providerId: string;
  untilEpochMs: number;
}

export interface ProviderCooldownsOptions {
  /** Injectable clock for tests. Default Date.now. */
  now?: () => number;
}

export class ProviderCooldowns {
  private readonly now: () => number;
  private readonly until = new Map<string, number>();
  private readonly listeners: Array<(event: RateLimitedEvent) => void> = [];

  constructor(options: ProviderCooldownsOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  /** End of the open cooldown for this account, or null when calls are allowed. */
  untilEpochMs(accountId: string, providerId: string): number | null {
    const key = cooldownKey(accountId, providerId);
    const until = this.until.get(key);
    if (until === undefined) return null;
    if (until <= this.now()) {
      this.until.delete(key);
      return null;
    }
    return until;
  }

  /**
   * Open (or extend) a cooldown. Never shortens an existing window — a
   * short `Retry-After` on one endpoint mustn't cut short a long penalty
   * reported by another. Returns the effective window end.
   */
  record(accountId: string, providerId: string, retryAfterSec: number | null): number {
    const seconds =
      retryAfterSec !== null && retryAfterSec > 0 ? retryAfterSec : DEFAULT_RETRY_AFTER_SEC;
    const candidate = this.now() + seconds * 1000;
    const existing = this.untilEpochMs(accountId, providerId);
    if (existing !== null && existing >= candidate) return existing;
    this.until.set(cooldownKey(accountId, providerId), candidate);
    for (const listener of this.listeners) {
      try {
        listener({ accountId, providerId, untilEpochMs: candidate });
      } catch {
        // A broken listener must never break the provider call path.
      }
    }
    return candidate;
  }

  /** Subscribe to cooldowns opening or being extended. */
  onRateLimited(listener: (event: RateLimitedEvent) => void): void {
    this.listeners.push(listener);
  }

  /**
   * Wrap `fetchImpl` so every call for `(accountId, providerId)` respects
   * and feeds the shared cooldown.
   */
  guardFetch(accountId: string, providerId: string, fetchImpl: typeof fetch): typeof fetch {
    return async (input, init) => {
      const until = this.untilEpochMs(accountId, providerId);
      if (until !== null) throw new ProviderRateLimitedError(providerId, until, this.now());
      const response = await fetchImpl(input, init);
      if (response.status === 429) {
        this.record(accountId, providerId, parseRetryAfterSec(response));
      }
      return response;
    };
  }
}

function cooldownKey(accountId: string, providerId: string): string {
  return `${accountId}\u0000${providerId}`;
}

function parseRetryAfterSec(response: Response): number | null {
  const raw = response.headers?.get?.('retry-after');
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
