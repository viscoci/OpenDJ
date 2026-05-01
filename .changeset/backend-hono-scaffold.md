---
'@opendj/backend': minor
---

Land the first slice of `@opendj/backend`: Hono app factory, runtime config parser, dependency-graph placeholder, and the `/api/v1/health` route.

**Config (`loadConfig(env)`):**

- Valibot-validated `Config` shape — `databaseUrl` (required URL), `baseUrl` (default `http://localhost:8888`), `maxSongsPerGuest`, `maxGuestsPerSession` (null = unlimited), `moderationEnabledDefault`, optional `valkeyUrl`, optional `spotify` block (only attached when `SPOTIFY_CLIENT_ID` + `SPOTIFY_CLIENT_SECRET` are both set; default redirect URI derived from `baseUrl`)
- `ConfigError` aggregates every validation issue at once
- Robust env parsing: integer/boolean/optional-integer fall back gracefully on empty or unparseable values

**Dependency graph (`createDeps(...)`):**

- `AppDeps` interface holds `config` + `db` (Database from `@opendj/db`)
- Subsequent slices add `AuthService`, `ClaimsService`, `StreamingRouter`, `GuestIdentityService`, `SlotManager`, `QueueService`, `SessionService`, `LyricsLookupService`, `RealtimeRoomRegistry`, `AbuseSignalService`, `RiskScoringService`, `RateLimitService`

**App factory (`createApp({ deps })`):**

- Hono app with routes mounted under `/api/v1` (versioned for future breaking changes)
- Returns the bare Hono instance — Node + Workers wire their adapter at the call site (`apps/oss-demo/src/main.ts` and `opendj-live/apps/api/src/worker.ts`)

**Routes:**

- `GET /api/v1/health` — liveness probe; `{ ok: true, service: 'opendj-backend' }`; intentionally does NOT touch the database (a DB blip shouldn't fail the probe)

**15 tests** covering config parsing edge cases (missing required, empty integers, fallbacks, Spotify partial config, custom redirect URI, valkey passthrough), `ConfigError` shape, and Hono app routing (versioned 404 vs root 404, JSON shape).

This is the integration foundation — auth/queue/provider/realtime/lyrics/abuse routes land in subsequent commits, each gated by its own slice of services in `deps.ts`.
