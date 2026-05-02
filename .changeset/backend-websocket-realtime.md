---
'@opendj/backend': minor
---

Add WebSocket realtime — `/api/v1/sessions/:id/realtime` upgrade route + per-process `RoomRegistryImpl` that materializes `NodeSessionRoom`s on demand.

**`RoomRegistryImpl`** (`@opendj/backend/realtime/RoomRegistryImpl.ts`):

- Implements `RealtimeRoomManager` (extends `RealtimeRoomRegistry`)
- `forSession(id)` — read-only lookup (used by `QueueService` etc. to publish without creating)
- `ensureRoom(id)` — lazily creates a `NodeSessionRoom` on first call; idempotent
- `removeRoom(id)` — drops the entry (call on `session.ended`)
- `size()` — diagnostic count

**`realtimeRoutes(deps, upgradeWebSocket)`** (`@opendj/backend/routes/realtime.ts`):

- Adapter-agnostic — takes an `UpgradeWebSocket` helper from `@hono/node-ws` (Node) or Cloudflare's WebSocketPair (Workers)
- On connect: assigns a clientId, calls `room.connect`, subscribes a sender that JSON-stringifies every event, and sends an initial `{ type: '_snapshot', snapshot, sessionId }` payload so the client doesn't render blank until the next event
- On close: `room.disconnect(clientId)`
- No slot-token gate on the listener (queue is public to anyone with the QR slug); writes still gate via existing routes that publish to the room

**`createDeps`** grows:

- `realtime: 'in-process' | 'none'` option (default `'in-process'`) — when in-process, instantiates `RoomRegistryImpl` and exposes it as both `deps.rooms` (read-only view) and `deps.roomManager` (concrete manager)
- Hosted Cloudflare deploys pass their own DO-backed registry via `options.rooms` and leave `roomManager` null

**`createApp({ deps, upgradeWebSocket? })`:**

- Mounts `/api/v1/sessions/:id/realtime` only when both `upgradeWebSocket` is provided AND `deps.roomManager` is non-null
- All other routes work without the WS adapter

**`apps/oss-demo` wiring:**

- Adds `@hono/node-ws` dep
- `main.ts` calls `createNodeWebSocket({ app: tempApp })` for the upgrade helper, passes it to a real `createApp`, and `injectWebSocket(server)` after `serve()`
- Logs `WebSocket realtime ready at /api/v1/sessions/:id/realtime` on boot

**7 new tests** (220 total in backend) covering RoomRegistryImpl invariants — empty start, ensureRoom idempotency + per-session isolation, removeRoom (including unknown-id no-op), forSession ↔ ensureRoom identity. WS protocol-level tests deferred since they're adapter-specific (would need a live HTTP server + ws client per test).
