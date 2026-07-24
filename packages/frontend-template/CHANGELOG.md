# @opendj/frontend-template

## 0.2.0

### Minor Changes

- [#15](https://github.com/viscoci/OpenDJ/pull/15) [`395d51e`](https://github.com/viscoci/OpenDJ/commit/395d51e07bd5091094ecc8d8f294e914d378ef63) Thanks [@viscoci](https://github.com/viscoci)! - Lyrics sync end-to-end: the now-playing poller broadcasts `playback.clock_sampled` each tick and `lyrics.loaded` on track change (cache-fronted LRCLIB lookup, null on miss, stale-result guard); new framework-free `LyricsEngine` in @opendj/frontend computes karaoke display state client-side via `predictPlaybackPosition`; TV view gains a karaoke panel and the guest page a collapsible live-lyrics card; `LyricsApi` fixed to the real lookup contract.

### Patch Changes

- Updated dependencies [[`395d51e`](https://github.com/viscoci/OpenDJ/commit/395d51e07bd5091094ecc8d8f294e914d378ef63)]:
  - @opendj/frontend@0.2.0
  - @opendj/realtime@0.1.1

## 0.1.0

### Minor Changes

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

- [`76c5543`](https://github.com/viscoci/OpenDJ/commit/76c5543c54316f322f170f17291cad17a3c4aba3) Thanks [@viscoci](https://github.com/viscoci)! - Replace the Angular CLI placeholder with a real OpenDJ guest experience.

  **Routes**
  - `/` — landing card with the brand gradient + GitHub link
  - `/u/:slug` — the **guest request page**: resolves the session by `qrSlug`, fingerprints the device, acquires a slot token via `/sessions/:id/guest/identity`, lists the live queue, and posts new requests via `x-slot-token`. Subscribes to `/sessions/:id/realtime` so the queue refreshes when other guests request, hosts moderate, or playback advances.

  **MVP scope**: the request form takes a Spotify URI + track name + artist by hand. A real search picker layers on once the backend exposes a `/sessions/:id/search` proxy route — punted to a follow-up commit so this slice ships behind a working API.

  **Building blocks**
  - `OpenDjClientService` (`services/opendj-client.service.ts`) — singleton wrapping `OpenDjClient`. Exposes `client` + a reactive `unauthorized` signal flipped on the first 401. `API_BASE_URL` `InjectionToken` lets tests / Storybook / Capacitor builds override the origin (default `''` → relative paths, which is what the dev server proxy expects).
  - `getOrCreateGuestFingerprint` (`services/guest-fingerprint.ts`) — `localStorage`-backed 128-bit hex string. SSR-safe (placeholder when `localStorage` is unreachable). Backend salts + hashes server-side; we never send anything PII.
  - Two route components: `LandingPage`, `GuestRequestPage`. Standalone, OnPush, signals only — no Zone.js (`provideZonelessChangeDetection` already wired).

  **Build verified**: `ng build` produces a 256 kB raw / 68 kB gzip initial bundle. Workspace `@opendj/frontend` resolves through esbuild's pnpm symlink walk — no extra `paths` aliasing needed.

  **Out of scope here**
  - Search picker (waits on backend `/search` route)
  - Host dashboard (next slice)
  - Capacitor build target wiring (template is Capacitor-ready but `npx cap add ios|android` is left to downstream consumers)
  - Login UI for the host flow

### Patch Changes

- Updated dependencies [[`945b5cc`](https://github.com/viscoci/OpenDJ/commit/945b5cceec0e92cb9a9a875fb0e03cc43dca4b7d), [`84b3724`](https://github.com/viscoci/OpenDJ/commit/84b37246eca4a0641beec5a2bd8c345498b90f13), [`cc9a8a1`](https://github.com/viscoci/OpenDJ/commit/cc9a8a18bc793664ca556bcc5cc8cccb91912694), [`1d1c3c4`](https://github.com/viscoci/OpenDJ/commit/1d1c3c42008866731e02152e9d247b0931e91010), [`ce9853a`](https://github.com/viscoci/OpenDJ/commit/ce9853aa966b9aee3a76e364ced9d5585e2fa80b), [`8314674`](https://github.com/viscoci/OpenDJ/commit/8314674f1ce0bbbcc214b5b8d619e43be01f8b15), [`1ab1006`](https://github.com/viscoci/OpenDJ/commit/1ab100680c03b2e2954c0118e7780f8605d19e86), [`870fcda`](https://github.com/viscoci/OpenDJ/commit/870fcda883ece85cc3bbbb95e60767e20aa10149), [`c8e1a29`](https://github.com/viscoci/OpenDJ/commit/c8e1a291d0b373b890581ca5e105a33c1f35bf07), [`e5336c3`](https://github.com/viscoci/OpenDJ/commit/e5336c35f8a4630893a354c0306d6d383c727c58), [`3b33536`](https://github.com/viscoci/OpenDJ/commit/3b3353675c3c39740b68d674ca53799b616cd737), [`8515474`](https://github.com/viscoci/OpenDJ/commit/8515474c33598c56b824e7d9b2562ecfe8d1fe83), [`d6d91a4`](https://github.com/viscoci/OpenDJ/commit/d6d91a44fad63e2ec69bc6dcbaf283ade16fec0f), [`f865239`](https://github.com/viscoci/OpenDJ/commit/f865239b7a7d4e86e9f80a333ece0f3fc9a92d8e), [`e921030`](https://github.com/viscoci/OpenDJ/commit/e92103056952c6c73d328d95790169b87ea678b9)]:
  - @opendj/core@0.1.0
  - @opendj/app-shell@0.1.0
  - @opendj/frontend@0.1.0
  - @opendj/realtime@0.1.0
