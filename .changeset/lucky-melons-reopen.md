---
'@opendj/backend': minor
'@opendj/db': minor
'@opendj/frontend': minor
---

Session reuse + Spotify 429 hardening.

- Ended sessions release their QR slug: uniqueness is now a partial unique index scoped to active sessions (`sessions_qr_slug_active_unique`), so creating a new session with an ended session's slug works. Slug resolution (`findByQrSlug`, `GET /by-slug/:slug`) prefers the active session, falling back to the most recently started ended one.
- New `POST /api/v1/sessions/:id/reopen` clears `endedAt` so a host can resume an ended session on the original slug/QR (409 `qr_slug_taken` if a different active session claimed it). `client.sessions.reopen(sessionId)` on the frontend client; `session.reopened` audit action.
- `SpotifyApiError` now carries `retryAfterSec` parsed from Spotify's `Retry-After` header, and `NowPlayingPoller` honors it on 429 — extended penalty windows (tens of minutes) are waited out instead of re-triggering them every 60s.
- oss-demo: fixed infinite recursion in the SPA notFound fallback for non-GET unmatched requests.
