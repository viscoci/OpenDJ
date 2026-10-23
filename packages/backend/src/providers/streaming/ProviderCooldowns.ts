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
 *   - any 429 (from any caller) opens a cooldown for
 *     `(accountId, providerId, quota group)` lasting the provider's
 *     `Retry-After` (default 30s when absent);
 *   - while the cooldown is open, every call in that group for that account
 *     fails fast with `ProviderRateLimitedError` — no request reaches the
 *     provider, so the penalty window is never extended by our own retries.
 *
 * Quota groups: Spotify development-mode quotas are counted per endpoint
 * group. Observed live: `/v1/search` answered `QUOTA_EXCEEDED` with a 21h
 * `Retry-After` while playback endpoints kept working. So the group is
 * picked from the request URL at call time — `'search'` for `/v1/search`,
 * `'player'` for everything else (player, queue, token refresh) — and a
 * search quota never freezes now-playing polling or queue pushes.
 *
 * Persistence: the in-memory map is the hot path, but it is not the only
 * copy. `createDeps` writes every opened/extended cooldown through to
 * `provider_connections` (`rate_limited_until` for player,
 * `search_rate_limited_until` for search, tagged with the app client id;
 * clamped, fire-and-forget), and `StreamingRouter.getProvider` `seed`s them
 * back from the connection row it already loads. A restart mid-ban
 * therefore never resumes calling the provider before the announced window
 * ends. Expired deadlines are left in the table on purpose: they are
 * harmless and need no cleanup job.
 *
 * Observability: `guardFetch` logs every 429 with the body's `error.reason`
 * (read from a clone) and its `Retry-After`, and counts the calls that reach
 * the provider per (provider, URL path) — logged as one summary line every
 * `callSummaryIntervalMs` whenever anything was called.
 */

import { OpenDjError } from '@opendj/core';

/** Window used when a 429 arrives without a usable `Retry-After`. */
const DEFAULT_RETRY_AFTER_SEC = 30;

/** How often the per-endpoint call summary is logged. */
const DEFAULT_CALL_SUMMARY_INTERVAL_MS = 30_000;

/** Longest 429 body excerpt logged when it carries no JSON `error.reason`. */
const MAX_LOGGED_BODY_CHARS = 200;

/**
 * Provider quota bucket a call counts against. `'search'` is `/v1/search`;
 * `'player'` is every other endpoint, including token refresh.
 */
export type ProviderQuotaGroup = 'search' | 'player';

/** Quota group of a request, from its URL path. */
export function quotaGroupForPath(path: string): ProviderQuotaGroup {
  return path === '/v1/search' || path.startsWith('/v1/search/') ? 'search' : 'player';
}

/**
 * Thrown instead of making a provider call while the account is cooling
 * down. Carries `status: 429` + `retryAfterSec` so existing 429 handlers
 * (NowPlayingPoller backoff, route error mapping) treat it exactly like the
 * provider's own 429.
 */
export class ProviderRateLimitedError extends OpenDjError {
  readonly status = 429;
  readonly providerId: string;
  readonly group: ProviderQuotaGroup;
  readonly untilEpochMs: number;
  readonly retryAfterSec: number;
  constructor(
    providerId: string,
    group: ProviderQuotaGroup,
    untilEpochMs: number,
    nowEpochMs: number,
  ) {
    const retryAfterSec = Math.max(1, Math.ceil((untilEpochMs - nowEpochMs) / 1000));
    super(`${providerId} is rate limiting this account (${group}); retry in ${retryAfterSec}s.`);
    this.providerId = providerId;
    this.group = group;
    this.untilEpochMs = untilEpochMs;
    this.retryAfterSec = retryAfterSec;
  }
}

export interface RateLimitedEvent {
  accountId: string;
  providerId: string;
  group: ProviderQuotaGroup;
  untilEpochMs: number;
}

export interface ProviderCooldownsLogger {
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

export interface ProviderCooldownsOptions {
  /** Injectable clock for tests. Default Date.now. */
  now?: () => number;
  /** Where 429 lines and call summaries go. Default `console`. */
  logger?: ProviderCooldownsLogger;
  /**
   * Interval of the per-endpoint call summary log. The timer starts on the
   * first counted call and is unref'd. `0` disables the timer (counts are
   * still kept; call `flushCallCounts()` yourself). Default 30s.
   */
  callSummaryIntervalMs?: number;
}

export class ProviderCooldowns {
  private readonly now: () => number;
  private readonly until = new Map<string, number>();
  private readonly listeners: Array<(event: RateLimitedEvent) => void> = [];
  private readonly logger: ProviderCooldownsLogger;
  private readonly callSummaryIntervalMs: number;
  private readonly calls = new Map<string, number>();
  private summaryTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: ProviderCooldownsOptions = {}) {
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? console;
    this.callSummaryIntervalMs = options.callSummaryIntervalMs ?? DEFAULT_CALL_SUMMARY_INTERVAL_MS;
  }

