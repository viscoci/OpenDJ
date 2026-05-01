---
'@opendj/backend': minor
---

Add the guest identity + slot system: `/api/v1/guest/{identity,heartbeat,slot}` plus the data layer + service that drives them.

**New repositories** (interface + InMemory + Drizzle):

- `SessionRepository` — `findById` / `findByQrSlug`
- `GuestRepository` — `findBySessionAndFingerprint` / `create` / `linkUser`
- `GuestSlotRepository` — `findBySessionAndFingerprint` / `findBySlotToken` / `countByStatus` / `create` / `touchHeartbeat` / `setStatus` / `delete` / `findActiveStaleSince` (sweep) / `findFirstQueued` (promotion)
- `FingerprintPriorityRepository` — `find` (filters by `expiresAt`) / `upsert` (`onConflictDoUpdate` keyed on `(fingerprintHash, sessionId)`) / `delete`

**`GuestIdentityService`** (`@opendj/backend/guest/GuestIdentityService.ts`):

- `computeStoredHash(eventSlug, fingerprintHash, now)` = `SHA-256(eventSlug + isoDateUTC(now) + fingerprintHash)` — server-side salting per event per UTC day; tests verify different fingerprints / events / days all produce different hashes
- `issueIdentity({ eventSlug, fingerprintHash })`:
  - Validates the session exists and hasn't ended (throws `SessionNotFoundError` 404 / `SessionEndedError` 410)
  - Returns existing slot + refreshes heartbeat on repeat calls (same browser, same day)
  - Honors `fingerprint_priority` re-entries: immediate promotion when room exists, `priority_queued` when cap is full
  - Respects `effectiveGuestCap` from `@opendj/core` (free tier capped at 12, OSS/paid unlimited, `session.guestCapOverride` wins)
  - Lazily creates the corresponding `guests` row exactly once per `(session, storedHash)` pair
- `heartbeat(slotToken)` — bumps `lastHeartbeat`; throws on unknown token
- `getSlot(slotToken)` — lookup-only

**Routes** (`@opendj/backend/routes/guest.ts`):

- `POST /identity` — Valibot-validated body (`fingerprintHash`, `eventSlug`); 400 invalid_body, 404 session_not_found, 410 session_ended, 200 with `{ slotToken, status, queuePosition?, guestId, sessionId }`
- `POST /heartbeat` — bearer slot-token auth; 401 missing / unknown_slot_token; 200 with `{ status, queuePosition? }`
- `GET /slot` — bearer slot-token auth; 401 missing / unknown; 200 with `{ status, queuePosition?, sessionId }`

**27 new tests** (161 total in backend) — service-level (computeStoredHash invariants, issueIdentity happy + repeat refresh + cap → queued + priority happy + priority full → priority_queued + lazy guest create + every error path, heartbeat happy/unknown, getSlot happy/unknown) and route-level (every status code path for all three endpoints).
