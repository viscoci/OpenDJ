---
'@opendj/backend': minor
---

Add `SessionService` + `/api/v1/sessions/*` routes.

**SessionRepository (interface + InMemory + Drizzle):**

- `create` / `update` / `end` (idempotent — only sets `endedAt` when null) / `findByAccount`
- Drizzle `update` skips the SQL UPDATE when no fields change (returns `findById`)
- Drizzle `end` uses `WHERE endedAt IS NULL` so a second call doesn't clobber the original timestamp

**SessionService** (`@opendj/backend/session/SessionService.ts`):

- `create({ accountId, name, qrSlug?, ... })` — defaults from `@opendj/core` constants (`DEFAULT_SONGS_PER_GUEST_CAP = 3`, voteSkipMode `fixed`, threshold 5); auto-generates a 12-char URL-safe slug when omitted; throws `qr_slug_taken` on collision
- `getById(id, requireAccountId?)` — `requireAccountId` enforces same-account access; throws `session_not_found` / `account_mismatch`
- `update({ id, accountId, ...partial })` — gates on `account_mismatch` and `session_ended` (won't mutate ended sessions)
- `end(id, accountId)` — idempotent; second call returns the original `endedAt`
- `listForAccount(accountId)` — host dashboard read

**Routes** (`@opendj/backend/routes/session.ts`):

- `POST /` — `requireClaim('session:create')`; Valibot-validated body; 201 with the session; 409 `qr_slug_taken`; 400 `no_active_account`
- `GET /:id` — public (any guest with the QR slug can hydrate); 404 `session_not_found`
- `PATCH /:id` — `requireClaim('session:update')`; partial body; 403 `account_mismatch`, 409 `session_ended`
- `DELETE /:id` — `requireClaim('session:end')`; idempotent; returns the (possibly already-ended) session
- `GET /` — `requireAuth`; lists current account's sessions for the host dashboard

**15 new tests** (189 total in backend) covering creation defaults + slug collision + per-create overrides, getById with/without account requirement, partial update + cross-account refusal + ended-session refusal, end idempotency, listForAccount filter.
