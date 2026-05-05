import { describe, expect, it } from 'vitest';
import { createEmptySnapshot } from '../src/types/snapshot.js';

describe('createEmptySnapshot', () => {
  it('returns an all-empty snapshot bound to the given session', () => {
    const snapshot = createEmptySnapshot('sess-42', 1_700_000_000_000);
    expect(snapshot).toEqual({
      sessionId: 'sess-42',
      nowPlaying: null,
      recentlyPlayed: [],
      playbackClock: null,
      lyrics: null,
      activeLyricsWindow: [],
      queue: [],
      pending: [],
      providerQueue: [],
      nowPlayingSkipVote: null,
      activeGuestCount: 0,
      queuedGuestCount: 0,
      snapshotAtEpochMs: 1_700_000_000_000,
    });
  });

  it('uses fresh array references each call (no shared mutation)', () => {
    const a = createEmptySnapshot('s', 0);
    const b = createEmptySnapshot('s', 0);
    expect(a.queue).not.toBe(b.queue);
    expect(a.pending).not.toBe(b.pending);
    expect(a.activeLyricsWindow).not.toBe(b.activeLyricsWindow);
    expect(a.recentlyPlayed).not.toBe(b.recentlyPlayed);
  });
});
