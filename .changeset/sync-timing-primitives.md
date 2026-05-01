---
'@opendj/sync': minor
'@opendj/core': patch
---

Land `@opendj/sync` timing primitives.

**Types:**

- `PlaybackClockSample` — provider sample + wall-clock timestamp + confidence
- `PredictedPlaybackPosition` — extrapolated position with normalized progress + confidence
- `SyncCue<TPayload>` discriminated by `kind` (`lyric` | `lighting` | `visual` | `custom`)
- `SongSyncAdapter<TCue>` interface for lyrics / lighting / visualizer adapters

**Helpers:**

- `createPlaybackClockSample(nowPlaying, sampledAtEpochMs, options?)` — clamps progress, captures providerLatencyMs / confidence overrides
- `predictPlaybackPosition(sample, nowEpochMs)` — handles paused tracks (no advance), clock skew (elapsed=0), end-of-track clamp; confidence decays with sample age and never exceeds the source sample's confidence
- `normalizeProgress(progressMs, durationMs)` — clamps to [0..1], returns 0 for zero/negative duration
- `findActiveCues(positionMs, cues)` — start inclusive, end exclusive; open-ended cues stay active
- `findUpcomingCues(positionMs, cues, windowMs)` — strict bounds on both sides; empty for non-positive window
- `clamp(value, min, max)` — exported for adapter authors

**34 unit tests** covering normalization edge cases, prediction with paused/clock-skew/end-of-track conditions, confidence decay, and cue boundary semantics.

`@opendj/core` is bumped patch because `@opendj/sync` declares it as a workspace dep — no runtime change to core itself.
