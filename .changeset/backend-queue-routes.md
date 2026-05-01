---
'@opendj/backend': minor
---

Add `QueueService` + `/api/v1/sessions/:id/queue/*` routes — the core guest action surface.

**`QueueItemRepository`** (interface + InMemory + Drizzle):

- `findById` / `findAllForSession` (sorted by createdAt) / `create` / `setStatus` (with optional decidedAt) / `delete` / `incrementSkipVotes` (atomic)
- Drizzle `incrementSkipVotes` uses `sql\`${col} + 1\``+`RETURNING` for a single round-trip atomic increment

**`QueueService`** (`@opendj/backend/queue/QueueService.ts`):

- `requestTrack({ sessionId, slotToken, track })` — resolves slot → guest → session, validates via `canEnqueue` from `@opendj/core`, inserts with `pending` (when `moderationEnabled`) or `approved`, broadcasts `queue.item_requested` (and `queue.item_approved` when auto-approved)
- `moderate({ itemId, decision, sessionId })` — pure transform via `applyModerationDecision`, persists, broadcasts the matching event
- `removeOwn({ itemId, sessionId, slotToken })` — guards: slot owns the item, item not currently `playing`; returns 403 `not_owner` for cross-guest removal attempts
- `castSkipVote({ itemId, sessionId, slotToken })` — in-process `Set<itemId:slotId>` dedupe (v1; full `skip_votes` table lands when hosted needs cross-instance dedupe), returns `{ votes, threshold, voteSkipMode }`
- `listForSession(sessionId)` — read path
- All mutations broadcast through `RealtimeRoomRegistry.forSession(sessionId)?.publish(event)` — when no room is registered, the service still works (e.g. unit tests, batch tools); when a room IS registered, every mutation produces the matching `SessionEvent`
- Structured `QueueServiceError` with codes (`unknown_slot_token`, `slot_not_active`, `session_not_found`, `slot_session_mismatch`, `item_session_mismatch`, `guest_not_found`, `cap_reached`, `item_playing`, `not_owner`, `already_voted`, `item_not_found`, `session_ended`, `guest_session_mismatch`)

**Routes** (`@opendj/backend/routes/queue.ts`):

- `GET /` — full queue (no auth gate; queue contents are public to anyone with the QR slug)
- `POST /` — guest request via slot token (Authorization: Bearer); 401 missing/invalid, 400 validation/cap, 201 with summary
- `PATCH /:itemId` — host moderation; `requireClaim('queue:moderate')`; 401/403 default, 200 with updated summary
- `DELETE /:itemId` — guest removes own; 403 not_owner, 400 item_playing, 200 ok
- `POST /:itemId/skip-vote` — guest casts; returns vote count + threshold; 400 already_voted

**13 new tests** (174 total in backend) covering both moderation modes, every error path on every method, dedupe behavior, broadcast ordering (request → approved when auto-approve), `decidedAt` propagation, and `playing` items being unremovable.
