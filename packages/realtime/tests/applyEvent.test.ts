import { describe, expect, it } from 'vitest';
import { applyEvent } from '../src/applyEvent.js';
import { createEmptySnapshot } from '../src/types/snapshot.js';
import type { QueueItemSummary } from '../src/types/queue-summary.js';
import type { SessionEvent } from '../src/types/event.js';

function snapshot(): ReturnType<typeof createEmptySnapshot> {
  return createEmptySnapshot('sess-1', 1_700_000_000_000);
}

function item(id: string, overrides: Partial<QueueItemSummary> = {}): QueueItemSummary {
  return {
    id,
    guestId: 'guest-1',
    trackUri: `spotify:track:${id}`,
    trackName: id,
    artistName: 'A',
    albumArtUrl: null,
    durationMs: 200_000,
    status: 'pending',
    skipVotes: 0,
    createdAtEpochMs: 0,
    decidedAtEpochMs: null,
    karaokeClaims: [],
    ...overrides,
  };
}

describe('applyEvent — queue lifecycle', () => {
  it('queue.item_requested appends to pending', () => {
    const next = applyEvent(snapshot(), { type: 'queue.item_requested', item: item('a') });
    expect(next.pending.map((i) => i.id)).toEqual(['a']);
    expect(next.queue).toEqual([]);
  });

  it('queue.item_approved moves from pending to queue with status=approved', () => {
    let s = snapshot();
    s = applyEvent(s, { type: 'queue.item_requested', item: item('a') });
    s = applyEvent(s, { type: 'queue.item_approved', itemId: 'a' });
    expect(s.pending).toEqual([]);
    expect(s.queue.map((i) => i.id)).toEqual(['a']);
    expect(s.queue[0]?.status).toBe('approved');
  });

  it('queue.item_approved is idempotent on already-approved (status update only)', () => {
    let s = snapshot();
    s = applyEvent(s, { type: 'queue.item_requested', item: item('a') });
    s = applyEvent(s, { type: 'queue.item_approved', itemId: 'a' });
    s = applyEvent(s, { type: 'queue.item_approved', itemId: 'a' });
    expect(s.queue.map((i) => i.id)).toEqual(['a']);
    expect(s.pending).toEqual([]);
  });

  it('queue.item_rejected drops from pending without surfacing in queue', () => {
    let s = snapshot();
    s = applyEvent(s, { type: 'queue.item_requested', item: item('a') });
    s = applyEvent(s, { type: 'queue.item_rejected', itemId: 'a' });
    expect(s.pending).toEqual([]);
    expect(s.queue).toEqual([]);
  });

  it('queue.item_rejected on a queued item also drops it', () => {
    let s = snapshot();
    s = applyEvent(s, { type: 'queue.item_requested', item: item('a') });
    s = applyEvent(s, { type: 'queue.item_approved', itemId: 'a' });
    s = applyEvent(s, { type: 'queue.item_rejected', itemId: 'a' });
    expect(s.queue).toEqual([]);
  });

  it('queue.item_removed clears from both queue and pending', () => {
    let s = snapshot();
    s = applyEvent(s, { type: 'queue.item_requested', item: item('a') });
    s = applyEvent(s, { type: 'queue.item_requested', item: item('b') });
    s = applyEvent(s, { type: 'queue.item_approved', itemId: 'a' });
    s = applyEvent(s, { type: 'queue.item_removed', itemId: 'a' });
    s = applyEvent(s, { type: 'queue.item_removed', itemId: 'b' });
    expect(s.queue).toEqual([]);
    expect(s.pending).toEqual([]);
  });

  it('queue events are no-op for unknown ids', () => {
    const s = snapshot();
    expect(applyEvent(s, { type: 'queue.item_approved', itemId: 'x' })).toBe(s);
    expect(applyEvent(s, { type: 'queue.item_rejected', itemId: 'x' })).toBe(s);
    expect(applyEvent(s, { type: 'queue.item_removed', itemId: 'x' })).toEqual(s);
  });
});

