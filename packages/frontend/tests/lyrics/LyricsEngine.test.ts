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
});
