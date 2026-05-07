---
'@opendj/core': minor
---

Add domain types, constants, queue logic, and plan feature gates.

**Domain types** (mirrors `@opendj/db` schema, no DB import):

- `Account` + `Plan` (`free` | `paid_monthly` | `paid_event` | `oss`)
- `Session` + `VoteSkipMode` (`fixed` | `percentage` | `host_approval`)
- `Guest`
- `QueueItem` + `QueueItemStatus` + `ACTIVE_QUEUE_STATUSES` + `isActiveQueueItem`

**Constants** (single source of truth shared across backend, frontend, and downstream consumers):

- `HOSTED_FREE_TIER_GUEST_CAP = 12`
- `DEFAULT_SONGS_PER_GUEST_CAP = 3`
- `SLOT_HEARTBEAT_TIMEOUT_MS = 5 * 60 * 1000`
- `SLOT_EXPIRY_SWEEP_INTERVAL_MS = 60 * 1000`
- `SPOTIFY_SCOPES`

**Queue logic** (pure functions):

- `canEnqueue(session, guest, items, now)` — returns ok or one of `session_ended` / `guest_session_mismatch` / `cap_reached`
- `enforcePerGuestCap(items, guestId, cap)` — true when guest is at/over cap
- `countActiveItemsForGuest(items, guestId)` — counts non-rejected items
- `dedupeQueue(items)` — collapses repeat trackUris while preserving rejected items in place
- `applyModerationDecision(item, 'approved' | 'rejected', now)` — non-mutating transform
- `canSkip(session, skipVotes, totalActiveGuests)` — handles fixed / percentage / host_approval modes including divide-by-zero guards

**Plan gates**:

- `effectiveGuestCap(account, session)` — respects `session.guestCapOverride`, then plan default
- `canStartSession`, `canUseCustomDomain`, `canDisableBranding`, `canUseZones`, `canUseAnalytics` — paid + oss unlock; free is the only constrained plan
- `isPaidOrOss(plan)` helper

**75 new unit tests** (133 total in `@opendj/core`).
