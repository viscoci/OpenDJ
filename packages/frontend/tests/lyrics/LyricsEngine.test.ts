import { describe, expect, it } from 'vitest';
import { LyricsEngine } from '../../src/lyrics/LyricsEngine.js';
import type { LyricsDocument } from '@opendj/lyrics';

const doc = (over: Partial<LyricsDocument> = {}): LyricsDocument => ({
  id: 'd1',
  source: 'lrclib',
  trackName: 'A',
  artistName: 'B',
  isSynced: true,
  matchConfidence: 'high',
  lines: [
    { id: 'l1', text: 'line one', startsAtMs: 0, endsAtMs: 5000 },
    { id: 'l2', text: 'line two', startsAtMs: 5000, endsAtMs: 10000 },
    { id: 'l3', text: 'line three', startsAtMs: 10000, endsAtMs: 15000 },
    { id: 'l4', text: 'line four', startsAtMs: 15000 },
  ],
  ...over,
});
const sample = (progressMs: number, isPlaying = true, sampledAtEpochMs = 1_000_000) => ({
  providerId: 'spotify',
  trackUri: 'spotify:track:aaa',
  durationMs: 200_000,
  progressMs,
  isPlaying,
  sampledAtEpochMs,
  confidence: 'high' as const,
});

function engineAt(nowMs: number) {
  return new LyricsEngine({ nowEpochMs: () => nowMs });
}

