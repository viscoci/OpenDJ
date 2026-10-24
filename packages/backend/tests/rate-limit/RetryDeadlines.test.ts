import { describe, expect, it } from 'vitest';
import { RetryDeadlines } from '../../src/rate-limit/RetryDeadlines.js';

describe('RetryDeadlines', () => {
  it('reports the time left only before the recorded deadline', () => {
    let now = 1_000;
    const deadlines = new RetryDeadlines({ now: () => now });
    deadlines.record('guest:a', 5_000);

    expect(deadlines.remainingMs('guest:a')).toBe(4_000);
    expect(deadlines.remainingMs('guest:b')).toBe(0);
    now = 4_999;
    expect(deadlines.remainingMs('guest:a')).toBe(1);
    now = 5_000;
    expect(deadlines.remainingMs('guest:a')).toBe(0);
  });

  it("replaces a key's deadline when a new one is recorded", () => {
    const deadlines = new RetryDeadlines({ now: () => 0 });
    deadlines.record('anon', 10_000);
    deadlines.record('anon', 2_000);
    expect(deadlines.remainingMs('anon')).toBe(2_000);
    expect(deadlines.size).toBe(1);
  });

  it('drops an expired entry when it is looked up', () => {
    let now = 0;
    const deadlines = new RetryDeadlines({ now: () => now });
    deadlines.record('guest:a', 1_000);
    now = 1_000;
    expect(deadlines.remainingMs('guest:a')).toBe(0);
    expect(deadlines.size).toBe(0);
  });

  it('prunes expired entries for other keys as new deadlines are recorded', () => {
    let now = 0;
    const deadlines = new RetryDeadlines({ now: () => now, sweepEvery: 10 });
    for (let i = 0; i < 50; i += 1) deadlines.record(`guest:${i}`, now + 1_000);
    now = 2_000;
    for (let i = 0; i < 10; i += 1) deadlines.record(`guest:new${i}`, now + 1_000);

    expect(deadlines.size).toBe(10);
  });

  it('never holds more than maxEntries, evicting the oldest-recorded first', () => {
    const deadlines = new RetryDeadlines({ now: () => 0, maxEntries: 3 });
    for (let i = 0; i < 5; i += 1) deadlines.record(`guest:${i}`, 10_000);

    expect(deadlines.size).toBe(3);
    expect(deadlines.remainingMs('guest:0')).toBe(0);
    expect(deadlines.remainingMs('guest:4')).toBe(10_000);
  });
});
