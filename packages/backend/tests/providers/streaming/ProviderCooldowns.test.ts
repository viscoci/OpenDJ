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

describe('ProviderCooldowns.seed', () => {
  it('opens a cooldown from a persisted deadline that is still in the future', async () => {
    const { cooldowns, now } = setup();
    const until = now() + 110 * 60_000;

    cooldowns.seed('acct-1', 'spotify', until);

    expect(cooldowns.untilEpochMs('acct-1', 'spotify')).toBe(until);
    const inner = vi.fn(async () => response(200));
    const err = await cooldowns
      .guardFetch(
        'acct-1',
        'spotify',
        inner,
      )('https://api.spotify.com/v1/me/player')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderRateLimitedError);
    expect(inner).not.toHaveBeenCalled();
  });

  it('ignores a deadline that has already passed', () => {
    const { cooldowns, now } = setup();

    cooldowns.seed('acct-1', 'spotify', now() - 1);
    cooldowns.seed('acct-1', 'spotify', now());

    expect(cooldowns.untilEpochMs('acct-1', 'spotify')).toBeNull();
  });

  it('never shortens an in-memory deadline recorded earlier', () => {
    const { cooldowns, now } = setup();
    const recorded = cooldowns.record('acct-1', 'spotify', 600);

    cooldowns.seed('acct-1', 'spotify', now() + 60_000);

    expect(cooldowns.untilEpochMs('acct-1', 'spotify')).toBe(recorded);
  });

  it('extends a shorter in-memory deadline', () => {
    const { cooldowns, now } = setup();
    cooldowns.record('acct-1', 'spotify', 60);

    cooldowns.seed('acct-1', 'spotify', now() + 600_000);

    expect(cooldowns.untilEpochMs('acct-1', 'spotify')).toBe(now() + 600_000);
  });

  it('does not notify onRateLimited listeners', () => {
    const { cooldowns, now } = setup();
    const listener = vi.fn();
    cooldowns.onRateLimited(listener);

    cooldowns.seed('acct-1', 'spotify', now() + 600_000);

    expect(listener).not.toHaveBeenCalled();
  });

  it('ignores non-finite deadlines', () => {
    const { cooldowns } = setup();

    cooldowns.seed('acct-1', 'spotify', Number.NaN);

    expect(cooldowns.untilEpochMs('acct-1', 'spotify')).toBeNull();
  });
});

type FakeLogger = { log: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };

function logSetup() {
  const logger: FakeLogger = { log: vi.fn(), warn: vi.fn() };
  const now = 1_000_000;
  const cooldowns = new ProviderCooldowns({ now: () => now, logger, callSummaryIntervalMs: 0 });
  return { cooldowns, logger, now: () => now };
}

function allLogText(logger: FakeLogger): string {
  return [...logger.log.mock.calls, ...logger.warn.mock.calls]
    .map((args) => args.map(String).join(' '))
    .join('\n');
}

