# Roadmap

This roadmap mirrors the priority list from [`docs/agent-brief.md`](./docs/agent-brief.md). It tracks what's landed, what's next, and what intentionally stays out of this repo.

Status legend: ✅ done · 🔄 in progress · ⏳ planned · ⛔ out of scope (lives in private `opendj-live`)

## P0 — foundation (every line item shipped)

| Status | Item                                                                                                                                                                                                                                               |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ✅     | Monorepo scaffold (pnpm + Turborepo + strict TS + Vitest + ESLint + Prettier)                                                                                                                                                                      |
| ✅     | OSS conventions (MIT, Contributor Covenant, DCO, Conventional Commits, Changesets, dependabot)                                                                                                                                                     |
| ✅     | `IStreamingProvider` base interface + modular `ISupports*` feature interfaces + capability descriptors (Search, NowPlayingRead, QueueTrack, SkipTrack, Pause, Resume, VolumeRead, VolumeSetAbsolute, **DevicesRead, DeviceTransferPlayback**)      |
| ✅     | `SpotifyProvider` implementing all the above using fetch (no SDK)                                                                                                                                                                                  |
| ✅     | `StreamingRouter` + explicit provider registry wiring                                                                                                                                                                                              |
| ✅     | Public package boundaries published (`@opendj/core`, `@opendj/db`, `@opendj/auth`, `@opendj/backend`, `@opendj/realtime`, `@opendj/abuse`, `@opendj/sync`, `@opendj/lyrics`, `@opendj/frontend`, `@opendj/frontend-template`, `@opendj/app-shell`) |
| ✅     | Drizzle schema + migrations (users, accounts, auth, sessions, queue items, **queue_skip_votes**, slots, lyrics, abuse) — generated + applied on boot                                                                                               |
| ✅     | Realtime room abstraction: `RealtimeRoom`, `SessionSnapshot` (now with `recentlyPlayed`), `SessionEvent`, `SessionCommand`                                                                                                                         |
| ✅     | OSS `NodeSessionRoom` in-process realtime implementation                                                                                                                                                                                           |
| ✅     | **`NowPlayingPoller`** — per-room 5s tick that calls `provider.getNowPlaying()` and publishes diffs. Lifecycle driven by WS subscriber count + 30s idle grace. Handles 401 (stop), 429 (exp backoff), transient (continue).                        |
| ✅     | **Playback control routes** — `POST /sessions/:id/playback/{skip,pause,resume}` gated by `provider:control_playback`                                                                                                                               |
| ✅     | **Spotify Connect device routes** — `GET /sessions/:id/devices` + `POST /sessions/:id/devices/:deviceId/activate`                                                                                                                                  |
| ✅     | **Public TV snapshot route** — `GET /sessions/by-slug/:slug/tv-snapshot` for the casting page (no auth)                                                                                                                                            |
| 🔄     | Sync primitives: `@opendj/sync` + `PlaybackClockSample` + normalized progress + `SongSyncAdapter` (basic types in place; cross-provider clock alignment is hosted's polish layer)                                                                  |
| 🔄     | Lyrics/karaoke: `@opendj/lyrics` + LRCLIB adapter + LRC parser + lyrics cache + feedback capture (lookup service in place; rendering UI lives in `opendj-live`)                                                                                    |
| ✅     | Auth & claims: OAuth/OIDC login (Google), email/password fallback (Argon2id), email verification, password reset, sessions, claim middleware, account membership, account bootstrap                                                                |
| ✅     | Abuse prevention: action signal capture, rolling-window rate limits, risk scoring                                                                                                                                                                  |
| ✅     | Core queue logic: `canEnqueue`, `enforcePerGuestCap`, `dedupeQueue`, `canSkip`, **persistent skip-vote dedupe** (`queue_skip_votes` table)                                                                                                         |
| ✅     | Generic music-provider OAuth routes (Spotify connected via host dashboard)                                                                                                                                                                         |
| ✅     | Guest identity + slot system + bearer-token auth                                                                                                                                                                                                   |
| ✅     | Angular 21 OSS frontend template — guest request page (live Spotify search, now-playing, recently-played, queue with skip-vote pill)                                                                                                               |
| ✅     | Angular 21 OSS frontend template — host login + dashboard + session moderation (now-playing card with skip/pause/resume, QR code, device picker, recently-played)                                                                                  |
| ✅     | Angular 21 OSS frontend template — public `/tv/:slug` page (read-only fullscreen casting view)                                                                                                                                                     |
| ✅     | Reusable Angular components in `@opendj/frontend-template/src/app/components/`: `NowPlayingCard`, `QrCode`, `SearchResultList`, `QueueList`, `RecentlyPlayedList`, `DevicePicker`                                                                  |
| 🔄     | Docker Compose OSS demo — boots end-to-end with migrations + frontend bundle; CI smoke test still pending                                                                                                                                          |

## P1

| Status | Item                                                                                                        |
| ------ | ----------------------------------------------------------------------------------------------------------- |
| ⏳     | Vote-to-skip auto-trigger when threshold crosses (currently records the vote + publishes the count)         |
| ⏳     | Apple / Facebook OAuth login (currently 501 stubs)                                                          |
| ⏳     | QR code download (PNG/PDF) + printable poster (component renders SVG only today)                            |
| ⏳     | Logged-in guest UX (account link, profile, request history)                                                 |
| ⏳     | Playwright e2e — guest → host moderation flow                                                               |
| ⏳     | CI smoke test for `apps/oss-demo` (`docker compose config` + curl /health)                                  |
| ⏳     | Bulk request route (`POST /queue/bulk`) for "queue all from playlist"                                       |
| ⏳     | Provider playlists read (`ISupportsPlaylistsRead` + Spotify impl + `GET /sessions/:id/playlists/:provider`) |

## P2

| Status | Item                                        |
| ------ | ------------------------------------------- |
| ⏳     | `@opendj/agent-tools` MCP server (dev-only) |

## Out of scope here (lives in private `opendj-live`)

The hosted product (`opendj.live`) builds on these libraries and adds the polished UX + monetized layers. The boundary is deliberate — every line below stays out of OSS so self-hosters can run a useful demo without competing with the hosted product:

| Status | Item                                                                                                                                                                 |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ⛔     | **Branding Studio** — host-uploaded logo, custom fonts, accent colors, copy editing, template gallery                                                                |
| ⛔     | **Multi-zone billing** + zone-detail UI ("Patio · Sonos Move 2 · 24 listeners" view, per-zone crossfade controls)                                                    |
| ⛔     | **Polished TV layouts** — overlay / centered / split lyrics layouts, full-bleed album-art backdrops, sponsor strip                                                   |
| ⛔     | **Lyrics rendering** on guest + TV (synced / unsynced / missing / paused; classic / subtle / theatrical / word-highlight active-line styles; report-bad-lyric sheet) |
| ⛔     | **Analytics dashboard** + CSV export (volume chart, top tracks, KPI strip, safety summary mini-card)                                                                 |
| ⛔     | **Smart sets** — auto-generated playlists from event history (just-played-clean, crowd-discovered, fresh-blood)                                                      |
| ⛔     | **Onboarding wizard** — 4-step welcome → connect → device picker (OSS demo goes register → dashboard directly)                                                       |
| ⛔     | **Account drawer with multi-venue history** + "venues nearby" + playlist sync + save-to-playlist                                                                     |
| ⛔     | **Smart ad after request** ("Pro hides ads" upsell)                                                                                                                  |
| ⛔     | **Pricing / billing / Stripe / upgrade modals**                                                                                                                      |
| ⛔     | **DJ-for-an-Event service** — pre-event consult, live mixing, branded guest page, post-event recap                                                                   |
| ⛔     | **Five-variant OAuth error screens** (denied / no premium / missing scopes / timeout / network)                                                                      |
| ⛔     | **Re-auth banner with reconnect modal** (loading / success / failure variants)                                                                                       |
| ⛔     | **Session ended recap** with stats grid + safety summary                                                                                                             |
| ⛔     | Hosted Cloudflare deployment (`opendj.live`, `app.opendj.live`, `api.opendj.live`)                                                                                   |
| ⛔     | Cloudflare Workers + Durable Objects + Hyperdrive hosted layer                                                                                                       |
| ⛔     | Capacitor iOS/Android wrapper (`opendj-live/apps/mobile`)                                                                                                            |

## Want to help?

Pick something marked ⏳ and open a Discussion to coordinate. Look for issues labeled [`good first issue`](https://github.com/viscoci/opendj/labels/good%20first%20issue).
