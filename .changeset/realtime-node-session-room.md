---
'@opendj/realtime': minor
---

Add `NodeSessionRoom` — the in-process `RealtimeRoom` implementation for Node deploys — plus the pure `applyEvent(snapshot, event)` transition that can be reused by a Cloudflare Durable Object `SessionRoom` actor on Workers deploys.

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