describe('ProviderCooldowns.guardFetch 429 logging', () => {
  it('logs the 429 reason, path and Retry-After, and still opens the cooldown', async () => {
    const { cooldowns, logger, now } = logSetup();
    const inner = vi.fn(
      async () =>
        new Response('{"error":{"status":429,"reason":"QUOTA_EXCEEDED"}}', {
          status: 429,
          headers: { 'retry-after': '120' },
        }),
    );

    await cooldowns.guardFetch(
      'acct-1',
      'spotify',
      inner,
    )('https://api.spotify.com/v1/search?q=abc&type=track');

    const text = allLogText(logger);
    expect(text).toContain('reason=QUOTA_EXCEEDED');
    expect(text).toContain('spotify');
    expect(text).toContain('/v1/search');
    expect(text).not.toContain('q=abc');
    expect(text).toContain('retry-after=120');
    expect(cooldowns.untilEpochMs('acct-1', 'spotify')).toBe(now() + 120_000);
  });

  it('logs without throwing when the 429 has no body', async () => {
    const { cooldowns, logger } = logSetup();
    const guarded = cooldowns.guardFetch(
      'acct-1',
      'spotify',
      async () => new Response(null, { status: 429 }),
    );

    const res = await guarded('https://api.spotify.com/v1/me/player');

    expect(res.status).toBe(429);
    expect(allLogText(logger)).toContain('/v1/me/player');
    expect(cooldowns.untilEpochMs('acct-1', 'spotify')).not.toBeNull();
  });

  it('logs without throwing when the 429 body is not JSON', async () => {
    const { cooldowns, logger } = logSetup();
    const guarded = cooldowns.guardFetch(
      'acct-1',
      'spotify',
      async () => new Response('<html>Too Many Requests</html>', { status: 429 }),
    );

    const res = await guarded('https://api.spotify.com/v1/me/player');

    expect(res.status).toBe(429);
    expect(allLogText(logger)).toContain('/v1/me/player');
  });

  it('logs without throwing when the response cannot be cloned', async () => {
    const { cooldowns, logger } = logSetup();
    const fake = {
      status: 429,
      headers: new Headers({ 'retry-after': '5' }),
      clone() {
        throw new Error('body already used');
      },
    } as unknown as Response;
    const guarded = cooldowns.guardFetch('acct-1', 'spotify', async () => fake);

    const res = await guarded('https://api.spotify.com/v1/me/player');

    expect(res).toBe(fake);
    expect(allLogText(logger)).toContain('/v1/me/player');
  });

  it('leaves the original body readable by the caller', async () => {
    const { cooldowns } = logSetup();
    const body = '{"error":{"status":429,"reason":"QUOTA_EXCEEDED"}}';
    const guarded = cooldowns.guardFetch(
      'acct-1',
      'spotify',
      async () => new Response(body, { status: 429, headers: { 'retry-after': '10' } }),
    );

    const res = await guarded('https://api.spotify.com/v1/search?q=a');

    expect(res.bodyUsed).toBe(false);
    expect(await res.text()).toBe(body);
  });

  it('does not log non-429 responses', async () => {
    const { cooldowns, logger } = logSetup();
    const guarded = cooldowns.guardFetch(
      'acct-1',
      'spotify',
      async () => new Response('{"ok":true}', { status: 200 }),
    );

    const res = await guarded('https://api.spotify.com/v1/me/player');

    expect(logger.warn).not.toHaveBeenCalled();
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe('ProviderCooldowns per-endpoint call counts', () => {
  it('counts calls per provider and URL path, ignoring the query string', async () => {
    const { cooldowns } = logSetup();
    const guarded = cooldowns.guardFetch('acct-1', 'spotify', async () => response(200));

    await guarded('https://api.spotify.com/v1/search?q=a');
    await guarded('https://api.spotify.com/v1/search?q=b');
    await guarded(new URL('https://api.spotify.com/v1/me/player'));
    await guarded(
      new Request('https://api.spotify.com/v1/me/player/queue?uri=x', { method: 'POST' }),
    );

    expect(cooldowns.callCounts()).toEqual({
      'spotify /v1/search': 2,
      'spotify /v1/me/player': 1,
      'spotify /v1/me/player/queue': 1,
    });
  });

  it('does not count calls refused locally during a cooldown', async () => {
    const { cooldowns } = logSetup();
    cooldowns.record('acct-1', 'spotify', 60);
    const guarded = cooldowns.guardFetch('acct-1', 'spotify', async () => response(200));

    await guarded('https://api.spotify.com/v1/search?q=a').catch(() => undefined);

    expect(cooldowns.callCounts()).toEqual({});
  });

  it('logs a one-line summary and resets the counts on flush', async () => {
    const { cooldowns, logger } = logSetup();
    const guarded = cooldowns.guardFetch('acct-1', 'spotify', async () => response(200));
    await guarded('https://api.spotify.com/v1/search?q=a');
    await guarded('https://api.spotify.com/v1/search?q=b');
    await guarded('https://api.spotify.com/v1/me/player');

    cooldowns.flushCallCounts();

    expect(logger.log).toHaveBeenCalledTimes(1);
    const line = logger.log.mock.calls[0]!.map(String).join(' ');
    expect(line).not.toContain('\n');
    expect(line).toContain('spotify /v1/search=2');
    expect(line).toContain('spotify /v1/me/player=1');
    expect(cooldowns.callCounts()).toEqual({});
  });

  it('logs nothing when no calls were made', () => {
    const { cooldowns, logger } = logSetup();

    cooldowns.flushCallCounts();

    expect(logger.log).not.toHaveBeenCalled();
  });

  it('flushes on an interval timer and stops cleanly', async () => {
    vi.useFakeTimers();
    try {
      const logger: FakeLogger = { log: vi.fn(), warn: vi.fn() };
      const cooldowns = new ProviderCooldowns({ logger, callSummaryIntervalMs: 30_000 });
      const guarded = cooldowns.guardFetch('acct-1', 'spotify', async () => response(200));
      await guarded('https://api.spotify.com/v1/search?q=a');

      vi.advanceTimersByTime(29_999);
      expect(logger.log).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(logger.log).toHaveBeenCalledTimes(1);

      // A quiet window logs nothing.
      vi.advanceTimersByTime(30_000);
      expect(logger.log).toHaveBeenCalledTimes(1);

      cooldowns.stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks the summary timer unref so it never holds the process open', async () => {
    const unref = vi.fn();
    const setIntervalSpy = vi
      .spyOn(globalThis, 'setInterval')
      .mockImplementation((() => ({ unref })) as unknown as typeof setInterval);
    const clearIntervalSpy = vi
      .spyOn(globalThis, 'clearInterval')
      .mockImplementation(() => undefined);
    try {
      const cooldowns = new ProviderCooldowns({
        logger: { log: vi.fn(), warn: vi.fn() },
        callSummaryIntervalMs: 30_000,
      });
      const guarded = cooldowns.guardFetch('acct-1', 'spotify', async () => response(200));
      await guarded('https://x.test/y');
      await guarded('https://x.test/z');

      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      expect(unref).toHaveBeenCalledTimes(1);
      cooldowns.stop();
      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });
});
