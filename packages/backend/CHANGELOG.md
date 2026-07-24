# @opendj/backend

## 0.1.0

### Minor Changes

- [`7d40590`](https://github.com/viscoci/OpenDJ/commit/7d40590cc38af949216ba3270e5cd73e9680f64d) Thanks [@viscoci](https://github.com/viscoci)! - Add `AbuseModerationService` + abuse routes (`summary`, `block-guest`, `unblock-guest`).

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

- [`ef08795`](https://github.com/viscoci/OpenDJ/commit/ef0879525eff538507c6da6d1aacdefa7c40d7e4) Thanks [@viscoci](https://github.com/viscoci)! - Account bootstrap on register/login — a freshly-created user now lands with a personal account + owner membership so they can immediately create sessions, connect providers, and moderate queues.

  **`@opendj/auth`**: adds `MembershipRole` type + `claimsForRole(role)` helper. Default claim sets:
  - `owner`: full account control (account/session/queue/provider/billing)
  - `admin`: account+session+queue+provider, no billing
  - `host`: session+queue+playback, no account management
  - `member`: read-only

  **`@opendj/backend`**:
  - `AccountService.bootstrapPersonalAccount({ userId, displayNameHint })` — idempotent. Creates an account (with a slug derived from the hint, disambiguated against collisions) + an owner membership. Returning users get their existing membership reused.
  - `AccountRepository.create` and `MembershipRepository.upsert` added to both in-memory and Drizzle implementations.
  - `EmailPasswordService.register` now takes an optional `accountService` dep; when wired, it bootstraps a personal account for the new user and sets `currentAccountId` on the issued session so the session arrives "host-ready" with the right claims snapshot.
  - `LoginAuthService.complete` does the same on first login via any provider (Google, etc.). Idempotent across provider re-logins.
  - `createDeps` constructs `AccountService` and wires it into both auth services by default. Exposed on `AppDeps.accountService` for routes/tests.

  **Why this matters**: without account bootstrap, `POST /api/v1/sessions` always 403'd for fresh users (no `session:create` claim). The brief assumes every user has at least their own personal account; this closes that gap.

  **11 new tests** (272 total in backend) — `AccountService` slug uniqueness/sanitization/idempotence/missing-account recovery; `EmailPasswordService.register` bootstrap+back-compat; `LoginAuthService.complete` first-login bootstrap + returning-user idempotence.

- [`f559aac`](https://github.com/viscoci/OpenDJ/commit/f559aac861cf6fed13d13c09b9233569a44dea0f) Thanks [@viscoci](https://github.com/viscoci)! - Add `/api/v1/auth/{me,logout,switch-account}` routes plus session-cookie helpers.

  **Cookie helpers** (`@opendj/backend/auth/cookies.ts`):
  - `buildSessionCookie({ value, expiresAt, sameSite? })` — `__Host-`-prefix-compliant Set-Cookie value (`Path=/`, `HttpOnly`, `Secure`, `SameSite=Lax` default, `Expires`)
  - `clearSessionCookie(sameSite?)` — `Max-Age=0` + epoch-zero `Expires` for logout / revoke

  **AuthService changes:**
  - `resolveAuthContext(token, nowEpochMs)` now returns `ResolvedSession | null` (`{ context: AuthContext, sessionId: string }`) instead of just `AuthContext`. Middleware needs the session id for /logout and /switch-account; routes get it via `c.get('authSessionId')` without re-hashing the cookie.
  - `switchAccount(sessionId, userId, accountId)` — validates membership via `ClaimsService.assertMembership`, refreshes claims, and persists both `currentAccountId` + `claimsSnapshot` on the session row in one logical step.

  **AuthSessionRepository:**
  - New `updateCurrentAccount(id, accountId)` method (interface + InMemory + Drizzle impls).

  **Middleware:**
  - All four (`optionalAuth` / `requireAuth` / `requireClaim` / `requireAnyClaim`) now also set `c.var.authSessionId` so routes can mutate the session.
  - `AuthVariables` interface gains `authSessionId: string | undefined`.

  **Routes** (`@opendj/backend/routes/auth.ts`):
  - `GET /me` — requireAuth; returns user + currentAccountId + claims + accounts list (via `ClaimsService.getAccountsForUser`); 401 when the session points at a deleted user
  - `POST /logout` — requireAuth; revokes session + clears cookie; subsequent requests with the same cookie 401
  - `POST /switch-account` — requireAuth; Valibot-validated body (`accountId: uuid`); 400 on invalid body, 403 `not_account_member` when the user is not an active member, 200 with new claims on success

  **11 new tests** (85 total in backend) covering /me happy/empty-account/deleted-user paths, /logout cookie shape and post-logout 401, /switch-account 401/400/403/200 paths and post-switch session-row state.

- [`c175096`](https://github.com/viscoci/OpenDJ/commit/c1750961f286429bca3abe2c230322803191a475) Thanks [@viscoci](https://github.com/viscoci)! - Add `AuthService` and Hono auth middleware.

  **`AuthService`** (`@opendj/backend/auth/AuthService.ts`):
  - `issueSession({ userId, currentAccountId?, ipHash?, userAgentHash?, ttlMs?, claimsSnapshot? })` — generates an opaque token via `@opendj/auth`'s Web Crypto helpers, stores only the SHA-256 hash, captures the claims snapshot via `ClaimsService` (or accepts an override for service tokens), default TTL 7 days
  - `resolveAuthContext(token, nowEpochMs)` — hash → lookup → returns `AuthContext` or null; auto-rejects revoked or expired sessions; debounces `lastSeenAt` updates to once per 5 min so a single hot session doesn't write on every request
  - `revokeSession(sessionId, nowEpochMs)`
  - `refreshClaimsSnapshot(sessionId, userId, accountId)` — re-reads claims and persists; call after add/remove member, role change, or account switch
  - `parseSessionCookie(cookieHeader)` — tolerates `__Host-` prefix, surrounding cookies, whitespace; returns null on missing or empty value

  **Constants:**
  - `SESSION_COOKIE_NAME = '__Host-opendj_session'` (Secure prefix; same-origin only)
  - `DEFAULT_SESSION_TTL_MS = 7 days`
  - `TOUCH_DEBOUNCE_MS = 5 min`

  **Hono middleware** (`@opendj/backend/auth/middleware.ts`):
  - `optionalAuth(authService)` — sets `c.var.auth` to AuthContext or null; always continues
  - `requireAuth(authService)` — 401 `{ error: 'unauthenticated' }` when no valid session
  - `requireClaim(authService, claim)` — 401 unauth, 403 `{ error: 'forbidden', missingClaim }` when claim absent
  - `requireAnyClaim(authService, claims)` — same logic, satisfied by any one; 403 carries `missingAnyClaim` array
  - All four set `c.var.auth` so route handlers read the AuthContext via `c.get('auth')`
  - `AuthVariables` typed-context interface for app-wide registration

  **30 new tests** (74 total in backend) covering session lifecycle (issue → resolve → revoke → expire), hash-not-plaintext storage invariant, claims snapshot capture and refresh, custom TTL overrides, the `lastSeenAt` debounce window (both directions), cookie-parsing robustness, and the full middleware matrix (no cookie / invalid cookie / valid session / missing claim / any-claim satisfaction).

- [`9a03df2`](https://github.com/viscoci/OpenDJ/commit/9a03df2a7c4ed494e3f8deaf4d98da2e47725968) Thanks [@viscoci](https://github.com/viscoci)! - Add ClaimsService + the repository pattern that all data-access services will follow.

  **Repository interfaces** (`@opendj/backend/repositories`):
  - `UserRepository`, `AccountRepository`, `MembershipRepository`, `AuthIdentityRepository`, `AuthSessionRepository`, `PasswordCredentialRepository`
  - Plain record types (`UserRecord` / `AccountRecord` / etc.) decoupled from Drizzle's inferred types — services depend on repositories, not on the ORM
  - `Repositories` aggregate type for the service-deps graph

  **Drizzle implementations** (`@opendj/backend/repositories/drizzle`):
  - One class per interface, each scoped to a single table
  - `createDrizzleRepositories(db)` factory that wires the lot
  - Direct `drizzle-orm` queries — no extra abstraction over the ORM

  **In-memory implementations** (`@opendj/backend/repositories/in-memory`):
  - One class per interface backed by `Map`, with `seed()` test helpers on the relational ones
  - Injectable clock for deterministic timestamps
  - `createInMemoryRepositories()` factory
  - `findActiveByHash` correctly filters revoked + expired sessions

  **ClaimsService** (`@opendj/backend/auth`):
  - `refreshClaims(userId, accountId)` — returns the active membership's claim list (empty array for non-member / invited / disabled)
  - `assertMembership(userId, accountId)` — throws `NotAccountMemberError` with both ids attached
  - `assertClaimOnAccount(userId, accountId, claim)` — throws `MissingClaimError` when missing
  - `getAccountsForUser(userId)` — joins memberships + accounts; filters inactive memberships and orphaned account references; returns claim copies (not live arrays)

  **29 new tests** (44 total in backend) covering the full ClaimsService surface — happy paths, inactive-membership filtering, deleted-account handling, copy semantics — plus in-memory repository invariants (case-insensitive email lookup, monotonic publicUserId, expired/revoked session filtering, claim snapshot updates).

- [`f2a8634`](https://github.com/viscoci/OpenDJ/commit/f2a86342f8eab220b99f764493c38697775d28bf) Thanks [@viscoci](https://github.com/viscoci)! - Add `Argon2idPasswordHasher` (Node) + `EmailPasswordService` + `/api/v1/auth/email/{register,login}` routes.

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

- [`5a34574`](https://github.com/viscoci/OpenDJ/commit/5a34574bce2a6585a8939c960f9ad975d2c0bb21) Thanks [@viscoci](https://github.com/viscoci)! - Add the guest identity + slot system: `/api/v1/guest/{identity,heartbeat,slot}` plus the data layer + service that drives them.

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

- [`9fb9497`](https://github.com/viscoci/OpenDJ/commit/9fb9497fdc027480392e979f904ed1b502bb82ef) Thanks [@viscoci](https://github.com/viscoci)! - Land the first slice of `@opendj/backend`: Hono app factory, runtime config parser, dependency-graph placeholder, and the `/api/v1/health` route.

  **Config (`loadConfig(env)`):**
  - Valibot-validated `Config` shape — `databaseUrl` (required URL), `baseUrl` (default `http://localhost:8888`), `maxSongsPerGuest`, `maxGuestsPerSession` (null = unlimited), `moderationEnabledDefault`, optional `valkeyUrl`, optional `spotify` block (only attached when `SPOTIFY_CLIENT_ID` + `SPOTIFY_CLIENT_SECRET` are both set; default redirect URI derived from `baseUrl`)
  - `ConfigError` aggregates every validation issue at once
  - Robust env parsing: integer/boolean/optional-integer fall back gracefully on empty or unparseable values

  **Dependency graph (`createDeps(...)`):**
  - `AppDeps` interface holds `config` + `db` (Database from `@opendj/db`)
  - Subsequent slices add `AuthService`, `ClaimsService`, `StreamingRouter`, `GuestIdentityService`, `SlotManager`, `QueueService`, `SessionService`, `LyricsLookupService`, `RealtimeRoomRegistry`, `AbuseSignalService`, `RiskScoringService`, `RateLimitService`

  **App factory (`createApp({ deps })`):**
  - Hono app with routes mounted under `/api/v1` (versioned for future breaking changes)
  - Returns the bare Hono instance — Node + Workers wire their adapter at the call site (`apps/oss-demo/src/main.ts` for the Node reference deploy; a Workers entry point for an edge deploy)

  **Routes:**
  - `GET /api/v1/health` — liveness probe; `{ ok: true, service: 'opendj-backend' }`; intentionally does NOT touch the database (a DB blip shouldn't fail the probe)

  **15 tests** covering config parsing edge cases (missing required, empty integers, fallbacks, Spotify partial config, custom redirect URI, valkey passthrough), `ConfigError` shape, and Hono app routing (versioned 404 vs root 404, JSON shape).

  This is the integration foundation — auth/queue/provider/realtime/lyrics/abuse routes land in subsequent commits, each gated by its own slice of services in `deps.ts`.

- [`a192e11`](https://github.com/viscoci/OpenDJ/commit/a192e11a7dcf9fc4e81a60a8353b20e4c8c005a3) Thanks [@viscoci](https://github.com/viscoci)! - Add login OAuth scaffolding: `LoginAuthService` + `LoginProviderHandler` registry + `/api/v1/auth/oauth/:provider/{start,callback}` routes.

  **Architecture**

  Login providers (sign-in identities) are deliberately separate from music providers (Spotify, Apple Music). Both use `OAuthProviderConfig` from `@opendj/auth`, but they live under different route trees, use different `oauth_states.flow_kind` values (`'login'` vs `'connect-provider'`), and persist to different tables (`auth_identities` + `users` vs `provider_connections`).

  A `LoginProviderHandler` carries the OAuth config + a `fetchProfile(tokens, fetch) → ProviderProfile` step. `LoginAuthService` coordinates state generation, code exchange, profile fetch, identity matching/upsert, user upsert, and session issuance.

  **Identity matching**
  1. Find by `(providerId, providerSubject)` first — natural identity key
  2. If found → reuse the linked user
  3. If not found AND the provider verified the email → link to existing user-by-email
  4. Otherwise → create a new user

  **Providers**
  - **Google** — fully implemented. OIDC userinfo endpoint via Bearer token. id_token JWKS verification skipped intentionally (the userinfo Bearer call is itself a verification by Google's authorization server); add JWKS verification before trusting `email` for elevated-trust deployments.
  - **Apple** — STUB. Returns 501 `login_provider_not_implemented`. Needs JWKS verification, id_token claim parsing, private-relay email handling, and first-login `name` form_post capture before it's safe to ship.
  - **Facebook** — STUB. Returns 501. Needs OAuth2 (non-OIDC) flow, GET-based token exchange, Graph API profile fetch, and missing-email handling before it's safe to ship.

  **Routes**
  - `GET /api/v1/auth/oauth/:provider/start` — 302 to authorize URL; 503 `provider_not_configured`; 400 `unknown_provider`
  - `GET /api/v1/auth/oauth/:provider/callback` — 302 to `postLoginPath` + `Set-Cookie: __Host-opendj_session=...`; 400 `provider_denied` / `invalid_callback_query` / `invalid_or_expired_state` / `state_provider_mismatch` / `wrong_flow_kind`; 502 `token_exchange_failed`; 501 `login_provider_not_implemented`

  **Config**

  `Config` now exposes:
  - `loginProviders: { google?, apple?, facebook? }` — each with `clientId`, optional `clientSecret`, `redirectUri`. Populated from `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` (and Apple/Facebook equivalents). `redirectUri` defaults to `${BASE_URL}/api/v1/auth/oauth/<provider>/callback`.
  - `postLoginPath: string` — where to send the user after successful login. Defaults to `/`. Set via `POST_LOGIN_PATH`.

  **Wiring**

  `LoginAuthService` is constructed in `createDeps` and exposed on `AppDeps` as `loginAuthService` + `loginProviders`. `createApp` mounts the routes at `/api/v1/auth/oauth`. Override the registry via `createDeps({ loginProviders })` to add custom providers.

  **24 new tests** (262 total in backend) — LoginAuthService matching matrix (new user, returning user, auto-link verified email, do-not-link unverified email, state replay, state mismatch, flow-kind mismatch); GoogleLoginHandler.fetchProfile (Bearer auth, missing fields, 401 surface); Apple+Facebook stubs throw `LoginProviderNotImplementedError`; route-level start/callback status codes including 501 for stubs.

- [`ea889aa`](https://github.com/viscoci/OpenDJ/commit/ea889aab496e130d03b17baf916d16ff2e3c2b2d) Thanks [@viscoci](https://github.com/viscoci)! - Add `LyricsLookupService` + lyrics routes — public lookup, session-scoped current/feedback.

  **`LyricsCacheRepository` + `LyricsFeedbackRepository`** (interface + InMemory + Drizzle):
  - `LyricsCacheRepository.upsert` keyed on `(source, lookupKeyHash)` via `onConflictDoUpdate`; `recordHit` / `suppress`
  - `LyricsFeedbackRepository.create` + `countForCacheEntry(cacheId, kind?)` for the auto-suppression sweep

  **`LyricsLookupService`** (`@opendj/backend/lyrics/LyricsLookupService.ts`):
  - `lookup({ trackName, artistName, ... })` — normalizes via `@opendj/lyrics`'s `normalizeLookup`, hashes the cache key, tries the cache first, falls through to the provider on miss
  - Persists positive **and negative** results (negative = `isSynced=false, syncedLrc=null, plainLyrics=null, matchConfidence='low'`) so repeated lookups for known-misses don't re-hit the provider
  - Provider exceptions are swallowed silently (per brief: "never make provider playback fail because lyrics lookup fails")
  - Suppressed cache entries return `null` even when the data is still in the row
  - `recordFeedback` — persists + auto-suppresses the cache entry after **3 reports of the same kind** for `wrong_song` / `bad_timing` / `offensive_or_bad_content` (other kinds are tracked but don't auto-suppress)

  **Routes** (`@opendj/backend/routes/lyrics.ts`):
  - `GET /api/v1/lyrics/lookup?trackName=...&artistName=...&albumName?&durationMs?&providerTrackUri?` — public; always returns 200 with `{ match: LyricsDocument | null }`
  - `GET /api/v1/sessions/:id/lyrics/current?trackName=&artistName=` — thin pass-through to `lookup` until the WS slice wires room introspection
  - `POST /api/v1/sessions/:id/lyrics/feedback` — open to anyone (logged-in guests + hosts get richer attribution via slot-token bearer); 400 on bad body or unknown kind

  **Wired into `createApp`** at `/api/v1/lyrics` and `/api/v1/sessions/:id/lyrics`. `createDeps` instantiates `LrclibAdapter` by default; tests override via `lyricsProvider`.

  **10 new tests** (205 total in backend) covering miss → fetch → persist (positive + negative + provider error), hit → no-fetch (including normalization-equivalent inputs), suppression read-through, feedback insert, and the auto-suppression threshold (per-kind counting, only the configured kinds, no premature suppression).

- [`4a39fe3`](https://github.com/viscoci/OpenDJ/commit/4a39fe39c3ff7b6d3f775a77a80d0c8ca44125bb) Thanks [@viscoci](https://github.com/viscoci)! - Add the generic music-provider OAuth routes — `/api/v1/provider/connections/:provider/{start,callback}` — that drive the Spotify (and future) connection flow.

  **`OAuthStateRepository`** (interface + InMemory + Drizzle):
  - `create(input)` / `findActive(state, nowEpochMs)` / `delete(state)` / `pruneExpired(nowEpochMs)`
  - Active = not yet expired; lookups never return stale rows
  - Drizzle `pruneExpired` returns the deleted count (driven by a `RETURNING` clause)

  **`streamingProviderOAuthConfigs`** (`@opendj/backend/providers/streaming/oauthConfigs.ts`):
  - `spotifyOAuthConfig` — authorize/token URLs + the `SPOTIFY_SCOPES` from `@opendj/core`
  - `defaultStreamingProviderOAuthConfigs` registry — extend at the call site to add new providers

  **Routes** (`@opendj/backend/routes/providerOAuth.ts`):
  - `GET /:provider/start` — `requireClaim('provider:connect')`; generates a random state via `generateSessionToken`, persists it (10-min TTL) with `flowKind: 'connect-provider'` + accountId + userId, redirects 302 to the provider's authorize URL via `buildAuthorizeUrl`. 400 unknown_provider, 400 no_active_account, 503 provider_oauth_not_configured.
  - `GET /:provider/callback` — verifies state (active, matching provider, matching flow_kind, accountId+userId present), single-use deletes state BEFORE token exchange (replay-safe even if exchange takes a while), calls `exchangeCode`, calls `streamingRouter.switchProvider(...)` to upsert credentials and reconnect, redirects 302 to `/settings/providers` (configurable). Error paths: 400 provider_denied (Spotify `?error=`), 400 invalid_callback_query, 400 invalid_or_expired_state, 400 state_provider_mismatch, 400 wrong_flow_kind, 502 token_exchange_failed.
  - `fetchImpl` injectable through `ProviderOAuthRouteDeps` so Workers can supply outbound bindings and tests can mock the token endpoint without touching the network.

  **14 new tests** (134 total in backend) covering both routes' full state-machine: 401/403 gating, unknown providers, missing config, redirect shape + state persistence, every callback rejection path, single-use replay safety, and the happy-path token persistence + redirect.

- [`0e73d84`](https://github.com/viscoci/OpenDJ/commit/0e73d84315deca4888fe223b1eb04ab28d70b548) Thanks [@viscoci](https://github.com/viscoci)! - Add the streaming provider integration layer: stubs + registry + StreamingRouter.

  **`ProviderConnectionRepository`** (interface + InMemory + Drizzle):
  - `findByAccountAndProvider` / `findAllForAccount` / `upsert` / `updateTokens` / `delete`
  - Composite-key lookup matches the `(account_id, provider_id)` unique index
  - `upsert` via `onConflictDoUpdate` for clean OAuth-callback merge semantics

  **Provider stubs** (`@opendj/backend/providers/streaming`):
  - `AppleMusicProvider` — every feature method throws `NotImplementedError`; capabilities report unsupported with a note pointing to MusicKit JS for client-side use
  - `SoundtrackProvider` — P1 placeholder; declares Search / PlaylistSwitch / NowPlayingRead / ZonesRead all unsupported until the real impl lands. Pre-declared so route capability gating works once methods are filled in.

  **Registry** (`providerRegistry.ts`):
  - `ProviderContext` with `fetch` (Workers-friendly outbound binding compatible)
  - `ProviderFactory = (ctx) => IStreamingProvider`
  - `ProviderRegistry` is a plain `Record<providerId, ProviderFactory>` — no decorators, no Inversify

  **`StreamingRouter`** (`StreamingRouter.ts`):
  - `getProvider(accountId, providerId)` — looks up the connection, instantiates the provider, calls `connect` with credentials, returns the connected instance. Throws `UnknownProviderError` / `ProviderConnectionNotFoundError` / `InvalidProviderCredentialsError` with structured payloads.
  - `switchProvider(accountId, providerId, credentials, { connectedByUserId?, providerAccountId? })` — upsert + reconnect in one step; used by the OAuth callback path.
  - `isProviderUnimplemented(err)` backstop helper.
  - Cross-cutting feature methods (search / queueTrack / etc.) deliberately stay on the provider; routes use `@opendj/core`'s type guards to call them safely.

  **14 new tests** (99 total in backend) covering the stubs (NotImplemented invariants, capability declarations) and the router (every error path, credential merging, end-to-end provider use through capability guards).

- [`95df6c0`](https://github.com/viscoci/OpenDJ/commit/95df6c02757cc5a7fe42f906aa6b35ab49978f63) Thanks [@viscoci](https://github.com/viscoci)! - Add `QueueService` + `/api/v1/sessions/:id/queue/*` routes — the core guest action surface.

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

- [`1d1c3c4`](https://github.com/viscoci/OpenDJ/commit/1d1c3c42008866731e02152e9d247b0931e91010) Thanks [@viscoci](https://github.com/viscoci)! - Add `/api/v1/sessions/:id/search?q=...&limit=...` — track search proxied through the session's connected streaming provider.

  **Why**

  The guest request page currently makes guests type a Spotify URI by hand. That's MVP-acceptable for proving the round-trip but a non-starter for real users. The search proxy is the missing piece between "host connected Spotify" and "guest picks a track."

  **Backend (`@opendj/backend`)**
  - New route mounted at `/api/v1/sessions/:id/search`. Public — no auth or slot token required (guests need to search to make requests).
  - Resolves the session, picks the first connected provider on its account, type-guards for `supportsSearch`, and forwards the query.
  - Status code matrix:
    - 200 — `{ results: [{ trackUri, trackName, artistName, albumArtUrl, durationMs }], providerId }`
    - 400 `invalid_query` — missing/blank `q`, or `limit` outside 1..50
    - 404 `session_not_found` / `session_ended`
    - 501 `search_not_supported` — provider connected but doesn't implement search (e.g. AppleMusic stub). Type guard prevents the call from happening.
    - 502 `provider_error` — search failed at the provider edge
    - 503 `no_provider_connected` — account has no streaming provider linked

  **Frontend (`@opendj/frontend`)**
  - `client.queue.search(sessionId, query, limit?)` returns `SearchResponse`.

  **Tests**
  - 6 new backend tests using a hand-rolled `MockSearchProvider` (implements `IStreamingProvider + ISupportsSearch`) plus a `NoSearchProvider` for the 501 path. No real Spotify calls, no fixtures from real APIs.

- [`f555be2`](https://github.com/viscoci/OpenDJ/commit/f555be2bcd507217f818b0b08c7b36336050208e) Thanks [@viscoci](https://github.com/viscoci)! - Add `SessionService` + `/api/v1/sessions/*` routes.

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

- [`249dc05`](https://github.com/viscoci/OpenDJ/commit/249dc05d8da0d734a18a489413b7e1c3491add15) Thanks [@viscoci](https://github.com/viscoci)! - Land the full `SpotifyProvider` implementation. fetch-based, Workers-safe (no Node-only `spotify-web-api-node` dep).

  **Capabilities** (declared via `defineCapabilities`):
  - Search · QueueTrack · NowPlayingRead · PlaybackProgressRead · SkipTrack · Pause · Resume · VolumeRead · VolumeSetAbsolute → all `native`
  - ZonesRead → unsupported with note explaining Spotify uses devices, not OpenDJ zones; provider exposes a synthetic `default` zone

  **Implemented `ISupports*` methods:**
  - `search(query, limit?)` — `/v1/search?type=track`; maps Spotify's nested artist/album/image shape into OpenDJ's flat `Track` (artist names joined with `, `; album art picked closest to 300px wide)
  - `queueTrack(track)` — `POST /v1/me/player/queue?uri=` (URI properly encoded for tokens with `:` / spaces)
  - `getNowPlaying()` — `GET /v1/me/player/currently-playing`; returns null on 204 / null item; falls back to synthetic `'default'` zoneId when device is null
  - `skipTrack` / `pause` / `resume` — POST/PUT to the standard endpoints
  - `getVolume()` — reads `device.volume_percent` from `/v1/me/player`; returns 0 on 204 (no active device) or null volume
  - `setVolume(percent)` — clamps to `[0, 100]` and rounds before sending

  **Error handling:**
  - `SpotifyClient.request` translates 401 → `InvalidProviderCredentialsError`, 404 with `error.reason='NO_ACTIVE_DEVICE'` → new `NoActiveDeviceError` class (per brief: routes map this to a 400 `{ error: 'no_active_device' }`), other 4xx/5xx → `SpotifyApiError` carrying status + raw body
  - All errors extend `OpenDjError` so the route layer can map uniformly

  **File layout:**
  - `src/providers/streaming/spotify/SpotifyProvider.ts` — the provider class
  - `src/providers/streaming/spotify/client.ts` — thin SpotifyClient (where future refresh-on-401 retry will land)
  - `src/providers/streaming/spotify/errors.ts` — `NoActiveDeviceError`, `SpotifyApiError`

  **21 new tests** (120 total in backend) covering capability declaration, connect/disconnect/duck-type guards, search request shape + result mapping (multi-artist join, album-art selection), queueTrack URI encoding + the three error-translation paths (401 / 404 NO_ACTIVE_DEVICE / 5xx), getNowPlaying happy + null-item + null-device paths, playback-control endpoints, and volume read/set including clamp+round.

- [`d2e70f9`](https://github.com/viscoci/OpenDJ/commit/d2e70f9dc78e917a982fd6ac2ddfa0e36825b8e8) Thanks [@viscoci](https://github.com/viscoci)! - Add WebSocket realtime — `/api/v1/sessions/:id/realtime` upgrade route + per-process `RoomRegistryImpl` that materializes `NodeSessionRoom`s on demand.

  **`RoomRegistryImpl`** (`@opendj/backend/realtime/RoomRegistryImpl.ts`):
  - Implements `RealtimeRoomManager` (extends `RealtimeRoomRegistry`)
  - `forSession(id)` — read-only lookup (used by `QueueService` etc. to publish without creating)
  - `ensureRoom(id)` — lazily creates a `NodeSessionRoom` on first call; idempotent
  - `removeRoom(id)` — drops the entry (call on `session.ended`)
  - `size()` — diagnostic count

  **`realtimeRoutes(deps, upgradeWebSocket)`** (`@opendj/backend/routes/realtime.ts`):
  - Adapter-agnostic — takes an `UpgradeWebSocket` helper from `@hono/node-ws` (Node) or Cloudflare's WebSocketPair (Workers)
  - On connect: assigns a clientId, calls `room.connect`, subscribes a sender that JSON-stringifies every event, and sends an initial `{ type: '_snapshot', snapshot, sessionId }` payload so the client doesn't render blank until the next event
  - On close: `room.disconnect(clientId)`
  - No slot-token gate on the listener (queue is public to anyone with the QR slug); writes still gate via existing routes that publish to the room

  **`createDeps`** grows:
  - `realtime: 'in-process' | 'none'` option (default `'in-process'`) — when in-process, instantiates `RoomRegistryImpl` and exposes it as both `deps.rooms` (read-only view) and `deps.roomManager` (concrete manager)
  - Hosted Cloudflare deploys pass their own DO-backed registry via `options.rooms` and leave `roomManager` null

  **`createApp({ deps, upgradeWebSocket? })`:**
  - Mounts `/api/v1/sessions/:id/realtime` only when both `upgradeWebSocket` is provided AND `deps.roomManager` is non-null
  - All other routes work without the WS adapter

  **`apps/oss-demo` wiring:**
  - Adds `@hono/node-ws` dep
  - `main.ts` calls `createNodeWebSocket({ app: tempApp })` for the upgrade helper, passes it to a real `createApp`, and `injectWebSocket(server)` after `serve()`
  - Logs `WebSocket realtime ready at /api/v1/sessions/:id/realtime` on boot

  **7 new tests** (220 total in backend) covering RoomRegistryImpl invariants — empty start, ensureRoom idempotency + per-session isolation, removeRoom (including unknown-id no-op), forSession ↔ ensureRoom identity. WS protocol-level tests deferred since they're adapter-specific (would need a live HTTP server + ws client per test).

- [`a7d2c43`](https://github.com/viscoci/OpenDJ/commit/a7d2c43c54676ce4e4c2001307dd121b296ac326) Thanks [@viscoci](https://github.com/viscoci)! - Wire `createApp` end-to-end. The Hono app factory now mounts every route written so far under `/api/v1`, and `createDeps` assembles the full service graph from a `Config` plus either a Drizzle `Database` or a pre-built `Repositories` instance.

  **`AppDeps`** grows to include:
  - `repositories` (the full `Repositories` aggregate)
  - `authService`, `claimsService`, `guestIdentityService`, `sessionService`, `queueService`
  - `streamingRouter` + `streamingProviderOAuthConfigs`
  - `rooms: RealtimeRoomRegistry` (defaults to a no-op until WS lands)

  **`createDeps(options)`:**
  - Accepts either `db` (auto-builds Drizzle repositories) or `repositories` (test-provided in-memory)
  - Throws when neither is supplied
  - Default streaming `ProviderRegistry` wires `spotify` (full impl), `soundtrack` (stub), `apple-music` (stub)
  - `fetchImpl` injectable so Workers can supply outbound bindings + tests stay offline
  - Default `rooms` is a `forSession() => null` no-op — the WS slice swaps in a real `NodeSessionRoom`-per-session registry

  **`createApp({ deps })`** mounts:
  - `/api/v1/health`
  - `/api/v1/auth/*` (`/me`, `/logout`, `/switch-account`)
  - `/api/v1/guest/*` (`/identity`, `/heartbeat`, `/slot`)
  - `/api/v1/sessions` + `/api/v1/sessions/:id` + `/api/v1/sessions/:id/queue/*`
  - `/api/v1/provider/connections/:provider/{start,callback}`

  **6 new tests** (195 total in backend) covering the wiring: health works after deps wire-up, every mounted route is reachable (return code asserted on the auth/validation gate), `createDeps` throws when missing both `db` and `repositories`, Spotify config flows through.

- [`3e61666`](https://github.com/viscoci/OpenDJ/commit/3e6166682a272f1e206267923976a53206ac13a1) Thanks [@viscoci](https://github.com/viscoci)! - Email verification + password reset flows + drizzle-kit migration generation working.

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

- [`e5336c3`](https://github.com/viscoci/OpenDJ/commit/e5336c35f8a4630893a354c0306d6d383c727c58) Thanks [@viscoci](https://github.com/viscoci)! - Host dashboard + multiple frontend↔backend wire-shape fixes.

  **Backend (`@opendj/backend`)**
  - `SessionService.getBySlug(qrSlug)` + `GET /api/v1/sessions/by-slug/:slug` route. Public read for the guest landing page.
  - `GET /api/v1/sessions` was already wired; this commit confirms the path lines up with the frontend client.

  **Frontend client (`@opendj/frontend`) — wire-shape corrections**

  These were latent mismatches from the first client cut, surfaced now that real components consume them:
  - Slot tokens go via `Authorization: Bearer <token>`, NOT `x-slot-token` (matches backend's `bearerFromAuthHeader`).
  - Guest identity lives at `/api/v1/guest/identity` (not under `/sessions/:id/...`) and takes `{ fingerprintHash, eventSlug }` (not `{ fingerprint, name }`).
  - Heartbeat at `/api/v1/guest/heartbeat`, slot token via Bearer.
  - `GuestIdentityResponse` now has `status: 'active' | 'queued' | 'priority_queued'` (matches `GuestSlotStatus`) instead of a `queued: boolean`. `queuePosition` is optional, present only when status isn't `'active'`.
  - `SessionsApi.end` uses `DELETE /:id` (matches backend's `app.delete('/:id', ...)`); previously used `POST /:id/end` which never matched a route.
  - `QueueApi.moderate` uses `PATCH /queue/:itemId` with `{ decision }` (matches backend); previously POSTed to `/queue/:itemId/moderate`.
  - `SessionsApi.listForCurrentAccount()` added.

  **Frontend template (`@opendj/frontend-template`) — host dashboard**

  Three new pages:
  - `/host/login` — email+password login OR register tab toggle, plus a "Sign in with Google" link to `/api/v1/auth/oauth/google/start`. Apple/Facebook absent (501 on the backend; surfacing a button that always errors is worse than no button).
  - `/host/dashboard` — lists current account's sessions, with a "Start a new session" form. Auto-redirects to the new session detail on success.
  - `/host/sessions/:id` — queue moderation surface. Approve/Reject buttons on `pending` items, end-session control, copyable guest URL. Subscribes to `/api/v1/sessions/:id/realtime` for live updates.

  Plus:
  - `AuthService` (signal-backed `state: 'unknown' | 'anonymous' | 'authenticated'`) + `hostGuard` `CanActivateFn` that redirects to `/host/login?redirectTo=...` on 401.
  - `getOrCreateGuestFingerprintHash()` now returns a SHA-256 of the local random — the raw value never leaves the device. The backend re-salts with `(eventSlug, isoDate)` before persistence.
  - Existing `GuestRequestPage` updated to the corrected guest identity contract.

  **Build**: `ng build` produces 286 kB raw / 74 kB gzip initial bundle (up from 256 kB / 68 kB; the 30 kB delta is the three new host pages).

  **Tests**: 4 new frontend client tests (Bearer slot-token forwarding, moderate PATCH path, guest identity body shape, heartbeat). Backend at 278 / frontend at 31 / template at 2 — all green.

### Patch Changes

- [`ef0dac9`](https://github.com/viscoci/OpenDJ/commit/ef0dac9440409e104e22d7f11dbcd832ba6d380c) Thanks [@viscoci](https://github.com/viscoci)! - Wire `apps/oss-demo` to actually boot — the OSS reference deploy now starts a real Hono server via `@hono/node-server`.

  **`apps/oss-demo/src/main.ts`:**
  - Loads config from `process.env` via `loadConfig`; pretty-prints `ConfigError` issues and exits 1 on misconfigured boots
  - Builds `createDeps({ config, db: createDb(config.databaseUrl) })` with the full Drizzle stack
  - Mounts `createApp` (every route from /api/v1/health onward) on the configured `PORT` (default 8888)
  - Logs Spotify-not-configured warning when `SPOTIFY_CLIENT_ID/SECRET` are unset
  - Graceful SIGINT/SIGTERM shutdown with a 5s hard-timeout safety net

  **`package.json` updates:**
  - Adds `@hono/node-server`, `@opendj/backend`, `@opendj/db` (workspace), `hono` deps
  - `start` runs Node 22's `--experimental-strip-types` so TypeScript executes directly with no build step
  - New `db:migrate` script delegates to `pnpm --filter @opendj/db db:generate` for schema-driven migration generation

  **README rewrite:** quickstart with `docker compose up`, local-dev path with Drizzle migrate + start, what's not yet wired (WS realtime, login OAuth, email/password), how to verify without a running server.

  Drizzle-kit migration generation has a known ESM/.js-extension incompatibility at `drizzle-kit@0.28` — running `db:generate` requires an upgrade or a small config tweak. Boot wiring itself is correct and the typecheck pipeline is green; the demo can be brought all the way up once that's resolved.

- [#13](https://github.com/viscoci/OpenDJ/pull/13) [`8515474`](https://github.com/viscoci/OpenDJ/commit/8515474c33598c56b824e7d9b2562ecfe8d1fe83) Thanks [@viscoci](https://github.com/viscoci)! - Publish metadata: tarballs now resolve `main`/`types`/`exports` from `dist/` via `publishConfig`; `@opendj/db` tarballs include `migrations/*.sql`.

- Updated dependencies [[`945b5cc`](https://github.com/viscoci/OpenDJ/commit/945b5cceec0e92cb9a9a875fb0e03cc43dca4b7d), [`cc9a8a1`](https://github.com/viscoci/OpenDJ/commit/cc9a8a18bc793664ca556bcc5cc8cccb91912694), [`ef08795`](https://github.com/viscoci/OpenDJ/commit/ef0879525eff538507c6da6d1aacdefa7c40d7e4), [`ce9853a`](https://github.com/viscoci/OpenDJ/commit/ce9853aa966b9aee3a76e364ced9d5585e2fa80b), [`8314674`](https://github.com/viscoci/OpenDJ/commit/8314674f1ce0bbbcc214b5b8d619e43be01f8b15), [`197df0f`](https://github.com/viscoci/OpenDJ/commit/197df0f67e61013b5f3a20b869cab6de74cd4e1e), [`1ab1006`](https://github.com/viscoci/OpenDJ/commit/1ab100680c03b2e2954c0118e7780f8605d19e86), [`3e61666`](https://github.com/viscoci/OpenDJ/commit/3e6166682a272f1e206267923976a53206ac13a1), [`3b33536`](https://github.com/viscoci/OpenDJ/commit/3b3353675c3c39740b68d674ca53799b616cd737), [`8515474`](https://github.com/viscoci/OpenDJ/commit/8515474c33598c56b824e7d9b2562ecfe8d1fe83), [`d6d91a4`](https://github.com/viscoci/OpenDJ/commit/d6d91a44fad63e2ec69bc6dcbaf283ade16fec0f), [`f865239`](https://github.com/viscoci/OpenDJ/commit/f865239b7a7d4e86e9f80a333ece0f3fc9a92d8e), [`e921030`](https://github.com/viscoci/OpenDJ/commit/e92103056952c6c73d328d95790169b87ea678b9)]:
  - @opendj/abuse@0.1.0
  - @opendj/core@0.1.0
  - @opendj/auth@0.1.0
  - @opendj/db@0.1.0
  - @opendj/lyrics@0.1.0
  - @opendj/sync@0.1.0
  - @opendj/realtime@0.1.0
