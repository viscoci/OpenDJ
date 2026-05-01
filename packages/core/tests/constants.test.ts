import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SONGS_PER_GUEST_CAP,
  HOSTED_FREE_TIER_GUEST_CAP,
  SLOT_EXPIRY_SWEEP_INTERVAL_MS,
  SLOT_HEARTBEAT_TIMEOUT_MS,
  SPOTIFY_SCOPES,
} from '../src/constants.js';

describe('constants', () => {
  it('locks the hosted free-tier guest cap to 12', () => {
    expect(HOSTED_FREE_TIER_GUEST_CAP).toBe(12);
  });

  it('defaults songs-per-guest cap to 3', () => {
    expect(DEFAULT_SONGS_PER_GUEST_CAP).toBe(3);
  });

  it('uses 5-minute slot heartbeat timeout', () => {
    expect(SLOT_HEARTBEAT_TIMEOUT_MS).toBe(300_000);
  });

  it('uses 60-second sweep interval', () => {
    expect(SLOT_EXPIRY_SWEEP_INTERVAL_MS).toBe(60_000);
  });

  it('declares the minimum Spotify scopes for playback control', () => {
    expect(SPOTIFY_SCOPES).toEqual(['user-read-playback-state', 'user-modify-playback-state']);
  });
});
