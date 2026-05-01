---
'@opendj/auth': minor
'@opendj/core': patch
---

Land `@opendj/auth` runtime-neutral foundations.

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