  /** End of the open cooldown for this account's group, or null when calls are allowed. */
  untilEpochMs(accountId: string, providerId: string, group: ProviderQuotaGroup): number | null {
    const key = cooldownKey(accountId, providerId, group);
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
  record(
    accountId: string,
    providerId: string,
    group: ProviderQuotaGroup,
    retryAfterSec: number | null,
  ): number {
    const seconds =
      retryAfterSec !== null && retryAfterSec > 0 ? retryAfterSec : DEFAULT_RETRY_AFTER_SEC;
    const candidate = this.now() + seconds * 1000;
    const existing = this.untilEpochMs(accountId, providerId, group);
    if (existing !== null && existing >= candidate) return existing;
    this.until.set(cooldownKey(accountId, providerId, group), candidate);
    for (const listener of this.listeners) {
      try {
        listener({ accountId, providerId, group, untilEpochMs: candidate });
      } catch {
        // A broken listener must never break the provider call path.
      }
    }
    return candidate;
  }

  /**
   * Load a deadline persisted before a restart (`provider_connections`
   * `rate_limited_until` / `search_rate_limited_until`). Keeps the later of the
   * in-memory and stored deadlines, ignores deadlines already past, and does
   * NOT notify `onRateLimited` listeners: the value came from storage, so
   * writing it back or re-announcing it would only be noise.
   */
  seed(
    accountId: string,
    providerId: string,
    group: ProviderQuotaGroup,
    untilEpochMs: number,
  ): void {
    if (!Number.isFinite(untilEpochMs) || untilEpochMs <= this.now()) return;
    const existing = this.untilEpochMs(accountId, providerId, group);
    if (existing !== null && existing >= untilEpochMs) return;
    this.until.set(cooldownKey(accountId, providerId, group), untilEpochMs);
  }

  /** Subscribe to cooldowns opening or being extended. */
  onRateLimited(listener: (event: RateLimitedEvent) => void): void {
    this.listeners.push(listener);
  }

  /**
   * Wrap `fetchImpl` so every call for `(accountId, providerId)` respects
   * and feeds the shared cooldown of the quota group its URL belongs to.
   */
  guardFetch(accountId: string, providerId: string, fetchImpl: typeof fetch): typeof fetch {
    return async (input, init) => {
      const path = requestPath(input);
      const group = quotaGroupForPath(path);
      const until = this.untilEpochMs(accountId, providerId, group);
      if (until !== null) throw new ProviderRateLimitedError(providerId, group, until, this.now());
      this.countCall(providerId, path);
      const response = await fetchImpl(input, init);
      if (response.status === 429) {
        const retryAfterSec = parseRetryAfterSec(response);
        this.record(accountId, providerId, group, retryAfterSec);
        await this.log429(providerId, path, retryAfterSec, response);
      }
      return response;
    };
  }

  /** Calls that reached a provider since the last summary, keyed `"<provider> <path>"`. */
  callCounts(): Record<string, number> {
    return Object.fromEntries(this.calls);
  }

  /** Log the call summary as one line (when non-empty) and reset the counts. */
  flushCallCounts(): void {
    if (this.calls.size === 0) return;
    const parts = [...this.calls.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([key, count]) => `${key}=${count}`);
    this.calls.clear();
    try {
      this.logger.log(
        '[provider-calls]',
        `last ${this.callSummaryIntervalMs}ms:`,
        parts.join(', '),
      );
    } catch {
      // Logging must never break the provider call path.
    }
  }

  /** Stop the summary timer (tests, shutdown). Counting continues. */
  stop(): void {
    if (this.summaryTimer !== null) {
      clearInterval(this.summaryTimer);
      this.summaryTimer = null;
    }
  }

  private countCall(providerId: string, path: string): void {
    const key = `${providerId} ${path}`;
    this.calls.set(key, (this.calls.get(key) ?? 0) + 1);
    if (this.summaryTimer === null && this.callSummaryIntervalMs > 0) {
      const timer = setInterval(() => this.flushCallCounts(), this.callSummaryIntervalMs);
      // Never hold the process (or a test run) open just to log counts.
      (timer as { unref?: () => void }).unref?.();
      this.summaryTimer = timer;
    }
  }

  /**
   * Log a 429 with the provider's `error.reason` (Spotify: e.g.
   * QUOTA_EXCEEDED), read from a clone so the caller still gets an unread
   * body. Never throws.
   */
  private async log429(
    providerId: string,
    path: string,
    retryAfterSec: number | null,
    response: Response,
  ): Promise<void> {
    let reason = '-';
    try {
      reason = extractReason(await response.clone().text());
    } catch {
      // Unreadable or uncloneable body: log what we have.
    }
    try {
      this.logger.warn(
        '[provider-429]',
        providerId,
        path,
        `retry-after=${retryAfterSec ?? '-'}`,
        `reason=${reason}`,
      );
    } catch {
      // Logging must never break the provider call path.
    }
  }
}

function cooldownKey(accountId: string, providerId: string, group: ProviderQuotaGroup): string {
  return `${accountId}\u0000${providerId}\u0000${group}`;
}

/** URL path without query or hash, for per-endpoint counts and logs. */
function requestPath(input: RequestInfo | URL): string {
  try {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return new URL(raw).pathname;
  } catch {
    return '<unknown>';
  }
}

/** `error.reason` from a Spotify-style error body, else a short quoted excerpt. */
function extractReason(text: string): string {
  if (!text) return '-';
  try {
    const parsed = JSON.parse(text) as { error?: { reason?: unknown } } | null;
    const reason = parsed?.error?.reason;
    if (typeof reason === 'string' && reason !== '') return reason;
  } catch {
    // Not JSON: fall through to the excerpt.
  }
  return JSON.stringify(text.slice(0, MAX_LOGGED_BODY_CHARS));
}

function parseRetryAfterSec(response: Response): number | null {
  const raw = response.headers?.get?.('retry-after');
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
