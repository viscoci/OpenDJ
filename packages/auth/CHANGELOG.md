# @opendj/auth

## 0.1.1

### Patch Changes

- Updated dependencies [[`c4ba271`](https://github.com/viscoci/OpenDJ/commit/c4ba271813c9c2913d9b666e353bd1d47e09a46f)]:
  - @opendj/core@0.2.0

## 0.1.0

### Minor Changes

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

### Patch Changes

- [#13](https://github.com/viscoci/OpenDJ/pull/13) [`8515474`](https://github.com/viscoci/OpenDJ/commit/8515474c33598c56b824e7d9b2562ecfe8d1fe83) Thanks [@viscoci](https://github.com/viscoci)! - Publish metadata: tarballs now resolve `main`/`types`/`exports` from `dist/` via `publishConfig`; `@opendj/db` tarballs include `migrations/*.sql`.

- Updated dependencies [[`945b5cc`](https://github.com/viscoci/OpenDJ/commit/945b5cceec0e92cb9a9a875fb0e03cc43dca4b7d), [`cc9a8a1`](https://github.com/viscoci/OpenDJ/commit/cc9a8a18bc793664ca556bcc5cc8cccb91912694), [`ce9853a`](https://github.com/viscoci/OpenDJ/commit/ce9853aa966b9aee3a76e364ced9d5585e2fa80b), [`8314674`](https://github.com/viscoci/OpenDJ/commit/8314674f1ce0bbbcc214b5b8d619e43be01f8b15), [`1ab1006`](https://github.com/viscoci/OpenDJ/commit/1ab100680c03b2e2954c0118e7780f8605d19e86), [`3b33536`](https://github.com/viscoci/OpenDJ/commit/3b3353675c3c39740b68d674ca53799b616cd737), [`8515474`](https://github.com/viscoci/OpenDJ/commit/8515474c33598c56b824e7d9b2562ecfe8d1fe83), [`f865239`](https://github.com/viscoci/OpenDJ/commit/f865239b7a7d4e86e9f80a333ece0f3fc9a92d8e), [`e921030`](https://github.com/viscoci/OpenDJ/commit/e92103056952c6c73d328d95790169b87ea678b9)]:
  - @opendj/core@0.1.0
