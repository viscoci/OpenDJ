# Roadmap

This roadmap mirrors the priority list from [`docs/agent-brief.md`](./docs/agent-brief.md). It tracks what's landed, what's next, and what intentionally stays out of this repo.

Status legend: ✅ done · 🔄 in progress · ⏳ planned · ⛔ out of scope (lives in private `opendj-live`)

## P0 — foundation

| Status | Item                                                                                                                                                                                                                                               |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ✅     | Monorepo scaffold (pnpm + Turborepo + strict TS + Vitest + ESLint + Prettier)                                                                                                                                                                      |
| ✅     | OSS conventions (MIT, Contributor Covenant, DCO, Conventional Commits, Changesets, dependabot)                                                                                                                                                     |
| ✅     | `IStreamingProvider` base interface + modular `ISupports*` feature interfaces + capability descriptors                                                                                                                                             |
| ✅     | `SpotifyProvider` implementing the interface using fetch (no SDK)                                                                                                                                                                                  |
| ✅     | `StreamingRouter` + explicit provider registry wiring                                                                                                                                                                                              |
| ✅     | Public package boundaries published (`@opendj/core`, `@opendj/db`, `@opendj/auth`, `@opendj/backend`, `@opendj/realtime`, `@opendj/abuse`, `@opendj/sync`, `@opendj/lyrics`, `@opendj/frontend`, `@opendj/frontend-template`, `@opendj/app-shell`) |
| ✅     | Drizzle schema + migrations (users, accounts, auth, sessions, queue, slots, lyrics, abuse) — generated + applied on boot                                                                                                                           |
| ✅     | Realtime room abstraction: `RealtimeRoom`, `SessionSnapshot`, `SessionEvent`, `SessionCommand`                                                                                                                                                     |
| ✅     | OSS `NodeSessionRoom` in-process realtime implementation                                                                                                                                                                                           |
| 🔄     | Sync primitives: `@opendj/sync` + `PlaybackClockSample` + normalized progress + `SongSyncAdapter`                                                                                                                                                  |
| 🔄     | Lyrics/karaoke: `@opendj/lyrics` + LRCLIB adapter + LRC parser + lyrics cache + feedback capture                                                                                                                                                   |
| ✅     | Auth & claims: OAuth/OIDC login (Google), email/password fallback (Argon2id), email verification, password reset, sessions, claim middleware, account membership, account bootstrap                                                                |
| ✅     | Abuse prevention: action signal capture, rolling-window rate limits, risk scoring                                                                                                                                                                  |
| ✅     | Core queue logic: `canEnqueue`, `enforcePerGuestCap`, `dedupeQueue`, `canSkip`                                                                                                                                                                     |
| ✅     | Generic music-provider OAuth routes (Spotify connected via host dashboard)                                                                                                                                                                         |
| ✅     | Guest identity + slot system + bearer-token auth                                                                                                                                                                                                   |
| ✅     | Angular 21 OSS frontend template — guest request page                                                                                                                                                                                              |
| ✅     | Angular 21 OSS frontend template — host login + dashboard + session moderation                                                                                                                                                                     |
| 🔄     | Docker Compose OSS demo — boots end-to-end; CI smoke test still pending                                                                                                                                                                            |

## P1

| Status | Item                                                        |
| ------ | ----------------------------------------------------------- |
| ⏳     | Vote-to-skip (fixed / percentage / host approval)           |
| ⏳     | Host onboarding (no-device warning, OAuth error states)     |
| ⏳     | Soundtrack Your Brand provider                              |
| ⏳     | Apple / Facebook OAuth login (currently 501 stubs)          |
| ⏳     | QR code generation (PNG + PDF)                              |
| ⏳     | TV fullscreen view with synced lyrics display               |
| ⏳     | Host settings (all sections)                                |
| ⏳     | Session creation wizard                                     |
| ⏳     | Logged-in guest UX (account link, profile, request history) |
| ⏳     | Playwright e2e — guest → host moderation flow               |

## P2

| Status | Item                                        |
| ------ | ------------------------------------------- |
| ⏳     | `@opendj/agent-tools` MCP server (dev-only) |

## Out of scope here (lives in private `opendj-live`)

| Status | Item                                                                               |
| ------ | ---------------------------------------------------------------------------------- |
| ⛔     | Hosted Cloudflare deployment (`opendj.live`, `app.opendj.live`, `api.opendj.live`) |
| ⛔     | Cloudflare Workers + Durable Objects + Hyperdrive hosted layer                     |
| ⛔     | Billing, subscriptions, payment provider integration                               |
| ⛔     | Branding Studio, white-label, hosted product analytics                             |
| ⛔     | Capacitor iOS/Android wrapper (`opendj-live/apps/mobile`)                          |
| ⛔     | Desktop shell experiment                                                           |

## Want to help?

Pick something marked ⏳ and open a Discussion to coordinate. Look for issues labeled [`good first issue`](https://github.com/viscoci/opendj/labels/good%20first%20issue).
