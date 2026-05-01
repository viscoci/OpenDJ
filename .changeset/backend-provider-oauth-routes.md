---
'@opendj/backend': minor
---

Add the generic music-provider OAuth routes — `/api/v1/provider/connections/:provider/{start,callback}` — that drive the Spotify (and future) connection flow.

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
