import { describe, expect, it } from 'vitest';
import {
  isNativeTrackUri,
  PROVIDER_TRACK_URI_SCHEMES,
  providerTrackUri,
} from '../../src/providers/capabilities.js';

describe('provider track URI schemes', () => {
  it('knows the Spotify scheme', () => {
    expect(PROVIDER_TRACK_URI_SCHEMES['spotify']).toEqual({
      scheme: 'spotify:',
      trackPrefix: 'spotify:track:',
    });
  });

  it('treats a URI as native only when it starts with the provider scheme', () => {
    expect(isNativeTrackUri('spotify', 'spotify:track:abc')).toBe(true);
    expect(isNativeTrackUri('spotify', 'opendj:isrc:GBDUW0000053')).toBe(false);
    expect(isNativeTrackUri('spotify', 'apple-music:track:1')).toBe(false);
  });

  it('accepts any non-opendj URI for a provider with no known scheme', () => {
    expect(isNativeTrackUri('mock-streamer', 'mock:track:1')).toBe(true);
    expect(isNativeTrackUri('mock-streamer', 'opendj:isrc:GBDUW0000053')).toBe(false);
  });

  it('builds a native track URI from a provider track id', () => {
    expect(providerTrackUri('spotify', '4uLU6hMCjMI75M1A2tKUQC')).toBe(
      'spotify:track:4uLU6hMCjMI75M1A2tKUQC',
    );
    expect(providerTrackUri('apple-music', '123')).toBeNull();
  });
});
