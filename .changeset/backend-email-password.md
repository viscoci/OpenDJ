---
'@opendj/backend': minor
---

Add `Argon2idPasswordHasher` (Node) + `EmailPasswordService` + `/api/v1/auth/email/{register,login}` routes.

**`Argon2idPasswordHasher`** (`@opendj/backend/auth/Argon2idPasswordHasher.ts`):

- Implements `PasswordHasher` from `@opendj/auth`
- Uses the `argon2` native module via dynamic import — listed under `optionalDependencies` so Workers consumers can install backend without the native binary
- OWASP 2024 defaults: memoryCost = 64 MiB, timeCost = 3, parallelism = 1
- `verifyPassword` returns `false` (no throw) on malformed or non-argon2id hashes — keeps the route layer's branching simple
- `needsRehash` parses the `$argon2id$v=...$m=...,t=...,p=...` parameter block and returns true when current params differ; also true for unrecognized algorithms (forces re-hash on legacy bcrypt etc.)
- Exposes `algorithm = 'argon2id'` for `password_credentials.hash_algorithm`

**`EmailPasswordService`** (`@opendj/backend/auth/EmailPasswordService.ts`):

- `register({ email, password, displayName? })` — lowercases email, checks both `users.primary_email` and `auth_identities` for collision, creates user + identity + password credential, immediately issues a session
- `login({ email, password })` — same generic `invalid_credentials` shape for unknown email / no credential / wrong password (no existence leak); 5 failed attempts = 15-minute account lock; success resets the counter
- Constant-ish work on the unknown-email path (verifies against a dummy hash) to keep timing similar to the cred-found path
- Email verification + password reset flows are scoped out (need an email-sending adapter); schema is ready

**Routes** (`@opendj/backend/routes/emailAuth.ts`):

- `POST /register` — Valibot body (`email`, `password` 8–200, optional `displayName` ≤120); 201 with `Set-Cookie: __Host-opendj_session=...`; 409 `email_taken`; 400 invalid body
- `POST /login` — Valibot body (`email`, `password` 1–200); 200 with cookie; 401 `invalid_credentials`; 423 `account_locked`

**`createDeps`:**

- Default `passwordHasher = new Argon2idPasswordHasher()`; override via `options.passwordHasher` (Workers will pass a WASM-backed impl)
- `emailPasswordService` wired in and exposed on `AppDeps`

**Wired into `createApp`** at `/api/v1/auth/email`.

**18 new tests** (238 total in backend) — Argon2idPasswordHasher hash/verify/needsRehash matrix against real argon2, EmailPasswordService register collision detection, login invalid_credentials uniformity, lockout after 5 failures, counter reset on success.
