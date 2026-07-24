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

export interface LyricsWordProgress {
  /** Active line split on whitespace, original order. */
  words: string[];
  /** 0-based; word currently being sung. */
  activeWordIndex: number;
  /** 0..1 progress through the active word. */
  activeWordFraction: number;
}

export interface LyricsEngineState {
  mode: LyricsMode;
  trackUri: string | null;
  activeLine: LyricsLine | null;
  prevLines: LyricsLine[];
  nextLines: LyricsLine[];
  plainText: string | null;
  normalizedProgress: number;
  /** Non-null only in 'synced'/'paused' mode with an active timed line that has words. */
  wordProgress: LyricsWordProgress | null;
}

const EMPTY: LyricsEngineState = {
  mode: 'loading',
  trackUri: null,
  activeLine: null,
  prevLines: [],
  nextLines: [],
  plainText: null,
  normalizedProgress: 0,
  wordProgress: null,
};

/**
 * Split a timed line's text into per-word sub-ranges of `[line.startsAtMs, end)`,
 * weighted by each word's character length, and locate `effectiveProgressMs`
 * within them.
 */
function computeWordProgress(
  line: LyricsLine & { startsAtMs: number },
  end: number,
  effectiveProgressMs: number,
): LyricsWordProgress | null {
  const words = line.text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return null;
  const totalChars = words.reduce((sum, w) => sum + w.length, 0);
  const windowMs = Math.max(0, end - line.startsAtMs);
  const clampedProgressMs = Math.max(line.startsAtMs, effectiveProgressMs);

  let cursor = line.startsAtMs;
  for (let i = 0; i < words.length; i += 1) {
    const wordDurationMs = totalChars > 0 ? windowMs * (words[i]!.length / totalChars) : 0;
    const wordEnd = i === words.length - 1 ? line.startsAtMs + windowMs : cursor + wordDurationMs;
    if (clampedProgressMs < wordEnd || i === words.length - 1) {
      const fraction =
        wordEnd > cursor
          ? (clampedProgressMs - cursor) / (wordEnd - cursor)
          : i === words.length - 1
            ? 1
            : 0;
      return {
        words,
        activeWordIndex: i,
        activeWordFraction: Math.min(1, Math.max(0, fraction)),
      };
    }
    cursor = wordEnd;
  }
  // Unreachable: the final iteration always returns.
  return { words, activeWordIndex: words.length - 1, activeWordFraction: 1 };
}

export class LyricsEngine {
  private readonly nowEpochMs: () => number;
  private readonly prevCount: number;
  private readonly nextCount: number;
  private sample: PlaybackClockSample | null = null;
  /** undefined = not looked up yet (loading); null = looked up, no match. */
  private lyricsByUri: { uri: string; doc: LyricsDocument | null } | undefined;
  /** Positive ms shifts lyrics LATER relative to predicted playback position. */
  private offsetMs = 0;

  constructor(opts: { nowEpochMs?: () => number; prevCount?: number; nextCount?: number } = {}) {
    this.nowEpochMs = opts.nowEpochMs ?? Date.now;
    this.prevCount = opts.prevCount ?? 2;
    this.nextCount = opts.nextCount ?? 2;
  }

  /** Set the lyrics offset in ms. Default 0. Positive shifts lyrics later. */
  setOffsetMs(ms: number): void {
    this.offsetMs = ms;
  }

  applySnapshot(s: Pick<SessionSnapshot, 'lyrics' | 'playbackClock' | 'nowPlaying'>): void {
    if (s.playbackClock) this.sample = s.playbackClock;
    if (s.nowPlaying) {
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
      'mode' | 'activeLine' | 'prevLines' | 'nextLines' | 'plainText' | 'wordProgress'
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
      const plainText = doc.plainText ?? doc.lines.map((l) => l.text).join('\n');
      // Instrumental tracks and docs with nothing to show render an empty
      // "unsynced" panel otherwise — treat both as no lyrics at all.
      if (doc.isInstrumental === true || plainText.trim().length === 0) {
        return { ...EMPTY, ...base, mode: 'none' };
      }
      return {
        ...EMPTY,
        ...base,
        mode: this.sample.isPlaying ? 'unsynced' : 'paused',
        plainText,
      };
    }
    // Offset lyrics against predicted progress: positive offsetMs shifts
    // lyrics LATER, so we subtract it before line/word selection. Raw
    // normalizedProgress (in `base`) is untouched — it drives the progress bar.
    const effectiveProgressMs = Math.max(0, pos.progressMs - this.offsetMs);
    // Active = last timed line whose start is <= effective progress.
    let activeIdx = -1;
    for (let i = 0; i < timed.length; i += 1) {
      if (timed[i]!.startsAtMs <= effectiveProgressMs) activeIdx = i;
      else break;
    }
    const activeLine = activeIdx >= 0 ? timed[activeIdx]! : null;
    const prevLines =
      activeIdx > 0 ? timed.slice(Math.max(0, activeIdx - this.prevCount), activeIdx) : [];
    const nextLines = timed.slice(activeIdx + 1, activeIdx + 1 + this.nextCount);
    const wordProgress = activeLine
      ? computeWordProgress(
          activeLine,
          activeLine.endsAtMs ?? timed[activeIdx + 1]?.startsAtMs ?? activeLine.startsAtMs + 4000,
          effectiveProgressMs,
        )
      : null;
    return {
      ...base,
      mode: this.sample.isPlaying ? 'synced' : 'paused',
      activeLine,
      prevLines,
      nextLines,
      plainText: null,
      wordProgress,
    };
  }
}
