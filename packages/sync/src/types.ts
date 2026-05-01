/**
 * Runtime-neutral timing primitives for OpenDJ.
 *
 * See docs/agent-brief.md §"Song synchronization architecture".
 *
 * The OSS layer provides normalized timing primitives, prediction helpers, and
 * adapter interfaces. Concrete provider/integration implementations (DMX
 * lighting, beat-grid extraction, etc.) live elsewhere.
 */

import type { Track } from '@opendj/core';

/**
 * Confidence in a timing measurement. Reported by providers and decayed by
 * `predictPlaybackPosition` as samples age.
 */
export type SyncConfidence = 'low' | 'medium' | 'high';

/**
 * A single observation of provider playback state. Sampled from
 * `getNowPlaying()` (or equivalent) plus a wall-clock timestamp.
 */
export interface PlaybackClockSample {
  providerId: string;
  trackUri: string;
  durationMs: number;
  /** Provider-reported playback position at the moment of sampling. */
  progressMs: number;
  isPlaying: boolean;
  /** Wall-clock time at which `progressMs` was reported. Use Date.now() in browsers/Node. */
  sampledAtEpochMs: number;
  /**
   * Round-trip / API latency between the provider event and our sampling.
   * Used for confidence decay; optional because not every provider exposes it.
   */
  providerLatencyMs?: number;
  confidence: SyncConfidence;
}

/**
 * Extrapolated playback position for "right now". Clients call
 * `predictPlaybackPosition(sample, Date.now())` repeatedly to drive smooth
 * progress bars / lyric scrolling without flooding the realtime channel.
 */
export interface PredictedPlaybackPosition {
  trackUri: string;
  /** Predicted progressMs at predictedAtEpochMs. Clamped to [0, durationMs]. */
  progressMs: number;
  /** progressMs / durationMs, clamped to [0, 1]. */
  normalizedProgress: number;
  /** durationMs - progressMs, clamped to [0, durationMs]. */
  remainingMs: number;
  isPlaying: boolean;
  confidence: SyncConfidence;
  predictedAtEpochMs: number;
}

/**
 * A timed cue that fires during playback: a lyric line, a lighting scene
 * change, a visualizer beat hint, or any custom payload.
 *
 * Callers/consumers must keep cues sorted by `startsAtMs` for the active /
 * upcoming helpers to behave intuitively.
 */
export interface SyncCue<TPayload = unknown> {
  id: string;
  startsAtMs: number;
  /**
   * When `endsAtMs` is omitted, the cue is treated as active until the next
   * cue with the same `kind` starts. The active-cue helpers in `cues.ts`
   * intentionally do NOT compute that successor — callers can either provide
   * an explicit end or pre-process the cue list.
   */
  endsAtMs?: number;
  kind: 'lyric' | 'lighting' | 'visual' | 'custom';
  payload: TPayload;
}

/**
 * Adapter that maps a track to a cue stream. Concrete implementations include
 * the LRCLIB lyrics adapter (in `@opendj/lyrics`) and any third-party DMX /
 * visualizer integration.
 */
export interface SongSyncAdapter<TCue = SyncCue> {
  readonly adapterId: string;
  readonly displayName: string;
  canHandle(track: Track): boolean | Promise<boolean>;
  loadCues(track: Track): Promise<TCue[]>;
  getActiveCues(position: PredictedPlaybackPosition, cues: TCue[]): TCue[];
}
