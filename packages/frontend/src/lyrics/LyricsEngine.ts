/**
 * LyricsEngine — framework-free lyric display state.
 *
 * Feed it realtime events (or the initial snapshot); poll `computeState()` on
 * your own cadence (rAF / interval). It interpolates playback position locally
 * from the latest `playback.clock_sampled` via `predictPlaybackPosition` —
 * the server intentionally never streams per-line ticks.
 */
import { predictPlaybackPosition, type PlaybackClockSample } from '@opendj/sync';
import type { LyricsDocument, LyricsLine } from '@opendj/lyrics';
import type { SessionEvent, SessionSnapshot } from '@opendj/realtime';

export type LyricsMode = 'loading' | 'synced' | 'unsynced' | 'none' | 'paused';

export interface LyricsEngineState {
  mode: LyricsMode;
  trackUri: string | null;
  activeLine: LyricsLine | null;
  prevLines: LyricsLine[];
  nextLines: LyricsLine[];
  plainText: string | null;
  normalizedProgress: number;
}

const EMPTY: LyricsEngineState = {
  mode: 'loading',
  trackUri: null,
  activeLine: null,
  prevLines: [],
  nextLines: [],
  plainText: null,
  normalizedProgress: 0,
};

export class LyricsEngine {
  private readonly nowEpochMs: () => number;
  private readonly prevCount: number;
  private readonly nextCount: number;
  private sample: PlaybackClockSample | null = null;
  /** undefined = not looked up yet (loading); null = looked up, no match. */
  private lyricsByUri: { uri: string; doc: LyricsDocument | null } | undefined;

  constructor(opts: { nowEpochMs?: () => number; prevCount?: number; nextCount?: number } = {}) {
    this.nowEpochMs = opts.nowEpochMs ?? Date.now;
    this.prevCount = opts.prevCount ?? 2;
    this.nextCount = opts.nextCount ?? 2;
  }

  applySnapshot(s: Pick<SessionSnapshot, 'lyrics' | 'playbackClock' | 'nowPlaying'>): void {
    if (s.playbackClock) this.sample = s.playbackClock;
    if (s.nowPlaying && s.lyrics !== undefined && s.lyrics !== null) {
      this.lyricsByUri = { uri: s.nowPlaying.uri, doc: s.lyrics };
    }
  }

  applyEvent(event: SessionEvent): void {
    switch (event.type) {
      case 'playback.clock_sampled': {
        const prevUri = this.sample?.trackUri;
        this.sample = event.sample;
        // Track changed: stale lyrics no longer apply.
        if (prevUri && prevUri !== event.sample.trackUri) {
          if (this.lyricsByUri && this.lyricsByUri.uri !== event.sample.trackUri) {
            this.lyricsByUri = undefined;
          }
        }
        break;
      }
      case 'lyrics.loaded':
        // Only adopt lyrics for the track we're currently clocking (or if we
        // have no clock yet, adopt optimistically — the next sample confirms).
        if (!this.sample || this.sample.trackUri === event.trackUri) {
          this.lyricsByUri = { uri: event.trackUri, doc: event.lyrics };
        }
        break;
      case 'now_playing.updated':
        if (event.track === null) {
          this.sample = null;
          this.lyricsByUri = undefined;
        }
        break;
      default:
        break;
    }
  }

  computeState(): LyricsEngineState {
    if (!this.sample) return EMPTY;
    const pos = predictPlaybackPosition(this.sample, this.nowEpochMs());
    const base: Omit<
      LyricsEngineState,
      'mode' | 'activeLine' | 'prevLines' | 'nextLines' | 'plainText'
    > = {
      trackUri: this.sample.trackUri,
      normalizedProgress: pos.normalizedProgress,
    };
    const lyricsEntry =
      this.lyricsByUri && this.lyricsByUri.uri === this.sample.trackUri
        ? this.lyricsByUri
        : undefined;

    if (lyricsEntry === undefined) {
      return { ...EMPTY, ...base, mode: 'loading' };
    }
    if (lyricsEntry.doc === null) {
      return { ...EMPTY, ...base, mode: 'none' };
    }
    const doc = lyricsEntry.doc;
    const timed = doc.lines.filter(
      (l): l is LyricsLine & { startsAtMs: number } => typeof l.startsAtMs === 'number',
    );
    if (!doc.isSynced || timed.length === 0) {
      return {
        ...EMPTY,
        ...base,
        mode: this.sample.isPlaying ? 'unsynced' : 'paused',
        plainText: doc.plainText ?? doc.lines.map((l) => l.text).join('\n'),
      };
    }
    // Active = last timed line whose start is <= predicted progress.
    let activeIdx = -1;
    for (let i = 0; i < timed.length; i += 1) {
      if (timed[i]!.startsAtMs <= pos.progressMs) activeIdx = i;
      else break;
    }
    const activeLine = activeIdx >= 0 ? timed[activeIdx]! : null;
    const prevLines =
      activeIdx > 0 ? timed.slice(Math.max(0, activeIdx - this.prevCount), activeIdx) : [];
    const nextLines = timed.slice(activeIdx + 1, activeIdx + 1 + this.nextCount);
    return {
      ...base,
      mode: this.sample.isPlaying ? 'synced' : 'paused',
      activeLine,
      prevLines,
      nextLines,
      plainText: null,
    };
  }
}
