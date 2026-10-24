/**
 * The retry deadline last handed out in a refusal, per limiter key.
 *
 * The search route records `now + retryAfterSec` whenever it refuses a key as
 * busy or too fast. A later request from that key that arrives before the
 * deadline ignored the wait it was given, so the route charges it.
 *
 * Bounded: an entry is dropped once its deadline passes (on lookup, and in a
 * sweep every `sweepEvery` records), and the oldest-recorded entries are
 * evicted past `maxEntries`. State is per process, like the limiter.
 */

export interface RetryDeadlinesOptions {
  /** Injectable clock for tests. Default Date.now. */
  now?: () => number;
  /** Sweep expired entries after this many records. Default 1000. */
  sweepEvery?: number;
  /** Hard cap on entries; oldest-recorded are evicted first. Default 10000. */
  maxEntries?: number;
}

export class RetryDeadlines {
  private readonly now: () => number;
  private readonly sweepEvery: number;
  private readonly maxEntries: number;
  /** Deadline epoch ms per key, in record order (oldest first). */
  private readonly deadlines = new Map<string, number>();
  private recordsSinceSweep = 0;

  constructor(options: RetryDeadlinesOptions = {}) {
    this.now = options.now ?? Date.now;
    this.sweepEvery = options.sweepEvery ?? 1_000;
    this.maxEntries = options.maxEntries ?? 10_000;
  }

  get size(): number {
    return this.deadlines.size;
  }

  /** Remember that `key` was told to wait until `deadlineEpochMs`. */
  record(key: string, deadlineEpochMs: number): void {
    // Re-insert so Map order stays oldest-recorded first.
    this.deadlines.delete(key);
    this.deadlines.set(key, deadlineEpochMs);
    this.recordsSinceSweep += 1;
    if (this.recordsSinceSweep >= this.sweepEvery) {
      this.recordsSinceSweep = 0;
      this.sweep();
    }
    while (this.deadlines.size > this.maxEntries) {
      const oldest = this.deadlines.keys().next().value;
      if (oldest === undefined) break;
      this.deadlines.delete(oldest);
    }
  }

  /** Ms left until `key`'s deadline; 0 when it has none or it has passed. */
  remainingMs(key: string): number {
    const deadline = this.deadlines.get(key);
    if (deadline === undefined) return 0;
    const remaining = deadline - this.now();
    if (remaining > 0) return remaining;
    this.deadlines.delete(key);
    return 0;
  }

  private sweep(): void {
    const now = this.now();
    for (const [key, deadline] of this.deadlines) {
      if (deadline <= now) this.deadlines.delete(key);
    }
  }
}
