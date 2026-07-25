import { describe, expect, it } from 'vitest';
import {
  isEventOfType,
  isLyricsEvent,
  isPlaybackEvent,
  isQueueEvent,
  type SessionEvent,
} from '../src/types/event.js';

const queueEvents: SessionEvent[] = [
  {
    type: 'queue.item_requested',
    item: {
      id: 'i',
      guestId: 'g',
      trackUri: 'u',
      trackName: 't',
      artistName: 'a',
      albumArtUrl: null,
      durationMs: null,
      status: 'pending',
      skipVotes: 0,
      createdAtEpochMs: 0,
      decidedAtEpochMs: null,
      karaokeClaims: [],
    },
  },
  { type: 'queue.item_approved', itemId: 'i' },
  { type: 'queue.item_rejected', itemId: 'i' },
  { type: 'queue.item_removed', itemId: 'i' },
  { type: 'skip_vote.updated', itemId: 'i', votes: 1, threshold: 5 },
];

const settingsEvent: SessionEvent = {
  type: 'session.settings_updated',
  settings: {
    name: 'Party',
    guestCapOverride: null,
    songsPerGuestCap: 3,
    maxConsecutivePerGuest: null,
    allowDuplicates: false,
    moderationEnabled: false,
    voteSkipMode: 'fixed',
    voteSkipThreshold: 5,
    karaokeMode: 'optional',
    karaokeMicCount: 2,
    karaokePauseMode: 'manual',
    karaokePauseTimeoutSec: 30,
  },
};

const playbackEvents: SessionEvent[] = [
  { type: 'now_playing.updated', track: null },
  {
    type: 'playback.clock_sampled',
    sample: {
      providerId: 'spotify',
      trackUri: 'u',
      durationMs: 200_000,
      progressMs: 1000,
      isPlaying: true,
      sampledAtEpochMs: 0,
      confidence: 'medium',
    },
  },
  {
    type: 'playback.corrected',
    position: {
      trackUri: 'u',
      progressMs: 0,
      normalizedProgress: 0,
      remainingMs: 0,
      isPlaying: false,
      confidence: 'low',
      predictedAtEpochMs: 0,
    },
  },
];

const lyricsEvents: SessionEvent[] = [
  { type: 'lyrics.loaded', trackUri: 'u', lyrics: null },
  { type: 'lyrics.feedback_recorded', trackUri: 'u', feedbackKind: 'wrong_song' },
  { type: 'sync.cue_window_updated', trackUri: 'u', cues: [] },
];

const otherEvents: SessionEvent[] = [
  { type: 'guest_slots.updated', activeCount: 1, queuedCount: 0 },
  { type: 'session.ended' },
  // Karaoke events are their own family — not part of the queue bucket.
  {
    type: 'karaoke.claim_added',
    itemId: 'i',
    claim: { guestId: 'g', displayName: 'Ana' },
  },
  { type: 'karaoke.claim_removed', itemId: 'i', guestId: 'g' },
  settingsEvent,
];

describe('isEventOfType — discriminated narrowing', () => {
  it('narrows to a specific variant', () => {
    const e: SessionEvent = { type: 'queue.item_approved', itemId: 'x' };
    if (isEventOfType(e, 'queue.item_approved')) {
      expect(e.itemId).toBe('x');
    } else {
      expect.fail('expected narrowing to succeed');
    }
  });

  it('returns false for non-matching variants', () => {
    const e: SessionEvent = { type: 'session.ended' };
    expect(isEventOfType(e, 'queue.item_approved')).toBe(false);
  });
});

describe('event-bucket helpers', () => {
  it('isQueueEvent matches all queue + skip_vote types', () => {
    for (const e of queueEvents) expect(isQueueEvent(e)).toBe(true);
    for (const e of [...playbackEvents, ...lyricsEvents, ...otherEvents]) {
      expect(isQueueEvent(e)).toBe(false);
    }
  });

  it('isPlaybackEvent matches now_playing + clock + corrected', () => {
    for (const e of playbackEvents) expect(isPlaybackEvent(e)).toBe(true);
    for (const e of [...queueEvents, ...lyricsEvents, ...otherEvents]) {
      expect(isPlaybackEvent(e)).toBe(false);
    }
  });

  it('isLyricsEvent matches lyrics + cue window', () => {
    for (const e of lyricsEvents) expect(isLyricsEvent(e)).toBe(true);
    for (const e of [...queueEvents, ...playbackEvents, ...otherEvents]) {
      expect(isLyricsEvent(e)).toBe(false);
    }
  });

  it('the three bucket helpers partition queue+playback+lyrics events disjointly', () => {
    for (const e of [...queueEvents, ...playbackEvents, ...lyricsEvents]) {
      const hits = [isQueueEvent(e), isPlaybackEvent(e), isLyricsEvent(e)].filter(Boolean).length;
      expect(hits).toBe(1);
    }
  });
});
