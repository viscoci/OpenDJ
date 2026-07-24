# @opendj/frontend

## 0.2.0

### Minor Changes

- [#15](https://github.com/viscoci/OpenDJ/pull/15) [`395d51e`](https://github.com/viscoci/OpenDJ/commit/395d51e07bd5091094ecc8d8f294e914d378ef63) Thanks [@viscoci](https://github.com/viscoci)! - Lyrics sync end-to-end: the now-playing poller broadcasts `playback.clock_sampled` each tick and `lyrics.loaded` on track change (cache-fronted LRCLIB lookup, null on miss, stale-result guard); new framework-free `LyricsEngine` in @opendj/frontend computes karaoke display state client-side via `predictPlaybackPosition`; TV view gains a karaoke panel and the guest page a collapsible live-lyrics card; `LyricsApi` fixed to the real lookup contract.

### Patch Changes

- Updated dependencies [[`395d51e`](https://github.com/viscoci/OpenDJ/commit/395d51e07bd5091094ecc8d8f294e914d378ef63)]:
  - @opendj/realtime@0.1.1

## 0.1.0

### Minor Changes

- [`1d1c3c4`](https://github.com/viscoci/OpenDJ/commit/1d1c3c42008866731e02152e9d247b0931e91010) Thanks [@viscoci](https://github.com/viscoci)! - Add `/api/v1/sessions/:id/search?q=...&limit=...` — track search proxied through the session's connected streaming provider.

  **Why**

  The guest request page currently makes guests type a Spotify URI by hand. That's MVP-acceptable for proving the round-trip but a non-starter for real users. The search proxy is the missing piece between "host connected Spotify" and "guest picks a track."

  **Backend (`@opendj/backend`)**
  - New route mounted at `/api/v1/sessions/:id/search`. Public — no auth or slot token required (guests need to search to make requests).
  - Resolves the session, picks the first connected provider on its account, type-guards for `supportsSearch`, and forwards the query.
  - Status code matrix:
    - 200 — `{ results: [{ trackUri, trackName, artistName, albumArtUrl, durationMs }], providerId }`
    - 400 `invalid_query` — missing/blank `q`, or `limit` outside 1..50
    - 404 `session_not_found` / `session_ended`
    - 501 `search_not_supported` — provider connected but doesn't implement search (e.g. AppleMusic stub). Type guard prevents the call from happening.
    - 502 `provider_error` — search failed at the provider edge
    - 503 `no_provider_connected` — account has no streaming provider linked

  **Frontend (`@opendj/frontend`)**
  - `client.queue.search(sessionId, query, limit?)` returns `SearchResponse`.

  **Tests**
  - 6 new backend tests using a hand-rolled `MockSearchProvider` (implements `IStreamingProvider + ISupportsSearch`) plus a `NoSearchProvider` for the 501 path. No real Spotify calls, no fixtures from real APIs.

- [`870fcda`](https://github.com/viscoci/OpenDJ/commit/870fcda883ece85cc3bbbb95e60767e20aa10149) Thanks [@viscoci](https://github.com/viscoci)! - Add typed `OpenDjClient` (covers auth / sessions / queue / guest / lyrics) and `RealtimeClient` (WebSocket subscriber for `SessionEvent`s with auto-reconnect).

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

- [#13](https://github.com/viscoci/OpenDJ/pull/13) [`c8e1a29`](https://github.com/viscoci/OpenDJ/commit/c8e1a291d0b373b890581ca5e105a33c1f35bf07) Thanks [@viscoci](https://github.com/viscoci)! - Add `AuthApi.requestPasswordReset(email)` and `AuthApi.resetPassword(token, newPassword)` for the email password-reset flow, and wire the template's login page (forgot-password mode) plus a new `/host/reset-password` page to them.

- [`e5336c3`](https://github.com/viscoci/OpenDJ/commit/e5336c35f8a4630893a354c0306d6d383c727c58) Thanks [@viscoci](https://github.com/viscoci)! - Host dashboard + multiple frontend↔backend wire-shape fixes.

  **Backend (`@opendj/backend`)**
  - `SessionService.getBySlug(qrSlug)` + `GET /api/v1/sessions/by-slug/:slug` route. Public read for the guest landing page.
  - `GET /api/v1/sessions` was already wired; this commit confirms the path lines up with the frontend client.

  **Frontend client (`@opendj/frontend`) — wire-shape corrections**

  These were latent mismatches from the first client cut, surfaced now that real components consume them:
  - Slot tokens go via `Authorization: Bearer <token>`, NOT `x-slot-token` (matches backend's `bearerFromAuthHeader`).
  - Guest identity lives at `/api/v1/guest/identity` (not under `/sessions/:id/...`) and takes `{ fingerprintHash, eventSlug }` (not `{ fingerprint, name }`).
  - Heartbeat at `/api/v1/guest/heartbeat`, slot token via Bearer.
  - `GuestIdentityResponse` now has `status: 'active' | 'queued' | 'priority_queued'` (matches `GuestSlotStatus`) instead of a `queued: boolean`. `queuePosition` is optional, present only when status isn't `'active'`.
  - `SessionsApi.end` uses `DELETE /:id` (matches backend's `app.delete('/:id', ...)`); previously used `POST /:id/end` which never matched a route.
  - `QueueApi.moderate` uses `PATCH /queue/:itemId` with `{ decision }` (matches backend); previously POSTed to `/queue/:itemId/moderate`.
  - `SessionsApi.listForCurrentAccount()` added.

  **Frontend template (`@opendj/frontend-template`) — host dashboard**

  Three new pages:
  - `/host/login` — email+password login OR register tab toggle, plus a "Sign in with Google" link to `/api/v1/auth/oauth/google/start`. Apple/Facebook absent (501 on the backend; surfacing a button that always errors is worse than no button).
  - `/host/dashboard` — lists current account's sessions, with a "Start a new session" form. Auto-redirects to the new session detail on success.
  - `/host/sessions/:id` — queue moderation surface. Approve/Reject buttons on `pending` items, end-session control, copyable guest URL. Subscribes to `/api/v1/sessions/:id/realtime` for live updates.

  Plus:
  - `AuthService` (signal-backed `state: 'unknown' | 'anonymous' | 'authenticated'`) + `hostGuard` `CanActivateFn` that redirects to `/host/login?redirectTo=...` on 401.
  - `getOrCreateGuestFingerprintHash()` now returns a SHA-256 of the local random — the raw value never leaves the device. The backend re-salts with `(eventSlug, isoDate)` before persistence.
  - Existing `GuestRequestPage` updated to the corrected guest identity contract.

  **Build**: `ng build` produces 286 kB raw / 74 kB gzip initial bundle (up from 256 kB / 68 kB; the 30 kB delta is the three new host pages).

  **Tests**: 4 new frontend client tests (Bearer slot-token forwarding, moderate PATCH path, guest identity body shape, heartbeat). Backend at 278 / frontend at 31 / template at 2 — all green.

### Patch Changes

- [#13](https://github.com/viscoci/OpenDJ/pull/13) [`8515474`](https://github.com/viscoci/OpenDJ/commit/8515474c33598c56b824e7d9b2562ecfe8d1fe83) Thanks [@viscoci](https://github.com/viscoci)! - Publish metadata: tarballs now resolve `main`/`types`/`exports` from `dist/` via `publishConfig`; `@opendj/db` tarballs include `migrations/*.sql`.

- Updated dependencies [[`945b5cc`](https://github.com/viscoci/OpenDJ/commit/945b5cceec0e92cb9a9a875fb0e03cc43dca4b7d), [`cc9a8a1`](https://github.com/viscoci/OpenDJ/commit/cc9a8a18bc793664ca556bcc5cc8cccb91912694), [`ce9853a`](https://github.com/viscoci/OpenDJ/commit/ce9853aa966b9aee3a76e364ced9d5585e2fa80b), [`8314674`](https://github.com/viscoci/OpenDJ/commit/8314674f1ce0bbbcc214b5b8d619e43be01f8b15), [`1ab1006`](https://github.com/viscoci/OpenDJ/commit/1ab100680c03b2e2954c0118e7780f8605d19e86), [`3b33536`](https://github.com/viscoci/OpenDJ/commit/3b3353675c3c39740b68d674ca53799b616cd737), [`8515474`](https://github.com/viscoci/OpenDJ/commit/8515474c33598c56b824e7d9b2562ecfe8d1fe83), [`d6d91a4`](https://github.com/viscoci/OpenDJ/commit/d6d91a44fad63e2ec69bc6dcbaf283ade16fec0f), [`f865239`](https://github.com/viscoci/OpenDJ/commit/f865239b7a7d4e86e9f80a333ece0f3fc9a92d8e), [`e921030`](https://github.com/viscoci/OpenDJ/commit/e92103056952c6c73d328d95790169b87ea678b9)]:
  - @opendj/core@0.1.0
  - @opendj/realtime@0.1.0