describe('applyEvent — playback / now-playing', () => {
  it('now_playing.updated replaces nowPlaying', () => {
    const next = applyEvent(snapshot(), {
      type: 'now_playing.updated',
      track: {
        uri: 'spotify:track:abc',
        name: 'X',
        artist: 'A',
        albumArt: null,
        durationMs: 200_000,
        progressMs: 0,
        isPlaying: true,
        zoneId: 'default',
      },
    });
    expect(next.nowPlaying?.uri).toBe('spotify:track:abc');
  });

  it('now_playing.updated with null clears nowPlaying', () => {
    let s = snapshot();
    s = applyEvent(s, {
      type: 'now_playing.updated',
      track: {
        uri: 'spotify:track:abc',
        name: 'X',
        artist: 'A',
        albumArt: null,
        durationMs: 200_000,
        progressMs: 0,
        isPlaying: true,
        zoneId: 'default',
      },
    });
    s = applyEvent(s, { type: 'now_playing.updated', track: null });
    expect(s.nowPlaying).toBeNull();
  });

  it('rolls the previous track onto recentlyPlayed when uri changes', () => {
    const trackA = {
      uri: 'spotify:track:a',
      name: 'A',
      artist: 'A',
      albumArt: null,
      durationMs: 200_000,
      progressMs: 0,
      isPlaying: true,
      zoneId: 'default',
    };
    const trackB = { ...trackA, uri: 'spotify:track:b', name: 'B' };
    let s = snapshot();
    s = applyEvent(s, { type: 'now_playing.updated', track: trackA });
    expect(s.recentlyPlayed).toEqual([]);
    s = applyEvent(s, { type: 'now_playing.updated', track: trackB });
    expect(s.recentlyPlayed).toHaveLength(1);
    expect(s.recentlyPlayed[0]?.uri).toBe('spotify:track:a');
    expect(s.nowPlaying?.uri).toBe('spotify:track:b');
  });

  it('does not duplicate recentlyPlayed when the same track refreshes (progress drift)', () => {
    const t = {
      uri: 'spotify:track:a',
      name: 'A',
      artist: 'A',
      albumArt: null,
      durationMs: 200_000,
      progressMs: 0,
      isPlaying: true,
      zoneId: 'default',
    };
    let s = snapshot();
    s = applyEvent(s, { type: 'now_playing.updated', track: t });
    s = applyEvent(s, { type: 'now_playing.updated', track: { ...t, progressMs: 5000 } });
    expect(s.recentlyPlayed).toEqual([]);
  });

  it('caps recentlyPlayed at the configured maximum', () => {
    let s = snapshot();
    for (let i = 0; i < 15; i += 1) {
      s = applyEvent(s, {
        type: 'now_playing.updated',
        track: {
          uri: `spotify:track:${i}`,
          name: `T${i}`,
          artist: 'A',
          albumArt: null,
          durationMs: 1000,
          progressMs: 0,
          isPlaying: true,
          zoneId: 'default',
        },
      });
    }
    expect(s.recentlyPlayed.length).toBe(10);
    // Most-recent-first ordering: previous track 13 sits at the head.
    expect(s.recentlyPlayed[0]?.uri).toBe('spotify:track:13');
  });

  it('clears lyrics when the track changes, but preserves them on same-track updates', () => {
    const trackA = {
      uri: 'spotify:track:a',
      name: 'A',
      artist: 'A',
      albumArt: null,
      durationMs: 200_000,
      progressMs: 0,
      isPlaying: true,
      zoneId: 'default',
    };
    const trackB = { ...trackA, uri: 'spotify:track:b', name: 'B' };
    const lyricsForA = {
      id: 'lrclib:1',
      source: 'lrclib' as const,
      trackName: 'A',
      artistName: 'A',
      isSynced: false,
      lines: [],
      matchConfidence: 'medium' as const,
    };
    let s = snapshot();
    s = applyEvent(s, { type: 'now_playing.updated', track: trackA });
    s = applyEvent(s, { type: 'lyrics.loaded', trackUri: 'spotify:track:a', lyrics: lyricsForA });
    expect(s.lyrics?.id).toBe('lrclib:1');

    // Re-applying the SAME track (e.g. a progress-drift tick) preserves lyrics.
    const sameTrack = applyEvent(s, {
      type: 'now_playing.updated',
      track: { ...trackA, progressMs: 5000 },
    });
    expect(sameTrack.lyrics?.id).toBe('lrclib:1');

    // Track change to B clears lyrics from the snapshot immediately, before
    // B's own lyrics.loaded arrives.
    const changed = applyEvent(s, { type: 'now_playing.updated', track: trackB });
    expect(changed.lyrics).toBeNull();
  });

  it('playback.clock_sampled stores the sample', () => {
    const next = applyEvent(snapshot(), {
      type: 'playback.clock_sampled',
      sample: {
        providerId: 'spotify',
        trackUri: 'spotify:track:abc',
        durationMs: 200_000,
        progressMs: 1000,
        isPlaying: true,
        sampledAtEpochMs: 0,
        confidence: 'high',
      },
    });
    expect(next.playbackClock?.providerId).toBe('spotify');
  });

  it('playback.corrected does not mutate playbackClock (advisory only)', () => {
    const s = snapshot();
    const next = applyEvent(s, {
      type: 'playback.corrected',
      position: {
        trackUri: 'spotify:track:abc',
        progressMs: 0,
        normalizedProgress: 0,
        remainingMs: 0,
        isPlaying: false,
        confidence: 'low',
        predictedAtEpochMs: 0,
      },
    });
    expect(next).toBe(s);
  });
});