describe('LyricsEngine', () => {
  it('is loading before lyrics arrive for the playing track', () => {
    const e = engineAt(1_000_000);
    e.applyEvent({ type: 'playback.clock_sampled', sample: sample(1000) });
    expect(e.computeState().mode).toBe('loading');
  });

  it('highlights the active line and windows prev/next in synced mode', () => {
    const e = engineAt(1_002_000); // sample: progress 6000 at t=1_000_000; now +2s => predicted 8000
    e.applyEvent({ type: 'playback.clock_sampled', sample: sample(6000) });
    e.applyEvent({ type: 'lyrics.loaded', trackUri: 'spotify:track:aaa', lyrics: doc() });
    const s = e.computeState();
    expect(s.mode).toBe('synced');
    expect(s.activeLine?.id).toBe('l2'); // predicted 8000ms ∈ [5000,10000)
    expect(s.prevLines.map((l) => l.id)).toEqual(['l1']);
    expect(s.nextLines.map((l) => l.id)).toEqual(['l3', 'l4']);
  });

  it('does not advance while paused and reports paused mode', () => {
    const e = engineAt(1_050_000); // 50s later — but paused
    e.applyEvent({ type: 'playback.clock_sampled', sample: sample(6000, false) });
    e.applyEvent({ type: 'lyrics.loaded', trackUri: 'spotify:track:aaa', lyrics: doc() });
    const s = e.computeState();
    expect(s.mode).toBe('paused');
    expect(s.activeLine?.id).toBe('l2'); // frozen at 6000ms
  });

  it('reports unsynced mode with plainText when the doc is not synced', () => {
    const e = engineAt(1_000_000);
    e.applyEvent({ type: 'playback.clock_sampled', sample: sample(1000) });
    e.applyEvent({
      type: 'lyrics.loaded',
      trackUri: 'spotify:track:aaa',
      lyrics: doc({ isSynced: false, lines: [], plainText: 'all the words' }),
    });
    const s = e.computeState();
    expect(s.mode).toBe('unsynced');
    expect(s.plainText).toBe('all the words');
  });

  it('reports none for an instrumental track even though a doc was returned', () => {
    const e = engineAt(1_000_000);
    e.applyEvent({ type: 'playback.clock_sampled', sample: sample(1000) });
    e.applyEvent({
      type: 'lyrics.loaded',
      trackUri: 'spotify:track:aaa',
      lyrics: doc({ isSynced: false, lines: [], isInstrumental: true, plainText: '' }),
    });
    expect(e.computeState().mode).toBe('none');
  });

  it('reports none for an unsynced doc with no lines and empty plain text', () => {
    const e = engineAt(1_000_000);
    e.applyEvent({ type: 'playback.clock_sampled', sample: sample(1000) });
    e.applyEvent({
      type: 'lyrics.loaded',
      trackUri: 'spotify:track:aaa',
      lyrics: doc({ isSynced: false, lines: [], plainText: '' }),
    });
    expect(e.computeState().mode).toBe('none');
  });

  it('reports none when lyrics.loaded carried null', () => {
    const e = engineAt(1_000_000);
    e.applyEvent({ type: 'playback.clock_sampled', sample: sample(1000) });
    e.applyEvent({ type: 'lyrics.loaded', trackUri: 'spotify:track:aaa', lyrics: null });
    expect(e.computeState().mode).toBe('none');
  });

  it('drops lyrics for a different track and returns to loading on track change', () => {
    const e = engineAt(1_000_000);
    e.applyEvent({ type: 'playback.clock_sampled', sample: sample(1000) });
    e.applyEvent({ type: 'lyrics.loaded', trackUri: 'spotify:track:zzz', lyrics: doc() });
    expect(e.computeState().mode).toBe('loading'); // zzz lyrics ignored for aaa
  });

  it('seeds from an initial snapshot', () => {
    const e = engineAt(1_001_000);
    e.applySnapshot({
      nowPlaying: {
        uri: 'spotify:track:aaa',
        name: 'A',
        artist: 'B',
        albumArt: null,
        durationMs: 200_000,
        progressMs: 6000,
        isPlaying: true,
        zoneId: 'z',
      },
      playbackClock: sample(6000),
      lyrics: doc(),
    });
    expect(e.computeState().mode).toBe('synced');
  });

  it('reports none when a snapshot carries null lyrics for the playing track', () => {
    const e = engineAt(1_001_000);
    e.applySnapshot({
      nowPlaying: {
        uri: 'spotify:track:aaa',
        name: 'A',
        artist: 'B',
        albumArt: null,
        durationMs: 200_000,
        progressMs: 6000,
        isPlaying: true,
        zoneId: 'z',
      },
      playbackClock: sample(6000),
      lyrics: null,
    });
    expect(e.computeState().mode).toBe('none');
  });

  it('interpolates word progress across the active line by char weight', () => {
    // line l2: 'line two' — words ['line','two'], chars 4+3=7, window [5000,10000) => 5000ms
    // 'line' occupies [5000, 5000+5000*4/7≈7857); 'two' the rest
    const e = engineAt(1_000_000);
    e.applyEvent({ type: 'playback.clock_sampled', sample: sample(6000) }); // in 'line'
    e.applyEvent({ type: 'lyrics.loaded', trackUri: 'spotify:track:aaa', lyrics: doc() });
    const wp = e.computeState().wordProgress!;
    expect(wp.words).toEqual(['line', 'two']);
    expect(wp.activeWordIndex).toBe(0);
    expect(wp.activeWordFraction).toBeCloseTo((6000 - 5000) / (5000 * (4 / 7)), 2);
  });

  it('advances to the second word later in the window', () => {
    const e = engineAt(1_003_000); // sample at 6000 taken t=1_000_000 → predicted 9000: inside 'two'
    e.applyEvent({ type: 'playback.clock_sampled', sample: sample(6000) });
    e.applyEvent({ type: 'lyrics.loaded', trackUri: 'spotify:track:aaa', lyrics: doc() });
    const wp = e.computeState().wordProgress!;
    expect(wp.activeWordIndex).toBe(1);
    expect(wp.activeWordFraction).toBeGreaterThan(0);
    expect(wp.activeWordFraction).toBeLessThanOrEqual(1);
  });

  it('setOffsetMs shifts line selection later', () => {
    const e = engineAt(1_000_000);
    e.applyEvent({ type: 'playback.clock_sampled', sample: sample(5200) }); // just inside l2
    e.applyEvent({ type: 'lyrics.loaded', trackUri: 'spotify:track:aaa', lyrics: doc() });
    expect(e.computeState().activeLine?.id).toBe('l2');
    e.setOffsetMs(500); // lyrics later: effective 4700 → back in l1
    expect(e.computeState().activeLine?.id).toBe('l1');
    expect(e.computeState().normalizedProgress).toBeCloseTo(5200 / 200_000, 5); // unaffected
  });

  it('wordProgress is null in unsynced and none modes', () => {
    const e = engineAt(1_000_000);
    e.applyEvent({ type: 'playback.clock_sampled', sample: sample(1000) });
    e.applyEvent({
      type: 'lyrics.loaded',
      trackUri: 'spotify:track:aaa',
      lyrics: doc({ isSynced: false, lines: [], plainText: 'x' }),
    });
    expect(e.computeState().wordProgress).toBeNull();
  });
});
