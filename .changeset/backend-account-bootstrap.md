---
'@opendj/auth': minor
'@opendj/backend': minor
---

Account bootstrap on register/login — a freshly-created user now lands with a personal account + owner membership so they can immediately create sessions, connect providers, and moderate queues.

**`@opendj/auth`**: adds `MembershipRole` type + `claimsForRole(role)` helper. Default claim sets:

- `owner`: full account control (account/session/queue/provider/billing)
- `admin`: account+session+queue+provider, no billing
- `host`: session+queue+playback, no account management
- `member`: read-only

**`@opendj/backend`**:

- `AccountService.bootstrapPersonalAccount({ userId, displayNameHint })` — idempotent. Creates an account (with a slug derived from the hint, disambiguated against collisions) + an owner membership. Returning users get their existing membership reused.
- `AccountRepository.create` and `MembershipRepository.upsert` added to both in-memory and Drizzle implementations.
- `EmailPasswordService.register` now takes an optional `accountService` dep; when wired, it bootstraps a personal account for the new user and sets `currentAccountId` on the issued session so the session arrives "host-ready" with the right claims snapshot.
- `LoginAuthService.complete` does the same on first login via any provider (Google, etc.). Idempotent across provider re-logins.
- `createDeps` constructs `AccountService` and wires it into both auth services by default. Exposed on `AppDeps.accountService` for routes/tests.

**Why this matters**: without account bootstrap, `POST /api/v1/sessions` always 403'd for fresh users (no `session:create` claim). The brief assumes every user has at least their own personal account; this closes that gap.

**11 new tests** (272 total in backend) — `AccountService` slug uniqueness/sanitization/idempotence/missing-account recovery; `EmailPasswordService.register` bootstrap+back-compat; `LoginAuthService.complete` first-login bootstrap + returning-user idempotence.
