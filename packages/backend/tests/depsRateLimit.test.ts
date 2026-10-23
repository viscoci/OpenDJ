import { describe, expect, it, vi } from 'vitest';
import { supportsSearch } from '@opendj/core';
import type { Config } from '../src/config.js';
import { createDeps } from '../src/deps.js';
import { ProviderRateLimitedError } from '../src/providers/streaming/ProviderCooldowns.js';
import { createInMemoryRepositories } from '../src/repositories/in-memory/index.js';

function fakeConfig(): Config {
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

describe('createDeps — shared Spotify rate-limit cooldown', () => {
  it('stops calling Spotify for an account after any caller sees a 429', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('{"error":{"status":429,"reason":"QUOTA_EXCEEDED"}}', {
          status: 429,
          headers: { 'retry-after': '56029' },
        }),
    );
    const repositories = createInMemoryRepositories();
    const deps = createDeps({
      config: fakeConfig(),
      repositories,
      realtime: 'none',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await repositories.providerConnections.upsert({
      accountId: 'acct-1',
      providerId: 'spotify',
      accessToken: 'tok',
    });

    // First caller (e.g. the poller) eats the real 429.
    const first = await deps.streamingRouter.getProvider('acct-1', 'spotify');
    if (!supportsSearch(first)) throw new Error('spotify should support search');
    await expect(first.search('a')).rejects.toMatchObject({ status: 429 });

    // A different caller with a fresh provider instance (e.g. guest search)
    // is refused locally — Spotify never sees the call.
    const second = await deps.streamingRouter.getProvider('acct-1', 'spotify');
    if (!supportsSearch(second)) throw new Error('spotify should support search');
    await expect(second.search('b')).rejects.toBeInstanceOf(ProviderRateLimitedError);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(deps.streamingRouter.rateLimitedUntil('acct-1', 'spotify')).not.toBeNull();
  });
});

describe('createDeps — rate-limit notifications', () => {
  it('tells the NowPlayingPoller whenever a provider cooldown opens', () => {
    const deps = createDeps({ config: fakeConfig(), repositories: createInMemoryRepositories() });
    const notify = vi.spyOn(deps.nowPlayingPoller!, 'notifyRateLimited').mockResolvedValue();

    const until = deps.providerCooldowns.record('acct-1', 'spotify', 60);

    expect(notify).toHaveBeenCalledWith({
      accountId: 'acct-1',
      providerId: 'spotify',
      untilEpochMs: until,
    });
  });
});

describe('createDeps — persisted cooldown write-through', () => {
  async function depsWithConnection(config: Config = fakeConfig()) {
    const repositories = createInMemoryRepositories();
    await repositories.providerConnections.upsert({
      accountId: 'acct-1',
      providerId: 'spotify',
      accessToken: 'tok',
    });
    const deps = createDeps({ config, repositories, realtime: 'none' });
    return { deps, repositories };
  }

  async function storedUntil(repositories: ReturnType<typeof createInMemoryRepositories>) {
    const row = await repositories.providerConnections.findByAccountAndProvider(
      'acct-1',
      'spotify',
    );
    return row?.rateLimitedUntil ?? null;
  }

  it('writes an opened cooldown through to the connection row', async () => {
    const { deps, repositories } = await depsWithConnection();

    const until = deps.providerCooldowns.record('acct-1', 'spotify', 120);

    await vi.waitFor(async () => {
      expect((await storedUntil(repositories))?.getTime()).toBe(until);
    });
  });

  it('clamps a very long Retry-After to 24h before storing it', async () => {
    const { deps, repositories } = await depsWithConnection();
    const before = Date.now();

    const until = deps.providerCooldowns.record('acct-1', 'spotify', 200_000);
    const after = Date.now();

    // The in-memory cooldown keeps what the provider announced...
    expect(until).toBeGreaterThanOrEqual(before + 200_000_000);
    // ...but the persisted deadline is capped at 24h from now.
    await vi.waitFor(async () => {
      const stored = (await storedUntil(repositories))?.getTime();
      expect(stored).toBeGreaterThanOrEqual(before + 86_400_000);
      expect(stored).toBeLessThanOrEqual(after + 86_400_000);
    });
  });

  it('honours a configured PROVIDER_COOLDOWN_MAX_SEC cap', async () => {
    const { deps, repositories } = await depsWithConnection({
      ...fakeConfig(),
      providerCooldownMaxSec: 600,
    });
    const before = Date.now();

    deps.providerCooldowns.record('acct-1', 'spotify', 3_600);
    const after = Date.now();

    await vi.waitFor(async () => {
      const stored = (await storedUntil(repositories))?.getTime();
      expect(stored).toBeGreaterThanOrEqual(before + 600_000);
      expect(stored).toBeLessThanOrEqual(after + 600_000);
    });
  });

  it('swallows a rejected repository write and keeps the in-memory cooldown', async () => {
    const { deps, repositories } = await depsWithConnection();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const write = vi
      .spyOn(repositories.providerConnections, 'extendRateLimitedUntil')
      .mockRejectedValue(new Error('db down'));
    try {
      const until = deps.providerCooldowns.record('acct-1', 'spotify', 60);

      expect(write).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(error).toHaveBeenCalled());
      expect(deps.providerCooldowns.untilEpochMs('acct-1', 'spotify')).toBe(until);
    } finally {
      error.mockRestore();
    }
  });

  it('ignores a write for a missing connection row', async () => {
    const repositories = createInMemoryRepositories();
    const deps = createDeps({ config: fakeConfig(), repositories, realtime: 'none' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const until = deps.providerCooldowns.record('acct-x', 'spotify', 60);

      await vi.waitFor(() => expect(warn).toHaveBeenCalled());
      expect(repositories.providerConnections.rows.size).toBe(0);
      expect(deps.providerCooldowns.untilEpochMs('acct-x', 'spotify')).toBe(until);
    } finally {
      warn.mockRestore();
    }
  });

  it('a restarted process reads the stored cooldown back and makes no Spotify call (AE7)', async () => {
    const repositories = createInMemoryRepositories();
    await repositories.providerConnections.upsert({
      accountId: 'acct-1',
      providerId: 'spotify',
      accessToken: 'tok',
    });
    const fetch429 = vi.fn(
      async () => new Response('{}', { status: 429, headers: { 'retry-after': '7200' } }),
    );
    const first = createDeps({
      config: fakeConfig(),
      repositories,
      realtime: 'none',
      fetchImpl: fetch429 as unknown as typeof fetch,
    });
    const provider = await first.streamingRouter.getProvider('acct-1', 'spotify');
    if (!supportsSearch(provider)) throw new Error('spotify should support search');
    await expect(provider.search('a')).rejects.toMatchObject({ status: 429 });
    await vi.waitFor(async () => expect(await storedUntil(repositories)).not.toBeNull());
    first.providerCooldowns.stop();

    // "Restart": new deps (fresh in-memory cooldowns) over the same storage.
    const fetchAfter = vi.fn(async () => new Response('{}', { status: 200 }));
    const second = createDeps({
      config: fakeConfig(),
      repositories,
      realtime: 'none',
      fetchImpl: fetchAfter as unknown as typeof fetch,
    });
    const again = await second.streamingRouter.getProvider('acct-1', 'spotify');
    if (!supportsSearch(again)) throw new Error('spotify should support search');
    await expect(again.search('b')).rejects.toBeInstanceOf(ProviderRateLimitedError);
    expect(fetchAfter).not.toHaveBeenCalled();
    second.providerCooldowns.stop();
  });
});
