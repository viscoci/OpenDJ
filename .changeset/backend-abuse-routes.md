---
'@opendj/backend': minor
---

Add `AbuseModerationService` + abuse routes (`summary`, `block-guest`, `unblock-guest`).

**`AbuseSubjectRepository` + `ActionEventRepository`** (interface + InMemory + Drizzle):

- `AbuseSubjectRepository`: `findByHash`, `findActiveForSession(sessionId, statuses?)` (filters expired), `upsert` (with risk score serialization), `delete`
- `ActionEventRepository`: `create`, `countByKindSince(sessionId, since)` (Drizzle uses `count(*)` group-by; in-memory walks the array)

**`AbuseModerationService`** (`@opendj/backend/abuse/AbuseModerationService.ts`):

- `blockGuest({ sessionId, accountId, subjectHash, reason?, expiresAt?, byUserId })` — upserts the abuse_subjects row to `status: 'blocked'`, optionally time-bound; records an `abuse_blocked` action event with the host as `userId`
- `unblockGuest({ sessionId, accountId, subjectHash, byUserId })` — deletes the row + records `abuse_unblocked`; throws `session_mismatch` if subject belongs to another session; idempotent for unknown subjects (still records the event for audit consistency)
- `summary({ sessionId, statuses?, windowMs?, nowEpochMs? })` — returns active subjects (excludes expired) + recent `action_events` counts grouped by `event_kind`; default window 30 minutes

**Routes** (`@opendj/backend/routes/abuse.ts`):

- `GET /api/v1/sessions/:id/abuse/summary` — `requireClaim('queue:moderate')`
- `POST /api/v1/sessions/:id/abuse/block-guest` — Valibot body (`subjectHash`, optional `reason` ≤500, optional `expiresAtEpochMs`); 200 with `{ subject }`
- `POST /api/v1/sessions/:id/abuse/unblock-guest` — Valibot body (`subjectHash`); 200 ok; 400 `session_mismatch`

Wired into `createApp` at `/api/v1/sessions/:id/abuse`. `createDeps` instantiates `AbuseModerationService` from the new repositories.

**8 new tests** (213 total in backend) covering blockGuest event recording + time-bound expiry, unblockGuest happy + session_mismatch + idempotent-unknown, summary active-only filtering + status filter + expiry filter + recent event counts.
