# @opendj/db

Drizzle ORM schema, base migrations, and query helpers shared between OSS and the hosted product.

Contents (planned — see [`docs/agent-brief.md`](../../docs/agent-brief.md) §"Database schema"):

- `users`, `accounts`, `account_memberships`, `auth_identities`, `password_credentials`, `auth_sessions`
- `provider_connections`, `oauth_states`
- `sessions`, `guests`, `queue_items`, `session_events`, `outbox_events`
- `guest_slots`, `fingerprint_priority`
- `lyrics_cache`, `lyrics_feedback`
- `action_events`, `abuse_subjects`

Hosted-only `subscriptions` and private analytics tables live in `opendj-live`.

Adapter: Postgres.js (Workers + Node compatible). Avoid `node-postgres`.
