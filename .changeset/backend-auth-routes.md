---
'@opendj/backend': minor
---

Add `/api/v1/auth/{me,logout,switch-account}` routes plus session-cookie helpers.

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
