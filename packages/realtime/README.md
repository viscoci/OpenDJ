# @opendj/realtime

Runtime-neutral realtime contracts. The same interface drives the OSS in-process `NodeSessionRoom` and the hosted Cloudflare Durable Object `SessionRoom` (in `opendj-live`).

Contents (planned — see [`docs/agent-brief.md`](../../docs/agent-brief.md) §"Realtime and caching architecture"):

- `RealtimeRoom` interface (`connect`, `disconnect`, `getSnapshot`, `publish`, `mutate`)
- `SessionSnapshot` type (now-playing, playback clock, lyrics, queue summary, pending, active guest count)
- `SessionEvent` discriminated union (queue, now-playing, skip-vote, guest-slot, playback clock, lyrics, sync cue events)
- `SessionCommand` for serialized queue mutations
- Helpers for snapshot diffing and event replay

Postgres remains the durable source of truth; the room is the realtime source of truth while a session is live.
