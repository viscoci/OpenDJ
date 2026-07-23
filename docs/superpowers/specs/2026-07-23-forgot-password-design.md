# Forgot Password flow — design

Date: 2026-07-23. Status: approved (design approved in-session).

## Problem

Backend ships a complete password-reset flow (`POST /api/v1/auth/email/request-reset`, `POST /api/v1/auth/email/reset`; `PasswordResetService` emails a link to `/host/reset-password?token=…`), but the frontend has no way to trigger it and no page at the linked route — the emailed link 404s. Users who forget their password are locked out unless someone drives the API by hand.

## Scope

Frontend only. No backend changes — the contract is fixed:

- `POST /api/v1/auth/email/request-reset` body `{ email }` → always `{ ok: true }` (no user-existence leak).
- `POST /api/v1/auth/email/reset` body `{ token, newPassword }` → `{ ok, userId }`; error codes `invalid_or_expired_token`, `invalid_password` (8–200 chars). Success revokes all existing sessions.

## Design

1. **`@opendj/frontend` `AuthApi`** (`packages/frontend/src/api/auth.ts`): add
   - `requestPasswordReset(email: string): Promise<void>`
   - `resetPassword(token: string, newPassword: string): Promise<void>`
2. **Login page** (`packages/frontend-template/src/app/pages/host/host-login.page.ts`): add a "Forgot password?" link visible in login mode. Clicking switches the card to a third mode `forgot` (not a tab): email-only form. Submit calls `requestPasswordReset`; on success show "If an account exists for that email, a reset link has been sent." plus demo note "Self-hosted demo without SMTP: the link prints to the server console." Back-to-sign-in link returns to login mode.
3. **New route `/host/reset-password`** (`packages/frontend-template/src/app/pages/host/host-reset-password.page.ts`): standalone component matching the login card's pattern (signals, OnPush, same styles). Reads `token` from the query string. Fields: new password + confirm (client-side match + minlength 8). Submit calls `resetPassword`; success → navigate to `/host/login` (login page shows "Password updated — sign in."). No/invalid token → error message + link to `/host/login` to request a fresh one.
4. **Tests**: extend `packages/frontend/tests/api/resources.test.ts` with URL/method/body assertions for both new methods (existing smoke-test pattern). Template package has no page-test precedent — pages verified by typecheck + live E2E against the running stack.

## Alternatives rejected

- Separate `/host/forgot-password` page — extra route/file, no benefit over an in-page mode.
- Raw `fetch` in components — bypasses the typed `OpenDjClient` pattern.

## Verification

- `pnpm turbo run typecheck test` green.
- Rebuild `apps/oss-demo` container; drive the real flow: forgot → console link → reset page → login with new password.
