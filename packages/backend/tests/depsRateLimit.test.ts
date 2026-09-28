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