describe('applyEvent — skip / slots / lyrics / end', () => {
  it('skip_vote.updated bumps the queued item votes', () => {
    let s = snapshot();
    s = applyEvent(s, { type: 'queue.item_requested', item: item('a') });
    s = applyEvent(s, { type: 'queue.item_approved', itemId: 'a' });
    s = applyEvent(s, {
      type: 'skip_vote.updated',
      itemId: 'a',
      votes: 4,
      threshold: 5,
    });
    expect(s.queue[0]?.skipVotes).toBe(4);
  });

  it('guest_slots.updated stores active + queued counts', () => {
    const next = applyEvent(snapshot(), {
      type: 'guest_slots.updated',
      activeCount: 7,
      queuedCount: 2,
    });
    expect(next.activeGuestCount).toBe(7);
    expect(next.queuedGuestCount).toBe(2);
  });

  it('lyrics.loaded sets snapshot.lyrics (or clears with null)', () => {
    let s = snapshot();
    const lyrics = {
      id: 'lrclib:1',
      source: 'lrclib' as const,
      trackName: 't',
      artistName: 'a',
      isSynced: false,
      lines: [],
      matchConfidence: 'medium' as const,
    };
    s = applyEvent(s, { type: 'lyrics.loaded', trackUri: 'u', lyrics });
    expect(s.lyrics?.id).toBe('lrclib:1');
    s = applyEvent(s, { type: 'lyrics.loaded', trackUri: 'u', lyrics: null });
    expect(s.lyrics).toBeNull();
  });

  it('lyrics.feedback_recorded does not mutate', () => {
    const s = snapshot();
    const next = applyEvent(s, {
      type: 'lyrics.feedback_recorded',
      trackUri: 'u',
      feedbackKind: 'wrong_song',
    });
    expect(next).toBe(s);
  });

  it('sync.cue_window_updated does not mutate', () => {
    const s = snapshot();
    const next = applyEvent(s, {
      type: 'sync.cue_window_updated',
      trackUri: 'u',
      cues: [],
    });
    expect(next).toBe(s);
  });

  it('session.ended does not mutate the snapshot', () => {
    const s = snapshot();
    const event: SessionEvent = { type: 'session.ended' };
    expect(applyEvent(s, event)).toBe(s);
  });
});

