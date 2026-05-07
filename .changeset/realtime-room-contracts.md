---
'@opendj/realtime': minor
'@opendj/core': patch
'@opendj/sync': patch
'@opendj/lyrics': patch
---

Land `@opendj/realtime` room contracts.

**Interface:**

- `RealtimeRoom` — runtime-neutral interface implemented by `NodeSessionRoom` (Node deploys) and implementable by a Cloudflare Durable Object `SessionRoom` actor on Workers deploys
- Methods: `connect(client)` / `disconnect(clientId)` / `getSnapshot()` / `publish(event)` / `mutate<T>(command)`

**Types:**

- `RealtimeClient` + `RealtimeClientKind` (`guest` | `host` | `tv` | `service`)
- `SessionSnapshot` composing `nowPlaying` (core), `playbackClock` (sync), `lyrics` + `activeLyricsWindow` (lyrics), `queue` + `pending` (QueueItemSummary), guest counts, snapshot timestamp
- `QueueItemSummary` + `toQueueItemSummary(item)` projection — broadcast-safe shape that omits `sessionId` and converts Dates to epoch ms
- `SessionEvent` discriminated union: queue lifecycle, now-playing, skip-vote, guest-slot, playback clock + correction, lyrics loaded/feedback, sync cue window, session ended
- `SessionCommand` discriminated union: enqueue, moderate, remove_item, cast_skip_vote, set_now_playing, sample_playback_clock, record_lyrics_feedback, end_session

**Helpers:**

- `createEmptySnapshot(sessionId, nowEpochMs)` for room boot + tests; allocates fresh arrays per call
- `isEventOfType(event, type)` / `isCommandOfType(cmd, type)` — discriminated narrowing
- `isQueueEvent` / `isPlaybackEvent` / `isLyricsEvent` — bucket helpers for room dispatch tables; partition the queue/playback/lyrics events disjointly

High-frequency progress ticks are intentionally NOT in `SessionEvent` — clients interpolate locally from the most recent `playback.clock_sampled` event using `predictPlaybackPosition` from `@opendj/sync`.

15 unit tests covering projection, narrowing, snapshot construction, and event-bucket disjointness.
