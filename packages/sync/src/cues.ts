/**
 * Cue lookup helpers.
 *
 * Cues must be sorted ascending by `startsAtMs`. Helpers do NOT sort defensively
 * — that's the caller's responsibility (or the lyrics adapter's). Re-sorting
 * every call would dominate runtime once we have hundreds of cues per track.
 */

import type { SyncCue } from './types.js';

/**
 * A cue is active when its start has passed and either:
 * - it has an explicit `endsAtMs` greater than `positionMs`, OR
 * - it has no `endsAtMs` (open-ended; intended to be active until the next
 *   cue starts — see SyncCue's note).
 *
 * Multiple cues can overlap (e.g. concurrent lyric + lighting cues on the same
 * track). The helper returns all matches in input order.
 */
export function findActiveCues<T extends SyncCue>(positionMs: number, cues: T[]): T[] {
  const active: T[] = [];
  for (const cue of cues) {
    if (cue.startsAtMs > positionMs) continue;
    if (cue.endsAtMs !== undefined && cue.endsAtMs <= positionMs) continue;
    active.push(cue);
  }
  return active;
}

/**
 * Cues that haven't started yet but begin within `windowMs` from now. Useful
 * for "next lyric soon" glow effects and pre-loading lighting transitions.
 *
 * `windowMs` must be non-negative. A window of 0 returns an empty array
 * (nothing is upcoming when the window has zero width).
 */
export function findUpcomingCues<T extends SyncCue>(
  positionMs: number,
  cues: T[],
  windowMs: number,
): T[] {
  if (windowMs <= 0) return [];
  const horizon = positionMs + windowMs;
  const upcoming: T[] = [];
  for (const cue of cues) {
    if (cue.startsAtMs <= positionMs) continue;
    if (cue.startsAtMs >= horizon) continue;
    upcoming.push(cue);
  }
  return upcoming;
}
