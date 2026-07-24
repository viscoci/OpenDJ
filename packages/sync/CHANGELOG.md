# @opendj/sync

## 0.1.0

### Minor Changes

- [`e921030`](https://github.com/viscoci/OpenDJ/commit/e92103056952c6c73d328d95790169b87ea678b9) Thanks [@viscoci](https://github.com/viscoci)! - Land `@opendj/sync` timing primitives.

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

### Patch Changes

- [`3b33536`](https://github.com/viscoci/OpenDJ/commit/3b3353675c3c39740b68d674ca53799b616cd737) Thanks [@viscoci](https://github.com/viscoci)! - Land `@opendj/lyrics` foundation: types, LRC parser, LRCLIB adapter, lookup-key normalization, sync-cue conversion, and lyric-window helper.

  **Types** (mirrors `lyrics_cache` + `lyrics_feedback` schema):
  - `LyricsProvider`, `LyricsLookupInput`, `LyricsLine`, `LyricsDocument`, `LyricsMatchConfidence`, `LyricsProviderId`
  - `LyricsFeedbackKind` (`wrong_song` | `bad_timing` | `wrong_line` | `missing_lyrics` | `offensive_or_bad_content` | `other`) + `LyricsFeedbackInput`

  **Lookup-key normalization:**
  - `normalizeLookup(input)` lowercases, collapses whitespace/underscores, strips `(feat. X)` / `(Remastered 2011)` / `[Live]` / `(Remix)` noise, ASCII-fies curly quotes, rounds duration to seconds, uppercases ISRC
  - `lookupCacheKey(normalized)` produces stable cross-provider cache keys (omits `providerTrackUri` so the same track from Spotify or Apple Music hits the same entry)

  **LRC parser:**
  - `parseLrc(raw)` handles `[mm:ss]`, `[mm:ss.xx]`, `[mm:ss.xxx]` timestamps; multiple timestamps per line; left-aligns 1-digit fractions; sorts ascending; chains `endsAtMs` to next line; recognizes and skips LRC metadata tags (`ar`, `ti`, `al`, `length`, `offset`, etc.); preserves empty silence beats

  **LRCLIB adapter** (`@opendj/lyrics/providers`):
  - `LrclibAdapter implements LyricsProvider` — fetch-based (works in Node + Workers + browsers); never throws; returns `null`/`[]` on network errors / non-OK responses / parse failures so playback never blocks on lyrics
  - `getBestMatch` calls `/api/get` (high confidence), `search` calls `/api/search` (medium); duration sent in seconds; `albumName` optional; sends descriptive `User-Agent`; configurable `baseUrl` (trailing-slash-tolerant); preserves attribution on every document

  **Sync integration:**
  - `lyricsDocumentToSyncCues(doc)` converts synced lines to `SyncCue<LyricsLine>` with `kind: 'lyric'`; drops lines without `startsAtMs`; preserves `endsAtMs` when present
  - `getActiveLyricWindow(position, doc, prevCount=1, nextCount=2)` returns chronological lines around the active position; clamps cleanly at start/end; before-first-line returns upcoming context

  **49 unit tests** covering normalization edge cases, LRC parsing variants, LRCLIB adapter happy/error paths with mocked fetch, sync-cue conversion, and active-window clamping.

- [#13](https://github.com/viscoci/OpenDJ/pull/13) [`8515474`](https://github.com/viscoci/OpenDJ/commit/8515474c33598c56b824e7d9b2562ecfe8d1fe83) Thanks [@viscoci](https://github.com/viscoci)! - Publish metadata: tarballs now resolve `main`/`types`/`exports` from `dist/` via `publishConfig`; `@opendj/db` tarballs include `migrations/*.sql`.

- [`f865239`](https://github.com/viscoci/OpenDJ/commit/f865239b7a7d4e86e9f80a333ece0f3fc9a92d8e) Thanks [@viscoci](https://github.com/viscoci)! - Land `@opendj/realtime` room contracts.

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

- Updated dependencies [[`945b5cc`](https://github.com/viscoci/OpenDJ/commit/945b5cceec0e92cb9a9a875fb0e03cc43dca4b7d), [`cc9a8a1`](https://github.com/viscoci/OpenDJ/commit/cc9a8a18bc793664ca556bcc5cc8cccb91912694), [`ce9853a`](https://github.com/viscoci/OpenDJ/commit/ce9853aa966b9aee3a76e364ced9d5585e2fa80b), [`8314674`](https://github.com/viscoci/OpenDJ/commit/8314674f1ce0bbbcc214b5b8d619e43be01f8b15), [`1ab1006`](https://github.com/viscoci/OpenDJ/commit/1ab100680c03b2e2954c0118e7780f8605d19e86), [`3b33536`](https://github.com/viscoci/OpenDJ/commit/3b3353675c3c39740b68d674ca53799b616cd737), [`8515474`](https://github.com/viscoci/OpenDJ/commit/8515474c33598c56b824e7d9b2562ecfe8d1fe83), [`f865239`](https://github.com/viscoci/OpenDJ/commit/f865239b7a7d4e86e9f80a333ece0f3fc9a92d8e), [`e921030`](https://github.com/viscoci/OpenDJ/commit/e92103056952c6c73d328d95790169b87ea678b9)]:
  - @opendj/core@0.1.0
