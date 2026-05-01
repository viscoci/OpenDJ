---
'@opendj/abuse': minor
'@opendj/core': patch
---

Land `@opendj/abuse` foundation.

**Decisions:**

- `AbuseDecision` discriminated union: `allow` | `shadow_limit` | `throttle` | `require_host_review` | `block`
- `isUserVisibleRejection`, `isPersisted`, `appearsSuccessful` helpers — make the shadow/persist semantics explicit so route handlers can't accidentally persist a shadow-limited write
- `mergeDecisions(a, b)` — strictest wins (block > require_host_review > throttle > shadow_limit > allow); ties bias left so earlier-evaluated cheaper signals dominate
- `strictestDecision(decisions[])` — fold helper for combining per-signal evaluations
- `isDecisionOfAction(decision, action)` — discriminated narrowing

**Signals (mirrors `action_events` schema):**

- `ActionEventInput` + `ActionEvent` (post-write) + `ActionEventKind` (`guest_joined`, `search`, `song_requested`, `skip_vote`, `rate_limited`, `abuse_blocked`, `cap_hit`, ...)
- Privacy-minimized — store salted, session-scoped hashes, never raw IPs/fingerprints

**Subjects (mirrors `abuse_subjects`):**

- `AbuseSubject` + `AbuseSubjectStatus` (`normal` | `throttled` | `shadow_limited` | `blocked`)

**Rate limits:**

- `RateLimitScope` open string-template type for typed scopes (`search`, `song_requested`, `skip_vote`, `auth_login`, ...)
- `RateLimitDecision` with `ok` / `retryAfterMs` / `remaining` / `limit` / `windowMs`

**Service interfaces** (concrete impls live in `@opendj/backend`):

- `AbuseSignalService` — `recordActionEvent` + `recordActionEvents` (batchable)
- `RiskScoringService` — `evaluate` + `getSubjectStatus` + `updateSubject`
- `RateLimitService` — `apply` + `peek` + `reset`

12 unit tests covering decision semantics, severity ordering, fold reduction, narrowing, and the shadow_limit/persistence asymmetry.
