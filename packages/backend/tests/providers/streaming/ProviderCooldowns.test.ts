import { describe, expect, it, vi } from 'vitest';
import {
  ProviderCooldowns,
  ProviderRateLimitedError,
} from '../../../src/providers/streaming/ProviderCooldowns.js';

function response(status: number, headers: Record<string, string> = {}): Response {
  return new Response(status === 204 ? null : '{}', { status, headers });
}

function setup(startMs = 1_000_000) {
  let now = startMs;
  const cooldowns = new ProviderCooldowns({ now: () => now });
  return {
    cooldowns,
    advance(ms: number) {
      now += ms;
    },
    now: () => now,
  };
}

describe('ProviderCooldowns.guardFetch', () => {
  it('passes requests through while the account is not rate limited', async () => {
    const { cooldowns } = setup();
    const inner = vi.fn(async () => response(200));
    const guarded = cooldowns.guardFetch('acct-1', 'spotify', inner);

    const res = await guarded('https://api.spotify.com/v1/me/player');

    expect(res.status).toBe(200);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(cooldowns.untilEpochMs('acct-1', 'spotify')).toBeNull();
  });

  it('opens a cooldown from Retry-After when the provider answers 429', async () => {
    const { cooldowns, now } = setup();
    const guarded = cooldowns.guardFetch('acct-1', 'spotify', async () =>
      response(429, { 'retry-after': '120' }),
    );

    const res = await guarded('https://api.spotify.com/v1/me/player');

    // The 429 response itself still reaches the caller unchanged.
    expect(res.status).toBe(429);
    expect(cooldowns.untilEpochMs('acct-1', 'spotify')).toBe(now() + 120_000);
  });

  it('short-circuits every later call for that account without touching the network', async () => {
    const { cooldowns } = setup();
    const inner = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(response(429, { 'retry-after': '60' }));
    const guarded = cooldowns.guardFetch('acct-1', 'spotify', inner);
    await guarded('https://api.spotify.com/v1/me/player');

    // A second provider instance for the same account (StreamingRouter builds
    // a fresh one per getProvider call) shares the cooldown.
    const second = cooldowns.guardFetch('acct-1', 'spotify', inner);
    const err = await second('https://api.spotify.com/v1/search?q=x').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProviderRateLimitedError);
    expect((err as ProviderRateLimitedError).status).toBe(429);
    expect((err as ProviderRateLimitedError).retryAfterSec).toBe(60);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('does not block other accounts', async () => {
    const { cooldowns } = setup();
    await cooldowns.guardFetch('acct-1', 'spotify', async () =>
      response(429, { 'retry-after': '60' }),
    )('https://api.spotify.com/v1/me/player');

    const inner = vi.fn(async () => response(200));
    const res = await cooldowns.guardFetch('acct-2', 'spotify', inner)('https://x');

    expect(res.status).toBe(200);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('lets calls through again once the window has elapsed', async () => {
    const { cooldowns, advance } = setup();
    await cooldowns.guardFetch('acct-1', 'spotify', async () =>
      response(429, { 'retry-after': '30' }),
    )('https://x');

    advance(30_000);
    const inner = vi.fn(async () => response(200));
    const res = await cooldowns.guardFetch('acct-1', 'spotify', inner)('https://x');

    expect(res.status).toBe(200);
    expect(cooldowns.untilEpochMs('acct-1', 'spotify')).toBeNull();
  });

  it('falls back to a default window when a 429 has no Retry-After header', async () => {
    const { cooldowns, now } = setup();
    await cooldowns.guardFetch('acct-1', 'spotify', async () => response(429))('https://x');

    expect(cooldowns.untilEpochMs('acct-1', 'spotify')).toBe(now() + 30_000);
  });
});

describe('ProviderCooldowns.record', () => {
  it('never shortens an existing window', () => {
    const { cooldowns, now } = setup();
    cooldowns.record('acct-1', 'spotify', 600);
    cooldowns.record('acct-1', 'spotify', 5);

    expect(cooldowns.untilEpochMs('acct-1', 'spotify')).toBe(now() + 600_000);
  });

  it('notifies listeners when a window opens or is extended', () => {
    const { cooldowns, now } = setup();
    const listener = vi.fn();
    cooldowns.onRateLimited(listener);

    cooldowns.record('acct-1', 'spotify', 60);
    cooldowns.record('acct-1', 'spotify', 10); // shorter — no change, no event
    cooldowns.record('acct-1', 'spotify', 120);

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith({
      accountId: 'acct-1',
      providerId: 'spotify',
      untilEpochMs: now() + 120_000,
    });
  });
});
