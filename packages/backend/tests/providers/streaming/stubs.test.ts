import { describe, expect, it } from 'vitest';
import { isFeatureSupported, NotImplementedError, PROVIDER_FEATURES } from '@opendj/core';
import { AppleMusicProvider } from '../../../src/providers/streaming/AppleMusicProvider.js';
import { SoundtrackProvider } from '../../../src/providers/streaming/SoundtrackProvider.js';

describe('AppleMusicProvider', () => {
  it('reports unsupported capabilities', () => {
    const provider = new AppleMusicProvider();
    const caps = provider.getCapabilities();
    expect(caps.providerId).toBe('apple-music');
    expect(isFeatureSupported(caps, PROVIDER_FEATURES.Search)).toBe(false);
  });

  it('throws NotImplementedError on connect', async () => {
    const provider = new AppleMusicProvider();
    await expect(provider.connect({})).rejects.toBeInstanceOf(NotImplementedError);
  });

  it('refreshCredentials throws NotImplementedError', async () => {
    const provider = new AppleMusicProvider();
    await expect(provider.refreshCredentials()).rejects.toBeInstanceOf(NotImplementedError);
  });

  it('isConnected returns false', () => {
    expect(new AppleMusicProvider().isConnected()).toBe(false);
  });
});

describe('SoundtrackProvider', () => {
  it('declares P1 capabilities all unsupported until impl lands', () => {
    const caps = new SoundtrackProvider().getCapabilities();
    expect(caps.providerId).toBe('soundtrack');
    expect(isFeatureSupported(caps, PROVIDER_FEATURES.Search)).toBe(false);
    expect(isFeatureSupported(caps, PROVIDER_FEATURES.PlaylistSwitch)).toBe(false);
    expect(isFeatureSupported(caps, PROVIDER_FEATURES.NowPlayingRead)).toBe(false);
    expect(isFeatureSupported(caps, PROVIDER_FEATURES.ZonesRead)).toBe(false);
  });

  it('connect throws NotImplementedError', async () => {
    await expect(new SoundtrackProvider().connect({})).rejects.toBeInstanceOf(NotImplementedError);
  });
});
