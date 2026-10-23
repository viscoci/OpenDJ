import { describe, expect, it, vi } from 'vitest';
import {
  defineCapabilities,
  InvalidProviderCredentialsError,
  PROVIDER_FEATURES,
  supportsSearch,
  type IStreamingProvider,
  type ProviderCapabilities,
  type ProviderCredentials,
  type Track,
} from '@opendj/core';
import { InMemoryProviderConnectionRepository } from '../../../src/repositories/in-memory/index.js';
import {
  ProviderConnectionNotFoundError,
  StreamingRouter,
  UnknownProviderError,
} from '../../../src/providers/streaming/StreamingRouter.js';
import {
  ProviderCooldowns,
  ProviderRateLimitedError,
} from '../../../src/providers/streaming/ProviderCooldowns.js';
import type {
  ProviderContext,
  ProviderRegistry,
} from '../../../src/providers/streaming/providerRegistry.js';

const stubCapabilities: ProviderCapabilities = defineCapabilities('stub', {
  [PROVIDER_FEATURES.Search]: {
    id: PROVIDER_FEATURES.Search,
    supported: true,
    access: 'guest',
    reliability: 'native',
  },
});

interface StubProvider extends IStreamingProvider {
  search(query: string, limit?: number): Promise<Track[]>;
  receivedCredentials: ProviderCredentials | null;
}

function makeStubProvider(): StubProvider {
  const provider: StubProvider = {
    providerId: 'stub',
    displayName: 'Stub',
    receivedCredentials: null,
    async connect(credentials) {
      provider.receivedCredentials = credentials;
    },
    async disconnect() {},
    isConnected() {
      return provider.receivedCredentials !== null;
    },
    async refreshCredentials() {
      return provider.receivedCredentials ?? {};
    },
    getCapabilities() {
      return stubCapabilities;
    },
    async search(query) {
      return [
        {
          uri: `stub:track:${query}`,
          name: query,
          artist: 'stub artist',
          albumArt: null,
          durationMs: 200_000,
        },
      ];
    },
  };
  return provider;
}

function setup() {
  const providerConnections = new InMemoryProviderConnectionRepository();
  const factory = vi.fn(() => makeStubProvider());
  const registry: ProviderRegistry = { stub: factory };
  const context: ProviderContext = { fetch: globalThis.fetch };
  const router = new StreamingRouter({ providerConnections, registry, context });
  return { router, providerConnections, factory };
}

describe('StreamingRouter.getProvider', () => {
  it('throws UnknownProviderError when providerId is not registered', async () => {
    const { router } = setup();
    await expect(router.getProvider('acc-1', 'unknown')).rejects.toBeInstanceOf(
      UnknownProviderError,
    );
  });

  it('throws ProviderConnectionNotFoundError when no row exists', async () => {
    const { router } = setup();
    await expect(router.getProvider('acc-1', 'stub')).rejects.toBeInstanceOf(
      ProviderConnectionNotFoundError,
    );
  });

  it('throws InvalidProviderCredentialsError when row exists but accessToken is null', async () => {
    const { router, providerConnections } = setup();
    await providerConnections.upsert({
      accountId: 'acc-1',
      providerId: 'stub',
      accessToken: null,
    });
    await expect(router.getProvider('acc-1', 'stub')).rejects.toBeInstanceOf(
      InvalidProviderCredentialsError,
    );
  });

  it('instantiates the provider, calls connect with stored credentials, and returns it', async () => {
    const { router, providerConnections } = setup();
    await providerConnections.upsert({
      accountId: 'acc-1',
      providerId: 'stub',
      accessToken: 'AT',
      refreshToken: 'RT',
      providerAccountId: 'pa-1',
      tokenType: 'Bearer',
    });
    const provider = (await router.getProvider('acc-1', 'stub')) as ReturnType<
      typeof makeStubProvider
    >;
    expect(provider.providerId).toBe('stub');
    expect(provider.receivedCredentials).toEqual({
      accessToken: 'AT',
      refreshToken: 'RT',
      accountId: 'pa-1',
      tokenType: 'Bearer',
    });
  });

  it('returned provider is usable via the @opendj/core capability guards', async () => {
    const { router, providerConnections } = setup();
    await providerConnections.upsert({
      accountId: 'acc-1',
      providerId: 'stub',
      accessToken: 'AT',
    });
    const provider = await router.getProvider('acc-1', 'stub');
    expect(supportsSearch(provider)).toBe(true);
    if (supportsSearch(provider)) {
      const tracks = await provider.search('hello');
      expect(tracks[0]?.uri).toBe('stub:track:hello');
    }
  });
});

describe('StreamingRouter.switchProvider', () => {
  it('upserts credentials and returns a connected provider', async () => {
    const { router, providerConnections } = setup();
    const provider = (await router.switchProvider(
      'acc-1',
      'stub',
      { accessToken: 'AT', refreshToken: 'RT' },
      { connectedByUserId: 'u-1', providerAccountId: 'pa-1' },
    )) as ReturnType<typeof makeStubProvider>;
    expect(provider.providerId).toBe('stub');
    const stored = await providerConnections.findByAccountAndProvider('acc-1', 'stub');
    expect(stored?.accessToken).toBe('AT');
    expect(stored?.connectedByUserId).toBe('u-1');
    expect(stored?.providerAccountId).toBe('pa-1');
  });

  it('throws UnknownProviderError for unknown providerId', async () => {
    const { router } = setup();
    await expect(
      router.switchProvider('acc-1', 'unknown', { accessToken: 'AT' }),
    ).rejects.toBeInstanceOf(UnknownProviderError);
  });

  it('throws InvalidProviderCredentialsError when accessToken is missing', async () => {
    const { router } = setup();
    await expect(router.switchProvider('acc-1', 'stub', {})).rejects.toBeInstanceOf(
      InvalidProviderCredentialsError,
    );
  });
});

