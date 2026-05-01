---
'@opendj/db': minor
'@opendj/core': patch
---

Land the full Drizzle schema for OpenDJ OSS — 19 tables across 7 domain files.

**Schema files** (`@opendj/db/schema`):

- `users.ts` — `users` (UUID + bigserial publicUserId + email + status)
- `accounts.ts` — `accounts`, `account_memberships` (composite PK, claims array)
- `auth.ts` — `auth_identities`, `password_credentials`, `auth_sessions`, `oauth_states`
- `providers.ts` — `provider_connections` (music/service OAuth, distinct from login identities)
- `sessions.ts` — `sessions`, `guests`, `queue_items`, `session_events`, `outbox_events`, `guest_slots`, `fingerprint_priority` (composite PK)
- `lyrics.ts` — `lyrics_cache`, `lyrics_feedback`
- `abuse.ts` — `action_events`, `abuse_subjects`

**Client:**

- `createDb(connectionString, options?)` factory backed by `postgres.js` (Node + Cloudflare Workers compatible — explicitly NOT `node-postgres`, which is incompatible with Workers)
- `Database` type alias for typed Drizzle client
- `schema` namespace export for query helpers

**Inferred row + insert types** exported for every table (`UserRow`, `UserInsert`, etc.) so backend services can type their inputs/outputs without re-deriving.

**drizzle-kit config** at `drizzle.config.ts` ready to generate migrations once schema stabilizes (`pnpm --filter @opendj/db db:generate`).

**What's NOT in this package** (per the OSS/hosted boundary in `docs/REPO_BOUNDARY.md`): `subscriptions` and private hosted analytics dashboards — those live in the private `opendj-live` repo. `action_events` and `abuse_subjects` ARE included here because abuse prevention is core product safety, not business analytics.

9 tests covering schema-shape inference and client/schema export surface.
