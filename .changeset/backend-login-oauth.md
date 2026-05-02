---
'@opendj/backend': minor
---

Add login OAuth scaffolding: `LoginAuthService` + `LoginProviderHandler` registry + `/api/v1/auth/oauth/:provider/{start,callback}` routes.

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
