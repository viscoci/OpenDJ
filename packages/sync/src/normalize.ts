/**
 * Pure, allocation-free clamp/normalize helpers used by clock prediction and
 * cue helpers.
 */

/** Clamp `value` into the inclusive range `[min, max]`. */
export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Convert raw playback progress to a [0..1] normalized value.
 *
 * - Returns 0 if `durationMs <= 0` (avoids divide-by-zero / NaN). This is the
 *   correct value for tracks with unknown duration: nothing has progressed
 *   "into" a zero-length track.
 * - Negative `progressMs` clamps to 0; over-duration clamps to 1.
 */
export function normalizeProgress(progressMs: number, durationMs: number): number {
  if (durationMs <= 0) return 0;
  if (!Number.isFinite(progressMs)) return 0;
  return clamp(progressMs / durationMs, 0, 1);
}
