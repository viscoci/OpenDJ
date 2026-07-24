# @opendj/abuse

## 0.1.0

### Minor Changes

- [`945b5cc`](https://github.com/viscoci/OpenDJ/commit/945b5cceec0e92cb9a9a875fb0e03cc43dca4b7d) Thanks [@viscoci](https://github.com/viscoci)! - Land `@opendj/abuse` foundation.

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

### Patch Changes

- [#13](https://github.com/viscoci/OpenDJ/pull/13) [`8515474`](https://github.com/viscoci/OpenDJ/commit/8515474c33598c56b824e7d9b2562ecfe8d1fe83) Thanks [@viscoci](https://github.com/viscoci)! - Publish metadata: tarballs now resolve `main`/`types`/`exports` from `dist/` via `publishConfig`; `@opendj/db` tarballs include `migrations/*.sql`.

- Updated dependencies [[`945b5cc`](https://github.com/viscoci/OpenDJ/commit/945b5cceec0e92cb9a9a875fb0e03cc43dca4b7d), [`cc9a8a1`](https://github.com/viscoci/OpenDJ/commit/cc9a8a18bc793664ca556bcc5cc8cccb91912694), [`ce9853a`](https://github.com/viscoci/OpenDJ/commit/ce9853aa966b9aee3a76e364ced9d5585e2fa80b), [`8314674`](https://github.com/viscoci/OpenDJ/commit/8314674f1ce0bbbcc214b5b8d619e43be01f8b15), [`1ab1006`](https://github.com/viscoci/OpenDJ/commit/1ab100680c03b2e2954c0118e7780f8605d19e86), [`3b33536`](https://github.com/viscoci/OpenDJ/commit/3b3353675c3c39740b68d674ca53799b616cd737), [`8515474`](https://github.com/viscoci/OpenDJ/commit/8515474c33598c56b824e7d9b2562ecfe8d1fe83), [`f865239`](https://github.com/viscoci/OpenDJ/commit/f865239b7a7d4e86e9f80a333ece0f3fc9a92d8e), [`e921030`](https://github.com/viscoci/OpenDJ/commit/e92103056952c6c73d328d95790169b87ea678b9)]:
  - @opendj/core@0.1.0
