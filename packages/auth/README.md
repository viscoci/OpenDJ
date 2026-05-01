# @opendj/auth

OSS identity layer for OpenDJ. Hosts and logged-in guests are the same base `User` type.

Contents (planned — see [`docs/agent-brief.md`](../../docs/agent-brief.md) §"Authentication, accounts, and claims"):

- OAuth/OIDC login providers: Google, Apple, Facebook
- Email/password fallback (Argon2id default; pluggable `PasswordHasher` interface)
- Generic `OAuthProviderConfig`-driven flow (used for both login providers and music providers)
- Server-side sessions backed by `auth_sessions`; opaque session token in secure httpOnly cookie
- Account membership + claims model (`account:read`, `session:create`, `queue:moderate`, `provider:connect`, etc.)
- `requireAuth`, `requireClaim`, `requireAnyClaim`, `requireSessionGuest` middleware

Music-provider connections (Spotify, Soundtrack, etc.) live in `@opendj/backend` provider modules — they are separate from login identities.
