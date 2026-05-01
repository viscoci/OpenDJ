/**
 * Lyrics types shared by all OpenDJ lyrics adapters.
 *
 * See docs/agent-brief.md §"Lyrics and karaoke" + §"LRCLIB adapter".
 */

export type LyricsProviderId = 'lrclib' | (string & {});

export type LyricsMatchConfidence = 'low' | 'medium' | 'high';

export interface LyricsLookupInput {
  trackName: string;
  artistName: string;
  albumName?: string | null;
  durationMs?: number | null;
  /** Provider-native track URI (e.g. spotify:track:xxx). Optional, used as a cache key dimension. */
  providerTrackUri?: string;
  isrc?: string | null;
}

export interface LyricsLine {
  /** Stable per-document line ID. Adapters generate it (e.g. line index). */
  id: string;
  text: string;
  /**
   * Start time (ms from track start) for synchronized lyrics.
   * Omitted for unsynced documents.
   */
  startsAtMs?: number;
  /**
   * Optional end time. When omitted, the line is treated as active until the
   * next line's startsAtMs.
   */
  endsAtMs?: number;
}

export interface LyricsDocument {
  /** Internal document ID. Adapters typically use `${providerId}:${providerLyricsId}`. */
  id: string;
  source: LyricsProviderId;
  /** Provider-native lyrics ID (e.g. LRCLIB's numeric track ID). */
  providerLyricsId?: string | number;
  trackName: string;
  artistName: string;
  albumName?: string | null;
  durationMs?: number | null;
  isSynced: boolean;
  isInstrumental?: boolean;
  lines: LyricsLine[];
  /** Original LRC text (only present when isSynced && the source provided it). */
  rawLrc?: string;
  /** Plain-text fallback when synced not available (or alongside it). */
  plainText?: string;
  /** Human-readable attribution (e.g. "Lyrics from LRCLIB"). Required for UI display. */
  attribution?: string;
  matchConfidence: LyricsMatchConfidence;
}

export interface LyricsProvider {
  readonly providerId: LyricsProviderId;
  search(input: LyricsLookupInput): Promise<LyricsDocument[]>;
  getBestMatch(input: LyricsLookupInput): Promise<LyricsDocument | null>;
}

/** Feedback kinds. See LyricsFeedbackInput. */
export type LyricsFeedbackKind =
  | 'wrong_song'
  | 'bad_timing'
  | 'wrong_line'
  | 'missing_lyrics'
  | 'offensive_or_bad_content'
  | 'other';

export interface LyricsFeedbackInput {
  sessionId?: string;
  trackUri?: string;
  lyricsDocumentId?: string;
  kind: LyricsFeedbackKind;
  /** When kind === 'wrong_line' or 'bad_timing', the offending line. */
  lineId?: string;
  comment?: string;
}
