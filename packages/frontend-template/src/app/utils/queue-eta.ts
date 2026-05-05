/**
 * Compute the rough wait time (in ms) before a queued track plays, based on
 * the host's actual playback queue plus what's currently playing.
 *
 * The model:
 *   - now-playing has `durationMs - displayProgressMs` left (clamped ≥ 0)
 *   - the provider queue is a flat ordered list; each item's wait =
 *     remaining-of-current + sum of preceding items' durations
 *   - tracks with null/undefined durationMs are ignored from the running
 *     total (we don't have a number to add)
 *
 * Returns a Map keyed by trackUri → ms-until-it-plays. When the same uri
 * appears multiple times in the queue, only the FIRST occurrence is
 * recorded (good enough for a "in queue, ~5 min" annotation on search
 * results).
 */

import type { NowPlayingTrack, Track } from '@opendj/core';

interface NowPlayingForEta {
  durationMs: number;
  progressMs: number;
  isPlaying: boolean;
  uri: string;
}

export function buildQueueEtaMs(
  nowPlaying: NowPlayingForEta | NowPlayingTrack | null,
  providerQueue: ReadonlyArray<Track>,
  /** Wall clock when nowPlaying.progressMs was sampled. Lets us interpolate. */
  nowPlayingSampledAtMs: number,
): Map<string, number> {
  const out = new Map<string, number>();
  let cursorMs = 0;

  if (nowPlaying && nowPlaying.durationMs > 0) {
    const elapsed = nowPlaying.isPlaying
      ? nowPlayingSampledAtMs > 0
        ? Math.max(0, Date.now() - nowPlayingSampledAtMs)
        : 0
      : 0;
    const liveProgress = Math.min(
      nowPlaying.durationMs,
      Math.max(0, nowPlaying.progressMs + elapsed),
    );
    const remaining = Math.max(0, nowPlaying.durationMs - liveProgress);
    cursorMs += remaining;
  }

  for (const track of providerQueue) {
    if (!out.has(track.uri)) {
      out.set(track.uri, cursorMs);
    }
    if (typeof track.durationMs === 'number' && track.durationMs > 0) {
      cursorMs += track.durationMs;
    }
  }

  return out;
}

/**
 * Format a wait-in-ms value for the UI.
 *   - <= 30s → "next up"
 *   - < 60s   → "<1 min"
 *   - < 60min → "~5 min"
 *   - else    → "~1h 12m"
 */
export function formatEta(ms: number): string {
  if (ms <= 30_000) return 'next up';
  if (ms < 60_000) return '<1 min';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `~${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem ? `~${hours}h ${rem}m` : `~${hours}h`;
}
