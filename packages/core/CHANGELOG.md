# @opendj/core

## 0.1.0

### Minor Changes

- [`ce9853a`](https://github.com/viscoci/OpenDJ/commit/ce9853aa966b9aee3a76e364ced9d5585e2fa80b) Thanks [@viscoci](https://github.com/viscoci)! - Add domain types, constants, queue logic, and plan feature gates.

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

- [`8314674`](https://github.com/viscoci/OpenDJ/commit/8314674f1ce0bbbcc214b5b8d619e43be01f8b15) Thanks [@viscoci](https://github.com/viscoci)! - Add provider contracts foundation:
  - `IStreamingProvider` base interface (lifecycle + capability discovery)
  - `PROVIDER_FEATURES` constant — stable feature ID vocabulary shared across backend, frontend, docs, tests
  - `ProviderFeatureDescriptor` + `ProviderCapabilities` with granular `access` and `reliability` markers
  - `defineCapabilities(...)` builder that catches descriptor/key mismatches at construction
  - Modular `ISupports*` feature interfaces: search, zones, now-playing, queue, playlist switch, skip, pause, resume, volume read/set/step, playlists, playlist tracks read/add
  - Runtime type guards (`supportsSearch`, `supportsQueueTrack`, `supportsVolumeStep`, ...) that check both the capability descriptor AND that the matching method exists on the instance
  - Shared types: `Track`, `Zone`, `NowPlayingTrack`, `ProviderCredentials`, `QueueResult`, `PlaylistSummary`
  - Error classes: `OpenDjError`, `NotImplementedError`, `NotSupportedByProviderError`, `InvalidProviderCredentialsError`
  - 58 unit tests covering capability declaration, feature gating, and the full type-guard matrix

### Patch Changes

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

- [`cc9a8a1`](https://github.com/viscoci/OpenDJ/commit/cc9a8a18bc793664ca556bcc5cc8cccb91912694) Thanks [@viscoci](https://github.com/viscoci)! - Land `@opendj/auth` runtime-neutral foundations.

  **Claims:**
  - `Claim` union covering account / session / queue / provider / billing / admin scopes
  - `AuthContext` + `AuthKind` (`anonymous_guest` | `logged_in_guest` | `host` | `service`)
  - `hasClaim` / `hasAnyClaim` / `hasAllClaims` predicates (vacuous-true for empty list on `hasAllClaims`)
  - `assertClaim` / `assertAnyClaim` throwing helpers + `MissingClaimError` carrying both the missing claim and the offending context
  - `assertAnyClaim` rejects empty input with a clear error rather than silently passing

  **OAuth (pure, fetch-based, Workers-safe):**
  - `OAuthProviderConfig` + `OAuthTokens` types
  - `buildAuthorizeUrl(config, clientId, redirectUri, state, scopes?, { codeChallenge, codeChallengeMethod }?)` — handles default scopes, override scopes, PKCE branch, query-string-tolerant authorizeUrl
  - `exchangeCode({ ... })` — standard `authorization_code` exchange with optional `code_verifier` (PKCE), optional `client_secret` (public-client friendly), `nowEpochMs` injection for deterministic tests
  - `refreshTokens({ ... })` — reuses old `refresh_token` when the response omits one (Spotify behavior)
  - `shouldRefresh(tokens, nowEpochMs)` with 60s `REFRESH_LEEWAY_MS`; returns false when no refresh token, true when expiry unknown
  - `OAuthTokenError` carries `providerId`, `status`, and the response body

  **Passwords:**
  - `PasswordHasher` interface (concrete Argon2id impl deferred to `@opendj/backend` due to native deps)
  - `detectHashAlgorithm(hash)` extracts algorithm prefix for migration audits / `password_credentials.hash_algorithm`
  - `constantTimeEqual(a, b)` for non-Argon digest comparisons (e.g. opaque tokens)

  **Session tokens:**
  - `generateSessionToken()` — 32 bytes from Web Crypto, returned as 64-char lowercase hex
  - `hashSessionToken(token)` — SHA-256 hex digest via `crypto.subtle`; matches the published SHA-256 of the empty string in tests

  **Out of this package** (lives in `@opendj/backend`):
  - Concrete Argon2id `PasswordHasher` implementation
  - Hono middleware (`requireAuth`, `requireClaim`, `requireAnyClaim`, `requireSessionGuest`)
  - `AuthService` / `ClaimsService` that touch the database

  49 unit tests covering claims (predicates, narrowing, assertions, error payload), OAuth (URL building with/without PKCE, code exchange w/ + w/o secret, refresh token reuse, `shouldRefresh` boundary cases), password (algorithm detection across argon2/bcrypt variants, constant-time equality), and session tokens (entropy + SHA-256 stability + matches NIST empty-string vector).

- [`1ab1006`](https://github.com/viscoci/OpenDJ/commit/1ab100680c03b2e2954c0118e7780f8605d19e86) Thanks [@viscoci](https://github.com/viscoci)! - Land the full Drizzle schema for OpenDJ OSS — 19 tables across 7 domain files.

  **Schema files** (`@opendj/db/schema`):
  - `users.ts` — `users` (UUID + bigserial publicUserId + email + status)
  - `accounts.ts` — `accounts`, `account_memberships` (composite PK, claims array)
  - `auth.ts` — `auth_identities`, `password_credentials`, `auth_sessions`, `oauth_states`
  - `providers.ts` — `provider_connections` (music/service OAuth, distinct from login identities)
  - `sessions.ts` — `sessions`, `guests`, `queue_items`, `session_events`, `outbox_events`, `guest_slots`, `fingerprint_priority` (composite PK)
  - `lyrics.ts` — `lyrics_cache`, `lyrics_feedback`
  - `abuse.ts` — `action_events`, `abuse_subjects`

  **Client:**
  - `createDb(connectionString, options?)` factory backed by `postgres.js` (Node + Cloudflare Workers compatible — explicitly NOT `node-postgres`, which is incompatible with Workers)
  - `Database` type alias for typed Drizzle client
  - `schema` namespace export for query helpers

  **Inferred row + insert types** exported for every table (`UserRow`, `UserInsert`, etc.) so backend services can type their inputs/outputs without re-deriving.

  **drizzle-kit config** at `drizzle.config.ts` ready to generate migrations once schema stabilizes (`pnpm --filter @opendj/db db:generate`).

  **What's NOT in this package** (per `docs/REPO_BOUNDARY.md`): `subscriptions` and product/funnel analytics dashboards — those belong in downstream consumer migrations, not the foundation. `action_events` and `abuse_subjects` ARE included here because abuse prevention is core product safety, not business analytics.

  9 tests covering schema-shape inference and client/schema export surface.

- [`3b33536`](https://github.com/viscoci/OpenDJ/commit/3b3353675c3c39740b68d674ca53799b616cd737) Thanks [@viscoci](https://github.com/viscoci)! - Land `@opendj/lyrics` foundation: types, LRC parser, LRCLIB adapter, lookup-key normalization, sync-cue conversion, and lyric-window helper.

  **Types** (mirrors `lyrics_cache` + `lyrics_feedback` schema):
  - `LyricsProvider`, `LyricsLookupInput`, `LyricsLine`, `LyricsDocument`, `LyricsMatchConfidence`, `LyricsProviderId`
  - `LyricsFeedbackKind` (`wrong_song` | `bad_timing` | `wrong_line` | `missing_lyrics` | `offensive_or_bad_content` | `other`) + `LyricsFeedbackInput`

  **Lookup-key normalization:**
  - `normalizeLookup(input)` lowercases, collapses whitespace/underscores, strips `(feat. X)` / `(Remastered 2011)` / `[Live]` / `(Remix)` noise, ASCII-fies curly quotes, rounds duration to seconds, uppercases ISRC
  - `lookupCacheKey(normalized)` produces stable cross-provider cache keys (omits `providerTrackUri` so the same track from Spotify or Apple Music hits the same entry)

  **LRC parser:**
  - `parseLrc(raw)` handles `[mm:ss]`, `[mm:ss.xx]`, `[mm:ss.xxx]` timestamps; multiple timestamps per line; left-aligns 1-digit fractions; sorts ascending; chains `endsAtMs` to next line; recognizes and skips LRC metadata tags (`ar`, `ti`, `al`, `length`, `offset`, etc.); preserves empty silence beats

  **LRCLIB adapter** (`@opendj/lyrics/providers`):
  - `LrclibAdapter implements LyricsProvider` — fetch-based (works in Node + Workers + browsers); never throws; returns `null`/`[]` on network errors / non-OK responses / parse failures so playback never blocks on lyrics
  - `getBestMatch` calls `/api/get` (high confidence), `search` calls `/api/search` (medium); duration sent in seconds; `albumName` optional; sends descriptive `User-Agent`; configurable `baseUrl` (trailing-slash-tolerant); preserves attribution on every document

  **Sync integration:**
  - `lyricsDocumentToSyncCues(doc)` converts synced lines to `SyncCue<LyricsLine>` with `kind: 'lyric'`; drops lines without `startsAtMs`; preserves `endsAtMs` when present
  - `getActiveLyricWindow(position, doc, prevCount=1, nextCount=2)` returns chronological lines around the active position; clamps cleanly at start/end; before-first-line returns upcoming context

  **49 unit tests** covering normalization edge cases, LRC parsing variants, LRCLIB adapter happy/error paths with mocked fetch, sync-cue conversion, and active-window clamping.

- [#13](https://github.com/viscoci/OpenDJ/pull/13) [`8515474`](https://github.com/viscoci/OpenDJ/commit/8515474c33598c56b824e7d9b2562ecfe8d1fe83) Thanks [@viscoci](https://github.com/viscoci)! - Publish metadata: tarballs now resolve `main`/`types`/`exports` from `dist/` via `publishConfig`; `@opendj/db` tarballs include `migrations/*.sql`.

- [`f865239`](https://github.com/viscoci/OpenDJ/commit/f865239b7a7d4e86e9f80a333ece0f3fc9a92d8e) Thanks [@viscoci](https://github.com/viscoci)! - Land `@opendj/realtime` room contracts.

  **Interface:**
  - `RealtimeRoom` — runtime-neutral interface implemented by `NodeSessionRoom` (Node deploys) and implementable by a Cloudflare Durable Object `SessionRoom` actor on Workers deploys
  - Methods: `connect(client)` / `disconnect(clientId)` / `getSnapshot()` / `publish(event)` / `mutate<T>(command)`

  **Types:**
  - `RealtimeClient` + `RealtimeClientKind` (`guest` | `host` | `tv` | `service`)
  - `SessionSnapshot` composing `nowPlaying` (core), `playbackClock` (sync), `lyrics` + `activeLyricsWindow` (lyrics), `queue` + `pending` (QueueItemSummary), guest counts, snapshot timestamp
  - `QueueItemSummary` + `toQueueItemSummary(item)` projection — broadcast-safe shape that omits `sessionId` and converts Dates to epoch ms
  - `SessionEvent` discriminated union: queue lifecycle, now-playing, skip-vote, guest-slot, playback clock + correction, lyrics loaded/feedback, sync cue window, session ended
  - `SessionCommand` discriminated union: enqueue, moderate, remove_item, cast_skip_vote, set_now_playing, sample_playback_clock, record_lyrics_feedback, end_session

  **Helpers:**
  - `createEmptySnapshot(sessionId, nowEpochMs)` for room boot + tests; allocates fresh arrays per call
  - `isEventOfType(event, type)` / `isCommandOfType(cmd, type)` — discriminated narrowing
  - `isQueueEvent` / `isPlaybackEvent` / `isLyricsEvent` — bucket helpers for room dispatch tables; partition the queue/playback/lyrics events disjointly

  High-frequency progress ticks are intentionally NOT in `SessionEvent` — clients interpolate locally from the most recent `playback.clock_sampled` event using `predictPlaybackPosition` from `@opendj/sync`.

  15 unit tests covering projection, narrowing, snapshot construction, and event-bucket disjointness.

- [`e921030`](https://github.com/viscoci/OpenDJ/commit/e92103056952c6c73d328d95790169b87ea678b9) Thanks [@viscoci](https://github.com/viscoci)! - Land `@opendj/sync` timing primitives.

  **Types:**
  - `PlaybackClockSample` — provider sample + wall-clock timestamp + confidence
  - `PredictedPlaybackPosition` — extrapolated position with normalized progress + confidence
  - `SyncCue<TPayload>` discriminated by `kind` (`lyric` | `lighting` | `visual` | `custom`)
  - `SongSyncAdapter<TCue>` interface for lyrics / lighting / visualizer adapters

  **Helpers:**
  - `createPlaybackClockSample(nowPlaying, sampledAtEpochMs, options?)` — clamps progress, captures providerLatencyMs / confidence overrides
  - `predictPlaybackPosition(sample, nowEpochMs)` — handles paused tracks (no advance), clock skew (elapsed=0), end-of-track clamp; confidence decays with sample age and never exceeds the source sample's confidence
  - `normalizeProgress(progressMs, durationMs)` — clamps to [0..1], returns 0 for zero/negative duration
  - `findActiveCues(positionMs, cues)` — start inclusive, end exclusive; open-ended cues stay active
  - `findUpcomingCues(positionMs, cues, windowMs)` — strict bounds on both sides; empty for non-positive window
  - `clamp(value, min, max)` — exported for adapter authors

  **34 unit tests** covering normalization edge cases, prediction with paused/clock-skew/end-of-track conditions, confidence decay, and cue boundary semantics.

  `@opendj/core` is bumped patch because `@opendj/sync` declares it as a workspace dep — no runtime change to core itself.
