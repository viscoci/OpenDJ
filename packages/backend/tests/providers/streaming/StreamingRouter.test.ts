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
