import { describe, expect, it } from 'vitest';
import {
  defineCapabilities,
  getFeatureDescriptor,
  isFeatureSupported,
  PROVIDER_FEATURES,
} from '../../src/providers/capabilities.js';

describe('PROVIDER_FEATURES', () => {
  it('uses stable namespaced string IDs', () => {
    expect(PROVIDER_FEATURES.Search).toBe('search');
    expect(PROVIDER_FEATURES.QueueTrack).toBe('queue.track');
    expect(PROVIDER_FEATURES.SkipTrack).toBe('playback.skip');
    expect(PROVIDER_FEATURES.VolumeSetAbsolute).toBe('volume.set_absolute');
    expect(PROVIDER_FEATURES.VolumeStepUp).toBe('volume.step_up');
    expect(PROVIDER_FEATURES.VolumeStepDown).toBe('volume.step_down');
  });

  it('has unique IDs', () => {
    const ids = Object.values(PROVIDER_FEATURES);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('defineCapabilities', () => {
  it('builds a ProviderCapabilities map', () => {
    const capabilities = defineCapabilities('spotify', {
      [PROVIDER_FEATURES.Search]: {
        id: PROVIDER_FEATURES.Search,
        supported: true,
        access: 'guest',
        reliability: 'native',
      },
    });

    expect(capabilities.providerId).toBe('spotify');
    expect(capabilities.features[PROVIDER_FEATURES.Search]?.supported).toBe(true);
  });

  it('throws when a descriptor id does not match its key', () => {
    expect(() =>
      defineCapabilities('spotify', {
        [PROVIDER_FEATURES.Search]: {
          // wrong id on purpose
          id: PROVIDER_FEATURES.QueueTrack,
          supported: true,
          access: 'guest',
        },
      }),
    ).toThrow(/mismatched id/);
  });
});

describe('getFeatureDescriptor', () => {
  it('returns the descriptor when present', () => {
    const capabilities = defineCapabilities('spotify', {
      [PROVIDER_FEATURES.Search]: {
        id: PROVIDER_FEATURES.Search,
        supported: true,
        access: 'guest',
      },
    });

    const descriptor = getFeatureDescriptor(capabilities, PROVIDER_FEATURES.Search);
    expect(descriptor?.access).toBe('guest');
  });

  it('returns undefined when the feature is not declared', () => {
    const capabilities = defineCapabilities('spotify', {});
    expect(getFeatureDescriptor(capabilities, PROVIDER_FEATURES.QueueTrack)).toBeUndefined();
  });
});

describe('isFeatureSupported', () => {
  it('is true when descriptor declares supported: true', () => {
    const capabilities = defineCapabilities('spotify', {
      [PROVIDER_FEATURES.Search]: {
        id: PROVIDER_FEATURES.Search,
        supported: true,
        access: 'guest',
      },
    });
    expect(isFeatureSupported(capabilities, PROVIDER_FEATURES.Search)).toBe(true);
  });

  it('is false when descriptor declares supported: false', () => {
    const capabilities = defineCapabilities('spotify', {
      [PROVIDER_FEATURES.ZonesRead]: {
        id: PROVIDER_FEATURES.ZonesRead,
        supported: false,
        access: 'host',
        reliability: 'unsupported',
      },
    });
    expect(isFeatureSupported(capabilities, PROVIDER_FEATURES.ZonesRead)).toBe(false);
  });

  it('is false when descriptor is absent', () => {
    const capabilities = defineCapabilities('spotify', {});
    expect(isFeatureSupported(capabilities, PROVIDER_FEATURES.Search)).toBe(false);
  });
});