describe('StreamingRouter rate-limit cooldowns', () => {
  async function setupWithCooldowns() {
    const providerConnections = new InMemoryProviderConnectionRepository();
    const contexts: ProviderContext[] = [];
    const registry: ProviderRegistry = {
      stub: (ctx) => {
        contexts.push(ctx);
        return makeStubProvider();
      },
    };
    const innerFetch = vi.fn(async () => new Response('{}', { status: 200 }));
    const cooldowns = new ProviderCooldowns();
    const router = new StreamingRouter({
      providerConnections,
      registry,
      context: { fetch: innerFetch as unknown as typeof fetch },
      cooldowns,
    });
    await providerConnections.upsert({
      accountId: 'acct-1',
      providerId: 'stub',
      accessToken: 'tok',
    });
    return { router, contexts, innerFetch, cooldowns };
  }

  it('hands providers a fetch that fails fast while the account is cooling down', async () => {
    const { router, contexts, innerFetch, cooldowns } = await setupWithCooldowns();
    cooldowns.record('acct-1', 'stub', 60);

    await router.getProvider('acct-1', 'stub');
    const err = await contexts[0]!.fetch('https://example.test').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProviderRateLimitedError);
    expect(innerFetch).not.toHaveBeenCalled();
  });

  it('reports the open cooldown via rateLimitedUntil', async () => {
    const { router, cooldowns } = await setupWithCooldowns();
    expect(router.rateLimitedUntil('acct-1', 'stub')).toBeNull();

    const until = cooldowns.record('acct-1', 'stub', 60);

    expect(router.rateLimitedUntil('acct-1', 'stub')).toBe(until);
  });
});

describe('StreamingRouter persisted cooldowns', () => {
  /**
   * A connection row that already carries `rate_limited_until`, then a
   * brand-new cooldown registry + router — the state right after a restart.
   */
  async function freshProcess(persistedUntil: Date | null, startMs = 5_000_000) {
    let now = startMs;
    const providerConnections = new InMemoryProviderConnectionRepository();
    await providerConnections.upsert({ accountId: 'acct-1', providerId: 'stub', accessToken: 't' });
    if (persistedUntil) {
      await providerConnections.extendRateLimitedUntil('acct-1', 'stub', persistedUntil);
    }
    const contexts: ProviderContext[] = [];
    const registry: ProviderRegistry = {
      stub: (ctx) => {
        contexts.push(ctx);
        return makeStubProvider();
      },
    };
    const innerFetch = vi.fn(async () => new Response('{}', { status: 200 }));
    const cooldowns = new ProviderCooldowns({ now: () => now, callSummaryIntervalMs: 0 });
    const router = new StreamingRouter({
      providerConnections,
      registry,
      context: { fetch: innerFetch as unknown as typeof fetch },
      cooldowns,
    });
    return {
      router,
      contexts,
      innerFetch,
      cooldowns,
      setNow(ms: number) {
        now = ms;
      },
    };
  }

  it('a fresh router never calls the provider before a persisted deadline (AE7)', async () => {
    const start = 5_000_000;
    const until = start + 110 * 60_000; // 1h50m still to go
    const { router, contexts, innerFetch, setNow } = await freshProcess(new Date(until), start);

    await router.getProvider('acct-1', 'stub');
    const err = await contexts[0]!.fetch('https://example.test/v1/me').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProviderRateLimitedError);
    expect((err as ProviderRateLimitedError).retryAfterSec).toBe(110 * 60);
    expect(innerFetch).not.toHaveBeenCalled();
    expect(router.rateLimitedUntil('acct-1', 'stub')).toBe(until);

    // Once the stored deadline passes, calls go through again.
    setNow(until);
    await router.getProvider('acct-1', 'stub');
    const res = await contexts[1]!.fetch('https://example.test/v1/me');
    expect(res.status).toBe(200);
    expect(innerFetch).toHaveBeenCalledTimes(1);
  });

  it('seeds nothing from a persisted deadline that has already passed', async () => {
    const start = 5_000_000;
    const { router, contexts, innerFetch } = await freshProcess(new Date(start - 1_000), start);

    await router.getProvider('acct-1', 'stub');
    await contexts[0]!.fetch('https://example.test/v1/me');

    expect(innerFetch).toHaveBeenCalledTimes(1);
    expect(router.rateLimitedUntil('acct-1', 'stub')).toBeNull();
  });

  it('seeds nothing when the row has no persisted deadline', async () => {
    const { router, contexts, innerFetch } = await freshProcess(null);

    await router.getProvider('acct-1', 'stub');
    await contexts[0]!.fetch('https://example.test/v1/me');

    expect(innerFetch).toHaveBeenCalledTimes(1);
  });

  it('does not notify onRateLimited listeners when seeding (no write-back loop)', async () => {
    const start = 5_000_000;
    const { router, cooldowns } = await freshProcess(new Date(start + 600_000), start);
    const listener = vi.fn();
    cooldowns.onRateLimited(listener);

    await router.getProvider('acct-1', 'stub');

    expect(listener).not.toHaveBeenCalled();
  });

  it('switchProvider keeps honouring a persisted cooldown after a reconnect', async () => {
    const start = 5_000_000;
    const { router, contexts, innerFetch } = await freshProcess(new Date(start + 600_000), start);

    await router.switchProvider('acct-1', 'stub', { accessToken: 'fresh' });
    const err = await contexts[0]!.fetch('https://example.test/v1/me').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProviderRateLimitedError);
    expect(innerFetch).not.toHaveBeenCalled();
  });
});
