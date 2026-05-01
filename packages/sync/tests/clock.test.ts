import { describe, expect, it } from 'vitest';
import type { NowPlayingTrack } from '@opendj/core';
import { createPlaybackClockSample, predictPlaybackPosition } from '../src/clock.js';

function nowPlaying(overrides: Partial<NowPlayingTrack> = {}): NowPlayingTrack {
  return {
    uri: 'spotify:track:abc',
    name: 'Test Track',
    artist: 'Tester',
    albumArt: null,
    durationMs: 200_000,
    progressMs: 50_000,
    isPlaying: true,
    zoneId: 'zone-1',
    ...overrides,
  };
}

describe('createPlaybackClockSample', () => {
  it('captures providerId, trackUri, duration, progress, playing flag', () => {
    const sample = createPlaybackClockSample(
      nowPlaying({ uri: 'spotify:track:xyz', durationMs: 180_000, progressMs: 30_000 }),
      1_700_000_000_000,
      { providerId: 'spotify', confidence: 'high' },
    );
    expect(sample.providerId).toBe('spotify');
    expect(sample.trackUri).toBe('spotify:track:xyz');
    expect(sample.durationMs).toBe(180_000);
    expect(sample.progressMs).toBe(30_000);
    expect(sample.isPlaying).toBe(true);
    expect(sample.sampledAtEpochMs).toBe(1_700_000_000_000);
    expect(sample.confidence).toBe('high');
  });

  it('clamps progressMs to [0, durationMs]', () => {
    const high = createPlaybackClockSample(
      nowPlaying({ progressMs: 300_000, durationMs: 200_000 }),
      0,
    );
    expect(high.progressMs).toBe(200_000);

    const low = createPlaybackClockSample(nowPlaying({ progressMs: -50 }), 0);
    expect(low.progressMs).toBe(0);
  });

  it('defaults confidence to medium', () => {
    const sample = createPlaybackClockSample(nowPlaying(), 0);
    expect(sample.confidence).toBe('medium');
  });

  it('records providerLatencyMs only when provided', () => {
    const without = createPlaybackClockSample(nowPlaying(), 0);
    expect(without.providerLatencyMs).toBeUndefined();

    const withLatency = createPlaybackClockSample(nowPlaying(), 0, { providerLatencyMs: 120 });
    expect(withLatency.providerLatencyMs).toBe(120);
  });

  it('falls back to "unknown" provider when none given', () => {
    const sample = createPlaybackClockSample(nowPlaying(), 0);
    expect(sample.providerId).toBe('unknown');
  });
});

describe('predictPlaybackPosition', () => {
  function sample(overrides: Partial<ReturnType<typeof createPlaybackClockSample>> = {}) {
    return {
      providerId: 'spotify',
      trackUri: 'spotify:track:abc',
      durationMs: 200_000,
      progressMs: 50_000,
      isPlaying: true,
      sampledAtEpochMs: 1_000_000,
      confidence: 'high' as const,
      ...overrides,
    };
  }

  it('advances progressMs while playing', () => {
    const result = predictPlaybackPosition(sample(), 1_001_500); // 1.5s elapsed
    expect(result.progressMs).toBe(51_500);
  });

  it('does NOT advance progressMs while paused', () => {
    const result = predictPlaybackPosition(sample({ isPlaying: false }), 1_010_000);
    expect(result.progressMs).toBe(50_000);
  });

  it('clamps progressMs to durationMs (track ends)', () => {
    const result = predictPlaybackPosition(
      sample({ progressMs: 199_000, durationMs: 200_000 }),
      1_010_000, // 10s elapsed; would land at 209_000
    );
    expect(result.progressMs).toBe(200_000);
    expect(result.remainingMs).toBe(0);
    expect(result.normalizedProgress).toBe(1);
  });

  it('treats out-of-order / clock-skew nowEpochMs as elapsed=0', () => {
    const result = predictPlaybackPosition(sample(), 999_000); // earlier than sampledAtEpochMs
    expect(result.progressMs).toBe(50_000);
  });

  it('reports normalizedProgress in [0, 1]', () => {
    const result = predictPlaybackPosition(sample(), 1_001_000);
    expect(result.normalizedProgress).toBeGreaterThan(0.25);
    expect(result.normalizedProgress).toBeLessThan(0.27);
  });

  it('decays confidence with age: fresh=high, mid=medium, stale=low', () => {
    const fresh = predictPlaybackPosition(sample(), 1_000_500); // 0.5s old
    expect(fresh.confidence).toBe('high');

    const mid = predictPlaybackPosition(sample(), 1_005_000); // 5s old
    expect(mid.confidence).toBe('medium');

    const stale = predictPlaybackPosition(sample(), 1_020_000); // 20s old
    expect(stale.confidence).toBe('low');
  });

  it('never promotes confidence above the original sample', () => {
    const result = predictPlaybackPosition(sample({ confidence: 'low' }), 1_000_001); // ~fresh
    expect(result.confidence).toBe('low');
  });

  it('passes through trackUri, isPlaying, predictedAtEpochMs', () => {
    const result = predictPlaybackPosition(sample(), 1_002_000);
    expect(result.trackUri).toBe('spotify:track:abc');
    expect(result.isPlaying).toBe(true);
    expect(result.predictedAtEpochMs).toBe(1_002_000);
  });
});
