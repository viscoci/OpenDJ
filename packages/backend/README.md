# @opendj/backend

Hono-based route tree, services, and an explicit dependency graph (`deps.ts`) usable from both Node and Cloudflare Workers.

Contents (planned — see [`docs/agent-brief.md`](../../docs/agent-brief.md) §"Backend package directory structure"):

- `app.ts` — Hono app factory
- `deps.ts` — explicit dependency graph (no decorator DI)
- `auth/` — `AuthService`, `ClaimsService`, `PasswordService`, auth provider registry, middleware
- `abuse/` — abuse signal capture, risk scoring, rate limiting, middleware
- `providers/streaming/` — `StreamingRouter`, `providerRegistry`, Spotify / Soundtrack / Apple Music adapters
- `services/` — `GuestIdentityService`, `SlotManager`, `QueueService`, `SessionService`
- `routes/` — auth, sessions, queue, guest, moderation, provider, lyrics, realtime upgrade, health

Routes versioned under `/api/v1`. Future breaking changes go to `/api/v2` rather than mutating in place.
