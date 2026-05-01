# @opendj/sync

Runtime-neutral song-timing primitives. Used by `@opendj/lyrics` and any adapter that needs approximate playback position (lyrics, lighting, visualizers, beat grids).

Contents (planned — see [`docs/agent-brief.md`](../../docs/agent-brief.md) §"Song synchronization architecture"):

- `PlaybackClockSample`, `PredictedPlaybackPosition`
- `SongSyncAdapter<TCue>` interface
- `SyncCue` discriminated union (`lyric` / `lighting` / `visual` / `custom`)
- Helpers: `createPlaybackClockSample`, `predictPlaybackPosition`, `normalizeProgress`, `findActiveCues`, `findUpcomingCues`

Does not promise frame-perfect or beat-perfect timing. Confidence decays with sample age; clients interpolate locally and accept correction events from the realtime room.
