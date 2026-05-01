/**
 * Playback clock sampling + extrapolation.
 *
 * See docs/agent-brief.md §"Song synchronization architecture" → "Prediction rules":
 *
 * - If `isPlaying` is false, do not advance `progressMs`.
 * - Clamp `progressMs` to `[0, durationMs]`.
 * - `normalizedProgress` is `progressMs / durationMs`, clamped to `[0, 1]`.
 * - Confidence decays as the sample gets older.
 * - Clients should interpolate locally and accept correction events from the room.
 * - Do not claim frame-perfect / beat-perfect synchronization without a
 *   dedicated integration that measures and corrects device latency.
 */

import type { NowPlayingTrack } from '@opendj/core';
import { clamp, normalizeProgress } from './normalize.js';
import type { PlaybackClockSample, PredictedPlaybackPosition, SyncConfidence } from './types.js';

/** Confidence ceilings imposed purely by sample age. */
const FRESH_THRESHOLD_MS = 2_000;
const STALE_THRESHOLD_MS = 10_000;

const CONFIDENCE_RANK: Record<SyncConfidence, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

const CONFIDENCE_BY_RANK: ReadonlyArray<SyncConfidence> = ['low', 'medium', 'high'];

function minConfidence(a: SyncConfidence, b: SyncConfidence): SyncConfidence {
  const rank = Math.min(CONFIDENCE_RANK[a], CONFIDENCE_RANK[b]);
  // rank is always 0|1|2 here; the `?? 'low'` is a defensive fallback for
  // future enum extensions and keeps the return type non-undefined under
  // noUncheckedIndexedAccess.
  return CONFIDENCE_BY_RANK[rank] ?? 'low';
}

function ageBasedConfidence(ageMs: number): SyncConfidence {
  if (ageMs <= FRESH_THRESHOLD_MS) return 'high';
  if (ageMs <= STALE_THRESHOLD_MS) return 'medium';
  return 'low';
}

/**
 * Snapshot a `NowPlayingTrack` at a wall-clock instant. The resulting sample
 * is what the rest of the sync helpers (and the realtime room) operate on.
 *
 * Initial confidence defaults to `medium` — providers should override via
 * the optional `confidence` arg if they have stronger or weaker signals.
 */
export function createPlaybackClockSample(
  input: NowPlayingTrack & { providerId?: string },
  sampledAtEpochMs: number,
  options: { confidence?: SyncConfidence; providerLatencyMs?: number; providerId?: string } = {},
): PlaybackClockSample {
  const providerId = options.providerId ?? input.providerId ?? 'unknown';
  const sample: PlaybackClockSample = {
    providerId,
    trackUri: input.uri,
    durationMs: input.durationMs,
    progressMs: clamp(input.progressMs, 0, input.durationMs),
    isPlaying: input.isPlaying,
    sampledAtEpochMs,
    confidence: options.confidence ?? 'medium',
  };
  if (options.providerLatencyMs !== undefined) {
    sample.providerLatencyMs = options.providerLatencyMs;
  }
  return sample;
}

/**
 * Extrapolate the sample to "right now". Clients should call this on every
 * animation frame / progress tick rather than expecting the realtime room to
 * push high-frequency progress events.
 *
 * Time-skew handling:
 * - `nowEpochMs < sampledAtEpochMs` (clock skew or out-of-order delivery):
 *   treats elapsed as 0 and reports the sample's progressMs as-is.
 * - `nowEpochMs >> sampledAtEpochMs` (very stale): confidence drops to `low`.
 *
 * Confidence is the minimum of the original sample's confidence and the
 * age-based ceiling, so a `low` sample never gets "promoted" by being fresh.
 */
export function predictPlaybackPosition(
  sample: PlaybackClockSample,
  nowEpochMs: number,
): PredictedPlaybackPosition {
  const elapsedMs = Math.max(0, nowEpochMs - sample.sampledAtEpochMs);
  const advancedProgressMs = sample.isPlaying ? sample.progressMs + elapsedMs : sample.progressMs;
  const progressMs = clamp(advancedProgressMs, 0, sample.durationMs);
  const remainingMs = clamp(sample.durationMs - progressMs, 0, sample.durationMs);
  const confidence = minConfidence(sample.confidence, ageBasedConfidence(elapsedMs));
  return {
    trackUri: sample.trackUri,
    progressMs,
    normalizedProgress: normalizeProgress(progressMs, sample.durationMs),
    remainingMs,
    isPlaying: sample.isPlaying,
    confidence,
    predictedAtEpochMs: nowEpochMs,
  };
}
