---
'@opendj/db': minor
'@opendj/backend': minor
---

Email verification + password reset flows + drizzle-kit migration generation working.

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
