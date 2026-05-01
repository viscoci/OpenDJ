---
'@opendj/backend': minor
---

Add the streaming provider integration layer: stubs + registry + StreamingRouter.

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
