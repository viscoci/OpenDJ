# @opendj/db

## 0.1.0

### Minor Changes

- [`1ab1006`](https://github.com/viscoci/OpenDJ/commit/1ab100680c03b2e2954c0118e7780f8605d19e86) Thanks [@viscoci](https://github.com/viscoci)! - Land the full Drizzle schema for OpenDJ OSS — 19 tables across 7 domain files.

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

  **What's NOT in this package** (per `docs/REPO_BOUNDARY.md`): `subscriptions` and product/funnel analytics dashboards — those belong in downstream consumer migrations, not the foundation. `action_events` and `abuse_subjects` ARE included here because abuse prevention is core product safety, not business analytics.

  9 tests covering schema-shape inference and client/schema export surface.

- [`3e61666`](https://github.com/viscoci/OpenDJ/commit/3e6166682a272f1e206267923976a53206ac13a1) Thanks [@viscoci](https://github.com/viscoci)! - Email verification + password reset flows + drizzle-kit migration generation working.

  **Email flows (`@opendj/backend`)**
  - `EmailAdapter` interface with two implementations:
    - `ConsoleEmailAdapter` (default for OSS demo) — writes the email body to stdout so verification links surface during local testing without setting up SMTP.
    - `InMemoryEmailAdapter` (test) — captures every send to a list, exposing `lastFor(to)` / `all()` so tests can assert what went out.
  - `EmailVerificationService.requestVerification({ userId, email })` — issues a 32-byte hex token (SHA-256-hashed before storage), 24h TTL, single-use. Sends an email with the verify link. `verifyToken(token)` consumes it and sets `users.email_verified = true`.
  - `PasswordResetService` — same pattern, 1h TTL. `requestReset({ email })` is silent on unknown emails (no existence leak — the response is identical whether the email exists). `completeReset({ token, newPassword })` swaps the password and resets the failed-attempts counter on success. `requested_from_ip_hash` is captured on the token row for forensics.
  - New routes:
    - `POST /api/v1/auth/email/request-verification` (auth required)
    - `GET /api/v1/auth/email/verify?token=…` (public)
    - `POST /api/v1/auth/email/request-reset` (public)
    - `POST /api/v1/auth/email/reset` (public)

  **Schema (`@opendj/db`)**
  - `email_verification_tokens` and `password_reset_tokens` tables. Both store `token_hash` (PK) instead of the raw token, plus `(user_id, expires_at, consumed_at)`. The reset table also captures `requested_from_ip_hash`.

  **Drizzle migration generation — fixed**
  - drizzle-kit's CJS loader couldn't resolve our `.js` import specifiers (NodeNext convention) back to `.ts` source, blocking `pnpm db:generate`.
  - Fixed by wrapping invocation with `cross-env NODE_OPTIONS="--import tsx" drizzle-kit generate` — tsx hooks into Node's loader and handles the `.js`-to-`.ts` resolution. `cross-env` keeps the script Windows-friendly.
  - First successful migration generated: `migrations/0000_tranquil_terrax.sql` (21 tables — the original 19 plus the two new email-flow tables).

  **Tests**
  - 13 new backend tests using `InMemoryEmailAdapter`:
    - `EmailVerificationService`: request emits with token, single-use replay rejected, expired token rejected, unknown user → user_not_found, sets users.emailVerified=true on consume.
    - `PasswordResetService`: request emits when email exists, silent success when unknown, lowercases email, single-use, expired token rejected, password length validated, failed-attempts counter reset on success.

  Backend at **305 tests, all green**. Total workspace: 305 backend + 31 frontend + 2 template + others ≈ 600+ green.

### Patch Changes

- [`197df0f`](https://github.com/viscoci/OpenDJ/commit/197df0f67e61013b5f3a20b869cab6de74cd4e1e) Thanks [@viscoci](https://github.com/viscoci)! - Bump `drizzle-kit` to ^0.30 and switch `drizzle.config.ts` to an explicit per-table schema array.

  `drizzle-kit generate` still fails with `Cannot find module './users.js'` — drizzle-kit's bundled CJS loader can't resolve our ESM `.js` extensions in schema imports (verbatimModuleSyntax requires them; CJS resolution can't strip them to `.ts` source). This is a known incompatibility between drizzle-kit and ESM-with-explicit-extensions and isn't fixed by the version bump or the glob change.

  The first migration generation needs one of these workarounds (TBD in a follow-up commit):
  - Run drizzle-kit through a custom `tsx` wrapper that handles `.js` → `.ts` resolution
  - Generate from compiled `dist/` JS instead of TS source
  - Drop `verbatimModuleSyntax` for the db package and remove `.js` extensions

  Schema itself + the Drizzle runtime client (`createDb`) work correctly — only the kit's migration generator is affected. The boot wiring in `apps/oss-demo` is fully composable today.

- [#13](https://github.com/viscoci/OpenDJ/pull/13) [`8515474`](https://github.com/viscoci/OpenDJ/commit/8515474c33598c56b824e7d9b2562ecfe8d1fe83) Thanks [@viscoci](https://github.com/viscoci)! - Publish metadata: tarballs now resolve `main`/`types`/`exports` from `dist/` via `publishConfig`; `@opendj/db` tarballs include `migrations/*.sql`.

- Updated dependencies [[`945b5cc`](https://github.com/viscoci/OpenDJ/commit/945b5cceec0e92cb9a9a875fb0e03cc43dca4b7d), [`cc9a8a1`](https://github.com/viscoci/OpenDJ/commit/cc9a8a18bc793664ca556bcc5cc8cccb91912694), [`ce9853a`](https://github.com/viscoci/OpenDJ/commit/ce9853aa966b9aee3a76e364ced9d5585e2fa80b), [`8314674`](https://github.com/viscoci/OpenDJ/commit/8314674f1ce0bbbcc214b5b8d619e43be01f8b15), [`1ab1006`](https://github.com/viscoci/OpenDJ/commit/1ab100680c03b2e2954c0118e7780f8605d19e86), [`3b33536`](https://github.com/viscoci/OpenDJ/commit/3b3353675c3c39740b68d674ca53799b616cd737), [`8515474`](https://github.com/viscoci/OpenDJ/commit/8515474c33598c56b824e7d9b2562ecfe8d1fe83), [`f865239`](https://github.com/viscoci/OpenDJ/commit/f865239b7a7d4e86e9f80a333ece0f3fc9a92d8e), [`e921030`](https://github.com/viscoci/OpenDJ/commit/e92103056952c6c73d328d95790169b87ea678b9)]:
  - @opendj/core@0.1.0