describe('applyEvent — karaoke claims', () => {
  const ana = { guestId: 'guest-1', displayName: 'Ana' };
  const ben = { guestId: 'guest-2', displayName: 'Ben' };

  it('karaoke.claim_added appends the claim to a queue item', () => {
    let s = snapshot();
    s = applyEvent(s, { type: 'queue.item_requested', item: item('a') });
    s = applyEvent(s, { type: 'queue.item_approved', itemId: 'a' });
    s = applyEvent(s, { type: 'karaoke.claim_added', itemId: 'a', claim: ana });
    s = applyEvent(s, { type: 'karaoke.claim_added', itemId: 'a', claim: ben });
    expect(s.queue[0]?.karaokeClaims).toEqual([ana, ben]);
  });

  it('karaoke.claim_added folds into PENDING items too (claims allowed under moderation)', () => {
    let s = snapshot();
    s = applyEvent(s, { type: 'queue.item_requested', item: item('a') });
    s = applyEvent(s, { type: 'karaoke.claim_added', itemId: 'a', claim: ana });
    expect(s.pending[0]?.karaokeClaims).toEqual([ana]);
    expect(s.queue).toEqual([]);
  });

  it('karaoke.claim_added only touches the targeted item', () => {
    let s = snapshot();
    s = applyEvent(s, { type: 'queue.item_requested', item: item('a') });
    s = applyEvent(s, { type: 'queue.item_requested', item: item('b') });
    s = applyEvent(s, { type: 'karaoke.claim_added', itemId: 'a', claim: ana });
    expect(s.pending.find((i) => i.id === 'a')?.karaokeClaims).toEqual([ana]);
    expect(s.pending.find((i) => i.id === 'b')?.karaokeClaims).toEqual([]);
  });

  it('karaoke.claim_added for the same guest replaces instead of duplicating', () => {
    let s = snapshot();
    s = applyEvent(s, { type: 'queue.item_requested', item: item('a') });
    s = applyEvent(s, { type: 'karaoke.claim_added', itemId: 'a', claim: ana });
    s = applyEvent(s, {
      type: 'karaoke.claim_added',
      itemId: 'a',
      claim: { guestId: 'guest-1', displayName: 'Ana B' },
    });
    expect(s.pending[0]?.karaokeClaims).toEqual([{ guestId: 'guest-1', displayName: 'Ana B' }]);
  });

  it('karaoke.claim_added is a no-op for unknown item ids', () => {
    const s = snapshot();
    const next = applyEvent(s, { type: 'karaoke.claim_added', itemId: 'nope', claim: ana });
    expect(next).toBe(s);
  });

  it("karaoke.claim_removed removes only that guest's claim", () => {
    let s = snapshot();
    s = applyEvent(s, { type: 'queue.item_requested', item: item('a') });
    s = applyEvent(s, { type: 'queue.item_approved', itemId: 'a' });
    s = applyEvent(s, { type: 'karaoke.claim_added', itemId: 'a', claim: ana });
    s = applyEvent(s, { type: 'karaoke.claim_added', itemId: 'a', claim: ben });
    s = applyEvent(s, { type: 'karaoke.claim_removed', itemId: 'a', guestId: 'guest-1' });
    expect(s.queue[0]?.karaokeClaims).toEqual([ben]);
  });

  it('karaoke.claim_removed on a pending item works too', () => {
    let s = snapshot();
    s = applyEvent(s, { type: 'queue.item_requested', item: item('a') });
    s = applyEvent(s, { type: 'karaoke.claim_added', itemId: 'a', claim: ana });
    s = applyEvent(s, { type: 'karaoke.claim_removed', itemId: 'a', guestId: 'guest-1' });
    expect(s.pending[0]?.karaokeClaims).toEqual([]);
  });

  it('karaoke.claim_removed is a no-op for unknown item ids', () => {
    const s = snapshot();
    const next = applyEvent(s, { type: 'karaoke.claim_removed', itemId: 'nope', guestId: 'g' });
    expect(next).toBe(s);
  });

  it('claims survive the pending → queue move on approval', () => {
    let s = snapshot();
    s = applyEvent(s, { type: 'queue.item_requested', item: item('a') });
    s = applyEvent(s, { type: 'karaoke.claim_added', itemId: 'a', claim: ana });
    s = applyEvent(s, { type: 'queue.item_approved', itemId: 'a' });
    expect(s.queue[0]?.karaokeClaims).toEqual([ana]);
  });
});

