import { describe, expect, it } from 'vitest';
import type { RateLimitService } from '@opendj/abuse';
import type { Config } from '../../src/config.js';
import { DEFAULT_SEARCH_PACING } from '../../src/config.js';
import { createDeps } from '../../src/deps.js';
import { createInMemoryRepositories } from '../../src/repositories/in-memory/index.js';
import {
  createSearchRateLimiter,
  SEARCH_ANON_KEY,
  SEARCH_BUDGET_SCOPE,
  SEARCH_SCOPE,
  SlidingWindowRateLimiter,
  searchGuestKey,
} from '../../src/rate-limit/SlidingWindowRateLimiter.js';

function setup(startMs = 1_000_000) {
  let now = startMs;
  const limiter = new SlidingWindowRateLimiter({
    now: () => now,
    scopes: {
      search: { limit: 3, windowMs: 10_000, keys: { anon: { limit: 2, windowMs: 5_000 } } },
      search_budget: { limit: 2, windowMs: 30_000 },
    },
  });
  return {
    limiter,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe('SlidingWindowRateLimiter', () => {
  it('implements the RateLimitService contract', async () => {
    const { limiter } = setup();
    const service: RateLimitService = limiter;
    await expect(service.apply('search', 'guest:a')).resolves.toMatchObject({ ok: true });
    await expect(service.peek('search', 'guest:a')).resolves.toMatchObject({ remaining: 2 });
    await service.reset('search', 'guest:a');
    await expect(service.peek('search', 'guest:a')).resolves.toMatchObject({ remaining: 3 });
  });

  it('allows calls under the limit and decrements remaining', () => {
    const { limiter } = setup();
    expect(limiter.tryApply('search', 'guest:a')).toEqual({
      ok: true,
      retryAfterMs: 0,
      remaining: 2,
      limit: 3,
      windowMs: 10_000,
    });
    expect(limiter.tryApply('search', 'guest:a').remaining).toBe(1);
    expect(limiter.tryApply('search', 'guest:a').remaining).toBe(0);
  });

  it('refuses the call over the limit with retryAfterMs until the oldest entry expires', () => {
    const { limiter, advance } = setup();
    limiter.tryApply('search', 'guest:a'); // t=0
    advance(2_000);
    limiter.tryApply('search', 'guest:a'); // t=2000
    advance(1_000);
    limiter.tryApply('search', 'guest:a'); // t=3000
    advance(500);
    const refused = limiter.tryApply('search', 'guest:a'); // t=3500
    expect(refused).toEqual({
      ok: false,
      retryAfterMs: 6_500,
      remaining: 0,
      limit: 3,
      windowMs: 10_000,
    });
  });

  it('does not count a refused call against the window', () => {
    const { limiter, advance } = setup();
    for (let i = 0; i < 3; i += 1) limiter.tryApply('search', 'guest:a');
    for (let i = 0; i < 5; i += 1) expect(limiter.tryApply('search', 'guest:a').ok).toBe(false);
    advance(10_000);
    expect(limiter.tryApply('search', 'guest:a')).toMatchObject({ ok: true, remaining: 2 });
  });

  it('frees a slot exactly when the oldest entry reaches windowMs of age', () => {
    const { limiter, advance } = setup();
    for (let i = 0; i < 3; i += 1) limiter.tryApply('search', 'guest:a');
    advance(9_999);
    expect(limiter.tryApply('search', 'guest:a')).toMatchObject({ ok: false, retryAfterMs: 1 });
    advance(1);
    // All three were logged at t=0, so all leave the window together.
    expect(limiter.tryApply('search', 'guest:a')).toMatchObject({ ok: true, remaining: 2 });
  });

  it('slides: entries leave the window one at a time', () => {
    const { limiter, advance } = setup();
    limiter.tryApply('search', 'guest:a'); // t=0
    advance(4_000);
    limiter.tryApply('search', 'guest:a'); // t=4000
    limiter.tryApply('search', 'guest:a'); // t=4000
    advance(6_000); // t=10000: first entry out, two remain
    expect(limiter.peekSync('search', 'guest:a')).toMatchObject({ ok: true, remaining: 1 });
    expect(limiter.tryApply('search', 'guest:a')).toMatchObject({ ok: true, remaining: 0 });
    expect(limiter.tryApply('search', 'guest:a')).toMatchObject({
      ok: false,
      retryAfterMs: 4_000,
    });
  });

  it('succeeds again after the window passes', () => {
    const { limiter, advance } = setup();
    for (let i = 0; i < 3; i += 1) limiter.tryApply('search', 'guest:a');
    expect(limiter.tryApply('search', 'guest:a').ok).toBe(false);
    advance(10_000);
    expect(limiter.tryApply('search', 'guest:a')).toMatchObject({ ok: true, remaining: 2 });
  });

  it('never shares counts across keys or scopes, and each uses its own limit', () => {
    const { limiter } = setup();
    for (let i = 0; i < 3; i += 1) limiter.tryApply('search', 'guest:a');
    expect(limiter.tryApply('search', 'guest:a').ok).toBe(false);

    expect(limiter.tryApply('search', 'guest:b')).toMatchObject({ ok: true, remaining: 2 });
    expect(limiter.tryApply('search', 'anon')).toMatchObject({
      ok: true,
      remaining: 1,
      limit: 2,
      windowMs: 5_000,
    });
    expect(limiter.tryApply('search_budget', 'guest:a')).toMatchObject({
      ok: true,
      remaining: 1,
      limit: 2,
      windowMs: 30_000,
    });
    expect(limiter.tryApply('search_budget', 'spotify')).toMatchObject({ ok: true, remaining: 1 });
  });

  it('applies a per-key override with its own window', () => {
    const { limiter, advance } = setup();
    limiter.tryApply('search', 'anon');
    limiter.tryApply('search', 'anon');
    expect(limiter.tryApply('search', 'anon')).toMatchObject({ ok: false, retryAfterMs: 5_000 });
    advance(5_000);
    expect(limiter.tryApply('search', 'anon').ok).toBe(true);
  });

  it('peek reports state without incrementing', () => {
    const { limiter } = setup();
    expect(limiter.peekSync('search', 'guest:a')).toEqual({
      ok: true,
      retryAfterMs: 0,
      remaining: 3,
      limit: 3,
      windowMs: 10_000,
    });
    for (let i = 0; i < 5; i += 1) limiter.peekSync('search', 'guest:a');
    expect(limiter.tryApply('search', 'guest:a').remaining).toBe(2);
    expect(limiter.peekSync('search', 'guest:a').remaining).toBe(2);
  });

  it('peek reports a refusal with the same wait tryApply would give', () => {
    const { limiter, advance } = setup();
    for (let i = 0; i < 3; i += 1) limiter.tryApply('search', 'guest:a');
    advance(1_234);
    const peeked = limiter.peekSync('search', 'guest:a');
    expect(peeked).toEqual({
      ok: false,
      retryAfterMs: 8_766,
      remaining: 0,
      limit: 3,
      windowMs: 10_000,
    });
    expect(limiter.tryApply('search', 'guest:a')).toEqual(peeked);
  });

  it('peek followed by tryApply in one synchronous step agree', () => {
    const { limiter } = setup();
    limiter.tryApply('search', 'guest:a');
    const before = limiter.peekSync('search', 'guest:a');
    const applied = limiter.tryApply('search', 'guest:a');
    expect(before.ok).toBe(true);
    expect(applied.ok).toBe(true);
    expect(applied.remaining).toBe(before.remaining - 1);
  });

  it('reset drops only that key', async () => {
    const { limiter } = setup();
    for (let i = 0; i < 3; i += 1) limiter.tryApply('search', 'guest:a');
    limiter.tryApply('search', 'guest:b');
    await limiter.reset('search', 'guest:a');
    expect(limiter.peekSync('search', 'guest:a').remaining).toBe(3);
    expect(limiter.peekSync('search', 'guest:b').remaining).toBe(2);
  });

  it('throws on a scope with no configured limit', async () => {
    const { limiter } = setup();
    expect(() => limiter.tryApply('skip_vote', 'x')).toThrow(/skip_vote/);
    expect(() => limiter.peekSync('skip_vote', 'x')).toThrow(/skip_vote/);
    await expect(limiter.apply('skip_vote', 'x')).rejects.toThrow(/skip_vote/);
  });

  it.each([
    ['zero limit', { limit: 0, windowMs: 1_000 }],
    ['negative limit', { limit: -1, windowMs: 1_000 }],
    ['fractional limit', { limit: 1.5, windowMs: 1_000 }],
    ['zero window', { limit: 1, windowMs: 0 }],
    ['NaN window', { limit: 1, windowMs: Number.NaN }],
  ])('rejects a non-positive rule (%s)', (_label, rule) => {
    expect(() => new SlidingWindowRateLimiter({ scopes: { search: rule } })).toThrow(RangeError);
    expect(
      () =>
        new SlidingWindowRateLimiter({
          scopes: { search: { limit: 1, windowMs: 1_000, keys: { anon: rule } } },
        }),
    ).toThrow(RangeError);
  });

  it('defaults to Date.now when no clock is injected', () => {
    const limiter = new SlidingWindowRateLimiter({
      scopes: { search: { limit: 1, windowMs: 60_000 } },
    });
    expect(limiter.tryApply('search', 'k').ok).toBe(true);
    const refused = limiter.tryApply('search', 'k');
    expect(refused.ok).toBe(false);
    expect(refused.retryAfterMs).toBeGreaterThan(0);
    expect(refused.retryAfterMs).toBeLessThanOrEqual(60_000);
  });
});

describe('createSearchRateLimiter', () => {
  it('wires guest, anonymous and budget limits from pacing config', () => {
    let now = 0;
    const limiter = createSearchRateLimiter(
      {
        ...DEFAULT_SEARCH_PACING,
        searchBudgetLimit: 2,
        searchBudgetWindowMs: 20_000,
        searchGuestLimit: 4,
        searchAnonLimit: 1,
        searchWindowMs: 15_000,
      },
      () => now,
    );
    expect(limiter.peekSync(SEARCH_BUDGET_SCOPE, 'spotify')).toMatchObject({
      limit: 2,
      windowMs: 20_000,
    });
    expect(limiter.peekSync(SEARCH_SCOPE, searchGuestKey('slot-1'))).toMatchObject({
      limit: 4,
      windowMs: 15_000,
    });
    expect(limiter.peekSync(SEARCH_SCOPE, SEARCH_ANON_KEY)).toMatchObject({
      limit: 1,
      windowMs: 15_000,
    });
    expect(searchGuestKey('slot-1')).toBe('guest:slot-1');
    expect(SEARCH_ANON_KEY).toBe('anon');
    limiter.tryApply(SEARCH_SCOPE, SEARCH_ANON_KEY);
    now += 15_000;
    expect(limiter.tryApply(SEARCH_SCOPE, SEARCH_ANON_KEY).ok).toBe(true);
  });
});

function fixtureConfig(): Config {
  return {
    databaseUrl: 'postgres://localhost/test',
    baseUrl: 'http://localhost:8888',
    loginProviders: {},
    postLoginPath: '/',
    postProviderCallbackPath: '/host/dashboard',
    maxSongsPerGuest: 3,
    maxGuestsPerSession: null,
    moderationEnabledDefault: false,
  };
}

describe('createDeps search limiter', () => {
  it('builds one limiter with default pacing when config omits the search fields', () => {
    const deps = createDeps({
      config: fixtureConfig(),
      repositories: createInMemoryRepositories(),
      realtime: 'none',
    });
    expect(deps.searchPacing).toEqual(DEFAULT_SEARCH_PACING);
    expect(deps.searchRateLimiter.peekSync('search_budget', 'spotify')).toMatchObject({
      limit: 3,
      windowMs: 30_000,
    });
    expect(deps.searchRateLimiter.peekSync('search', 'guest:x')).toMatchObject({ limit: 5 });
    expect(deps.searchRateLimiter.peekSync('search', 'anon')).toMatchObject({ limit: 5 });
  });

  it('uses configured pacing values', () => {
    const deps = createDeps({
      config: { ...fixtureConfig(), searchBudgetLimit: 7, searchAnonLimit: 2 },
      repositories: createInMemoryRepositories(),
      realtime: 'none',
    });
    expect(deps.searchPacing.searchBudgetLimit).toBe(7);
    expect(deps.searchRateLimiter.peekSync('search_budget', 'spotify').limit).toBe(7);
    expect(deps.searchRateLimiter.peekSync('search', 'anon').limit).toBe(2);
  });

  it('accepts an injected limiter (fake clock in tests)', () => {
    let now = 0;
    const injected = createSearchRateLimiter(DEFAULT_SEARCH_PACING, () => now);
    const deps = createDeps({
      config: fixtureConfig(),
      repositories: createInMemoryRepositories(),
      realtime: 'none',
      searchRateLimiter: injected,
    });
    expect(deps.searchRateLimiter).toBe(injected);
    for (let i = 0; i < 3; i += 1) deps.searchRateLimiter.tryApply('search_budget', 'spotify');
    expect(deps.searchRateLimiter.tryApply('search_budget', 'spotify').ok).toBe(false);
    now += 30_000;
    expect(deps.searchRateLimiter.tryApply('search_budget', 'spotify').ok).toBe(true);
  });
});
