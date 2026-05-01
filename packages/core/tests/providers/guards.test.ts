import { describe, expect, it } from 'vitest';
import {
  defineCapabilities,
  PROVIDER_FEATURES,
  type ProviderCapabilities,
  type ProviderFeatureAccess,
  type ProviderFeatureId,
} from '../../src/providers/capabilities.js';
import type { IStreamingProvider } from '../../src/providers/IStreamingProvider.js';
import {
  supportsNowPlayingRead,
  supportsPause,
  supportsPlaylistsRead,
  supportsPlaylistSwitch,
  supportsPlaylistTracksAdd,
  supportsPlaylistTracksRead,
  supportsQueueTrack,
  supportsResume,
  supportsSearch,
  supportsSkipTrack,
  supportsVolumeRead,
  supportsVolumeSetAbsolute,
  supportsVolumeStep,
  supportsZonesRead,
} from '../../src/providers/guards.js';

interface FakeProviderOptions {
  features: Partial<Record<ProviderFeatureId, ProviderFeatureAccess | false>>;
  methods?: Record<string, (...args: unknown[]) => unknown>;
}

/**
 * Build a minimal IStreamingProvider whose capabilities + methods we can vary
 * independently. `features` declares descriptors (access value or `false` for
 * supported:false). `methods` attaches arbitrary functions to the instance.
 */
function makeProvider(options: FakeProviderOptions): IStreamingProvider {
  const features: ProviderCapabilities['features'] = {};
  for (const [id, access] of Object.entries(options.features) as Array<
    [ProviderFeatureId, ProviderFeatureAccess | false]
  >) {
    if (access === false) {
      features[id] = { id, supported: false, access: 'host', reliability: 'unsupported' };
    } else {
      features[id] = { id, supported: true, access, reliability: 'native' };
    }
  }
  const capabilities = defineCapabilities('test', features);

  const base: IStreamingProvider = {
    providerId: 'test',
    displayName: 'Test Provider',
    connect: async () => {},
    disconnect: async () => {},
    isConnected: () => true,
    refreshCredentials: async () => ({}),
    getCapabilities: () => capabilities,
  };

  return Object.assign(base, options.methods ?? {});
}

describe('supportsSearch', () => {
  it('is true when capability declared and method present', () => {
    const provider = makeProvider({
      features: { [PROVIDER_FEATURES.Search]: 'guest' },
      methods: { search: async () => [] },
    });
    expect(supportsSearch(provider)).toBe(true);
  });

  it('is false when capability declares supported: false even if method present', () => {
    const provider = makeProvider({
      features: { [PROVIDER_FEATURES.Search]: false },
      methods: { search: async () => [] },
    });
    expect(supportsSearch(provider)).toBe(false);
  });

  it('is false when capability declared but method missing', () => {
    const provider = makeProvider({
      features: { [PROVIDER_FEATURES.Search]: 'guest' },
    });
    expect(supportsSearch(provider)).toBe(false);
  });

  it('is false when capability not declared at all', () => {
    const provider = makeProvider({
      features: {},
      methods: { search: async () => [] },
    });
    expect(supportsSearch(provider)).toBe(false);
  });
});

describe('individual feature guards (capability + method symmetry)', () => {
  const cases: Array<{
    name: string;
    feature: ProviderFeatureId;
    method: string;
    guard: (provider: IStreamingProvider) => boolean;
  }> = [
    {
      name: 'supportsZonesRead',
      feature: PROVIDER_FEATURES.ZonesRead,
      method: 'listZones',
      guard: supportsZonesRead,
    },
    {
      name: 'supportsNowPlayingRead',
      feature: PROVIDER_FEATURES.NowPlayingRead,
      method: 'getNowPlaying',
      guard: supportsNowPlayingRead,
    },
    {
      name: 'supportsQueueTrack',
      feature: PROVIDER_FEATURES.QueueTrack,
      method: 'queueTrack',
      guard: supportsQueueTrack,
    },
    {
      name: 'supportsPlaylistSwitch',
      feature: PROVIDER_FEATURES.PlaylistSwitch,
      method: 'switchPlaylist',
      guard: supportsPlaylistSwitch,
    },
    {
      name: 'supportsSkipTrack',
      feature: PROVIDER_FEATURES.SkipTrack,
      method: 'skipTrack',
      guard: supportsSkipTrack,
    },
    {
      name: 'supportsPause',
      feature: PROVIDER_FEATURES.Pause,
      method: 'pause',
      guard: supportsPause,
    },
    {
      name: 'supportsResume',
      feature: PROVIDER_FEATURES.Resume,
      method: 'resume',
      guard: supportsResume,
    },
    {
      name: 'supportsVolumeRead',
      feature: PROVIDER_FEATURES.VolumeRead,
      method: 'getVolume',
      guard: supportsVolumeRead,
    },
    {
      name: 'supportsVolumeSetAbsolute',
      feature: PROVIDER_FEATURES.VolumeSetAbsolute,
      method: 'setVolume',
      guard: supportsVolumeSetAbsolute,
    },
    {
      name: 'supportsPlaylistsRead',
      feature: PROVIDER_FEATURES.PlaylistsRead,
      method: 'listPlaylists',
      guard: supportsPlaylistsRead,
    },
    {
      name: 'supportsPlaylistTracksRead',
      feature: PROVIDER_FEATURES.PlaylistTracksRead,
      method: 'listPlaylistTracks',
      guard: supportsPlaylistTracksRead,
    },
    {
      name: 'supportsPlaylistTracksAdd',
      feature: PROVIDER_FEATURES.PlaylistTracksAdd,
      method: 'addTracksToPlaylist',
      guard: supportsPlaylistTracksAdd,
    },
  ];

  for (const { name, feature, method, guard } of cases) {
    describe(name, () => {
      it('is true when capability + method both present', () => {
        const provider = makeProvider({
          features: { [feature]: 'host' },
          methods: { [method]: async () => undefined },
        });
        expect(guard(provider)).toBe(true);
      });

      it('is false when method missing', () => {
        const provider = makeProvider({
          features: { [feature]: 'host' },
        });
        expect(guard(provider)).toBe(false);
      });

      it('is false when capability marked unsupported', () => {
        const provider = makeProvider({
          features: { [feature]: false },
          methods: { [method]: async () => undefined },
        });
        expect(guard(provider)).toBe(false);
      });
    });
  }
});

describe('supportsVolumeStep', () => {
  it('requires BOTH step-up and step-down capabilities AND both methods', () => {
    const provider = makeProvider({
      features: {
        [PROVIDER_FEATURES.VolumeStepUp]: 'host',
        [PROVIDER_FEATURES.VolumeStepDown]: 'host',
      },
      methods: {
        increaseVolume: async () => undefined,
        decreaseVolume: async () => undefined,
      },
    });
    expect(supportsVolumeStep(provider)).toBe(true);
  });

  it('is false when only step-up declared', () => {
    const provider = makeProvider({
      features: {
        [PROVIDER_FEATURES.VolumeStepUp]: 'host',
      },
      methods: {
        increaseVolume: async () => undefined,
        decreaseVolume: async () => undefined,
      },
    });
    expect(supportsVolumeStep(provider)).toBe(false);
  });

  it('is false when capabilities declared but only one method present', () => {
    const provider = makeProvider({
      features: {
        [PROVIDER_FEATURES.VolumeStepUp]: 'host',
        [PROVIDER_FEATURES.VolumeStepDown]: 'host',
      },
      methods: {
        increaseVolume: async () => undefined,
      },
    });
    expect(supportsVolumeStep(provider)).toBe(false);
  });
});
