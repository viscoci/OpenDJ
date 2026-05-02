---
'@opendj/backend': minor
---

Wire `createApp` end-to-end. The Hono app factory now mounts every route written so far under `/api/v1`, and `createDeps` assembles the full service graph from a `Config` plus either a Drizzle `Database` or a pre-built `Repositories` instance.

**`AppDeps`** grows to include:

- `repositories` (the full `Repositories` aggregate)
- `authService`, `claimsService`, `guestIdentityService`, `sessionService`, `queueService`
- `streamingRouter` + `streamingProviderOAuthConfigs`
- `rooms: RealtimeRoomRegistry` (defaults to a no-op until WS lands)

**`createDeps(options)`:**

- Accepts either `db` (auto-builds Drizzle repositories) or `repositories` (test-provided in-memory)
- Throws when neither is supplied
- Default streaming `ProviderRegistry` wires `spotify` (full impl), `soundtrack` (stub), `apple-music` (stub)
- `fetchImpl` injectable so Workers can supply outbound bindings + tests stay offline
- Default `rooms` is a `forSession() => null` no-op — the WS slice swaps in a real `NodeSessionRoom`-per-session registry

**`createApp({ deps })`** mounts:

- `/api/v1/health`
- `/api/v1/auth/*` (`/me`, `/logout`, `/switch-account`)
- `/api/v1/guest/*` (`/identity`, `/heartbeat`, `/slot`)
- `/api/v1/sessions` + `/api/v1/sessions/:id` + `/api/v1/sessions/:id/queue/*`
- `/api/v1/provider/connections/:provider/{start,callback}`

**6 new tests** (195 total in backend) covering the wiring: health works after deps wire-up, every mounted route is reachable (return code asserted on the auth/validation gate), `createDeps` throws when missing both `db` and `repositories`, Spotify config flows through.
