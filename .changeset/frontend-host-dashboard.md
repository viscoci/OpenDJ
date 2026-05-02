---
'@opendj/backend': minor
'@opendj/frontend': minor
'@opendj/frontend-template': minor
---

Host dashboard + multiple frontend↔backend wire-shape fixes.

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
