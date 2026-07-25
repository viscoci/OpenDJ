# @opendj/realtime

## 0.2.0

### Minor Changes

- [#19](https://github.com/viscoci/OpenDJ/pull/19) [`7584380`](https://github.com/viscoci/OpenDJ/commit/758438077f38e0d8e2822cc0fbacc891e8878d96) Thanks [@viscoci](https://github.com/viscoci)! - Karaoke mic queue: hosts configure karaoke mode (off/optional/required), mic count, and pause behavior per session; guests claim mics on queued songs (open to any guest, atomic request+claim, `required` mode enforces a claim); the now-playing poller spotlights the earliest claimed matching item and drives auto/manual pause with a wall-clock auto-resume deadline; new `karaoke.*` realtime events plus `karaokeClaims` on queue item summaries and a `karaoke` snapshot slice; `KaraokeApi` client (claim/removeClaim/pause/ready).

### Patch Changes

- Updated dependencies [[`7584380`](https://github.com/viscoci/OpenDJ/commit/758438077f38e0d8e2822cc0fbacc891e8878d96)]:
  - @opendj/core@0.3.0
  - @opendj/lyrics@0.1.2
  - @opendj/sync@0.1.2

## 0.1.2

### Patch Changes

- Updated dependencies [[`c4ba271`](https://github.com/viscoci/OpenDJ/commit/c4ba271813c9c2913d9b666e353bd1d47e09a46f)]:
  - @opendj/core@0.2.0
  - @opendj/lyrics@0.1.1
  - @opendj/sync@0.1.1

## 0.1.1

### Patch Changes

- [#15](https://github.com/viscoci/OpenDJ/pull/15) [`395d51e`](https://github.com/viscoci/OpenDJ/commit/395d51e07bd5091094ecc8d8f294e914d378ef63) Thanks [@viscoci](https://github.com/viscoci)! - Lyrics sync end-to-end: the now-playing poller broadcasts `playback.clock_sampled` each tick and `lyrics.loaded` on track change (cache-fronted LRCLIB lookup, null on miss, stale-result guard); new framework-free `LyricsEngine` in @opendj/frontend computes karaoke display state client-side via `predictPlaybackPosition`; TV view gains a karaoke panel and the guest page a collapsible live-lyrics card; `LyricsApi` fixed to the real lookup contract.

## 0.1.0

### Minor Changes

- [`d6d91a4`](https://github.com/viscoci/OpenDJ/commit/d6d91a44fad63e2ec69bc6dcbaf283ade16fec0f) Thanks [@viscoci](https://github.com/viscoci)! - Add `NodeSessionRoom` — the in-process `RealtimeRoom` implementation for Node deploys — plus the pure `applyEvent(snapshot, event)` transition that can be reused by a Cloudflare Durable Object `SessionRoom` actor on Workers deploys.

  **`applyEvent`** (pure):
  - Handles the full `SessionEvent` union: queue lifecycle (requested → approved/rejected/removed with status migration), now-playing updates (set/clear), playback clock samples (stored), playback corrections (advisory, no-op), skip-vote bumps (queue item), guest-slot counts, lyrics loaded (set/clear), lyrics feedback + cue-window updates (no-op write-side events), session ended (no-op).
  - Idempotent on already-approved items, no-ops on unknown ids, never mutates input.

  **`NodeSessionRoom`** implements `RealtimeRoom`:
  - In-memory `SessionSnapshot` (defaults to `createEmptySnapshot`; override with `initialSnapshot`)
  - `connect(client)` enforces `client.sessionId === room.sessionId`
  - `disconnect(clientId)` is idempotent (no-op for unknown ids)
  - `getSnapshot()` returns a structural copy so caller mutations can't leak into room state
  - `publish(event)` applies event → snapshot transition then fans out to subscribers; bumps `snapshot.snapshotAtEpochMs` after each publish
  - `subscribe(clientId, sender)` is the transport-agnostic bridge — both `@hono/node-ws` and Cloudflare Durable Object WebSockets satisfy the `EventSender` callback signature; throws when called before `connect`
  - Subscriber errors are caught + logged via `console.error` so one slow/failing client cannot block broadcasts to the rest of the room
  - `mutate(command)` throws "not implemented" in v1 — routes call `publish(event)` directly after their durable persistence step (a future commit adds a command-handler registry)
  - `setSnapshot(snapshot)` for boot-time rehydration after reading from Postgres

  **33 new tests** (48 total in `@opendj/realtime`) covering every event in `applyEvent`, immutability of input, the full `NodeSessionRoom` API (connect/disconnect/subscribe ordering, snapshot copy semantics, broadcast fanout, disconnected subscribers don't receive, error swallowing, snapshotAtEpochMs bump, `mutate` not-implemented assertion, `setSnapshot` rehydration).

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

### Patch Changes

- [#13](https://github.com/viscoci/OpenDJ/pull/13) [`8515474`](https://github.com/viscoci/OpenDJ/commit/8515474c33598c56b824e7d9b2562ecfe8d1fe83) Thanks [@viscoci](https://github.com/viscoci)! - Publish metadata: tarballs now resolve `main`/`types`/`exports` from `dist/` via `publishConfig`; `@opendj/db` tarballs include `migrations/*.sql`.

- Updated dependencies [[`945b5cc`](https://github.com/viscoci/OpenDJ/commit/945b5cceec0e92cb9a9a875fb0e03cc43dca4b7d), [`cc9a8a1`](https://github.com/viscoci/OpenDJ/commit/cc9a8a18bc793664ca556bcc5cc8cccb91912694), [`ce9853a`](https://github.com/viscoci/OpenDJ/commit/ce9853aa966b9aee3a76e364ced9d5585e2fa80b), [`8314674`](https://github.com/viscoci/OpenDJ/commit/8314674f1ce0bbbcc214b5b8d619e43be01f8b15), [`1ab1006`](https://github.com/viscoci/OpenDJ/commit/1ab100680c03b2e2954c0118e7780f8605d19e86), [`3b33536`](https://github.com/viscoci/OpenDJ/commit/3b3353675c3c39740b68d674ca53799b616cd737), [`8515474`](https://github.com/viscoci/OpenDJ/commit/8515474c33598c56b824e7d9b2562ecfe8d1fe83), [`f865239`](https://github.com/viscoci/OpenDJ/commit/f865239b7a7d4e86e9f80a333ece0f3fc9a92d8e), [`e921030`](https://github.com/viscoci/OpenDJ/commit/e92103056952c6c73d328d95790169b87ea678b9)]:
  - @opendj/core@0.1.0
  - @opendj/lyrics@0.1.0
  - @opendj/sync@0.1.0