describe('applyEvent — karaoke spotlight + pause', () => {
  const ana = { guestId: 'guest-1', displayName: 'Ana' };
  const ben = { guestId: 'guest-2', displayName: 'Ben' };

  it('karaoke.spotlight sets spotlightItemId and refreshes the item claims', () => {
    let s = snapshot();
    s = applyEvent(s, { type: 'queue.item_requested', item: item('a') });
    s = applyEvent(s, { type: 'queue.item_approved', itemId: 'a' });
    s = applyEvent(s, { type: 'karaoke.spotlight', itemId: 'a', claims: [ana, ben] });
    expect(s.karaoke).toEqual({ spotlightItemId: 'a', paused: false, pausedUntilEpochMs: null });
    expect(s.queue[0]?.karaokeClaims).toEqual([ana, ben]);
  });

  it('karaoke.spotlight null clears the spotlight and any stale pause', () => {
    let s = snapshot();
    s = applyEvent(s, { type: 'karaoke.spotlight', itemId: 'a', claims: [ana] });
    s = applyEvent(s, { type: 'karaoke.paused', itemId: 'a', untilEpochMs: 1_700_000_030_000 });
    s = applyEvent(s, { type: 'karaoke.spotlight', itemId: null, claims: [] });
    expect(s.karaoke).toEqual({ spotlightItemId: null, paused: false, pausedUntilEpochMs: null });
  });

  it('a NEW spotlight drops the previous pause; re-broadcasting the same one keeps it', () => {
    let s = snapshot();
    s = applyEvent(s, { type: 'karaoke.spotlight', itemId: 'a', claims: [ana] });
    s = applyEvent(s, { type: 'karaoke.paused', itemId: 'a', untilEpochMs: 1_700_000_030_000 });
    const same = applyEvent(s, { type: 'karaoke.spotlight', itemId: 'a', claims: [ana] });
    expect(same.karaoke).toEqual({
      spotlightItemId: 'a',
      paused: true,
      pausedUntilEpochMs: 1_700_000_030_000,
    });
    const moved = applyEvent(s, { type: 'karaoke.spotlight', itemId: 'b', claims: [ben] });
    expect(moved.karaoke).toEqual({
      spotlightItemId: 'b',
      paused: false,
      pausedUntilEpochMs: null,
    });
  });

  it('karaoke.paused sets paused + deadline and binds the spotlight item', () => {
    const s = applyEvent(snapshot(), {
      type: 'karaoke.paused',
      itemId: 'a',
      untilEpochMs: 1_700_000_030_000,
    });
    expect(s.karaoke).toEqual({
      spotlightItemId: 'a',
      paused: true,
      pausedUntilEpochMs: 1_700_000_030_000,
    });
  });

  it('karaoke.resumed clears the pause but keeps the spotlight', () => {
    let s = snapshot();
    s = applyEvent(s, { type: 'karaoke.spotlight', itemId: 'a', claims: [ana] });
    s = applyEvent(s, { type: 'karaoke.paused', itemId: 'a', untilEpochMs: 1_700_000_030_000 });
    s = applyEvent(s, { type: 'karaoke.resumed', itemId: 'a' });
    expect(s.karaoke).toEqual({ spotlightItemId: 'a', paused: false, pausedUntilEpochMs: null });
  });

  it('tolerates snapshots from older servers that lack the karaoke field', () => {
    const legacy = snapshot() as { karaoke?: unknown };
    delete legacy.karaoke;
    const base = legacy as ReturnType<typeof snapshot>;
    expect(
      applyEvent(base, { type: 'karaoke.spotlight', itemId: 'a', claims: [] }).karaoke,
    ).toEqual({ spotlightItemId: 'a', paused: false, pausedUntilEpochMs: null });
    expect(applyEvent(base, { type: 'karaoke.resumed', itemId: 'a' }).karaoke).toEqual({
      spotlightItemId: null,
      paused: false,
      pausedUntilEpochMs: null,
    });
    expect(
      applyEvent(base, { type: 'karaoke.paused', itemId: 'a', untilEpochMs: 5 }).karaoke,
    ).toEqual({ spotlightItemId: 'a', paused: true, pausedUntilEpochMs: 5 });
  });
});

describe('applyEvent — purity', () => {
  it('does not mutate the input snapshot', () => {
    const s = snapshot();
    const before = JSON.stringify(s);
    applyEvent(s, { type: 'queue.item_requested', item: item('a') });
    expect(JSON.stringify(s)).toBe(before);
  });

  it('does not mutate the input snapshot on karaoke claim events', () => {
    let s = snapshot();
    s = applyEvent(s, { type: 'queue.item_requested', item: item('a') });
    const before = JSON.stringify(s);
    applyEvent(s, {
      type: 'karaoke.claim_added',
      itemId: 'a',
      claim: { guestId: 'g', displayName: 'N' },
    });
    expect(JSON.stringify(s)).toBe(before);
  });
});
