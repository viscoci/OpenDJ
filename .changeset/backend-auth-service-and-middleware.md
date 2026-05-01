---
'@opendj/backend': minor
---

Add `AuthService` and Hono auth middleware.

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
