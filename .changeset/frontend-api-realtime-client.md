---
'@opendj/frontend': minor
---

Add typed `OpenDjClient` (covers auth / sessions / queue / guest / lyrics) and `RealtimeClient` (WebSocket subscriber for `SessionEvent`s with auto-reconnect).

**Why now**

Backend has a real `/api/v1` surface. Anything calling it — host dashboard, guest request page, agent tools, third-party integrations — needs typed access without re-implementing fetch plumbing per consumer.

**`OpenDjClient`** (`@opendj/frontend/api`) — framework-free TS class:

- `client.auth.{register, login, me, logout, switchAccount, oauthStartUrl}`
- `client.sessions.{getById, getBySlug, create, update, end}`
- `client.queue.{list, request, moderate, voteSkip}` — `request` + `voteSkip` carry the slot token via `x-slot-token`
- `client.guest.{identity, heartbeat}`
- `client.lyrics.{lookupByTrackUri, feedback}`

Transport (`HttpClient`) handles: base-URL composition, query encoding (drops nullish), JSON encode/decode, `__Host-` cookie forwarding, slot-token header injection, 204 → `undefined`, structured `ApiError` with `.code` + `.is(...)`, `NetworkError` for fetch failures, single-fire `onUnauthorized` hook for 401-driven redirects.

Wire types live in `api/types.ts` and mirror the backend's response envelopes (`{ session }`, `{ items }`, `{ item }`, etc.). Domain types (`QueueItemStatus`, `VoteSkipMode`, `Plan`) come from `@opendj/core` directly; timestamps land as ISO strings (Hono serializer).

**`RealtimeClient`** (`@opendj/frontend/realtime`) — WebSocket subscriber:

- `connect()` / `close()` lifecycle, exponential backoff with caps, `closedByCaller` suppresses reconnect
- `on(type, listener)` for typed handlers (`'queue.item_requested'`, `'now_playing.updated'`, `'session.ended'`, etc.) — listener receives the discriminated variant
- `onEvent` for catch-all
- `onOpen` / `onClose` / `onError` / `onStatus` for lifecycle observers
- Pluggable `webSocketImpl` (browser default `globalThis.WebSocket`; tests pass a mock)
- Resilient: bad JSON / non-`SessionEvent` payloads surface via `onError` without dropping the connection

**29 new tests** — `HttpClient` URL/query/body/slot-token/204/error/unauth matrix; per-resource URL+method+envelope unwrap (auth, sessions, queue, guest, lyrics); RealtimeClient connect/close/reconnect/typed-dispatch/unsubscribe/garbage-message handling.

Workspace deps added: `@opendj/core`, `@opendj/realtime`. Both already used by backend; this just makes the frontend's transitive use explicit.

Angular bindings (DI tokens, signal-wrapped subscriptions) layer on top in a follow-up commit — these foundations stay framework-free.
