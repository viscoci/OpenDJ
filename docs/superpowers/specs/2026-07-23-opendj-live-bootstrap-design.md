# OpenDJ.live — Bootstrap + Core App (Sub-project 1) — Design

**Date:** 2026-07-23
**Status:** Approved by Ethan (section-by-section review in brainstorming session)
**Scope:** First sub-project of the full-fledged OpenDJ product. Covers the foundation publish pipeline, the new private product repo, the free-tier core app built to the design prototypes, and the first production deploy at opendj.com.

---

## 1. Context and goal

The OpenDJ repo (`github.com/viscoci/OpenDJ`) is the public, portfolio-grade foundation: reusable `@opendj/*` packages plus an OSS reference deploy. `docs/REPO_BOUNDARY.md` deliberately excludes product polish — billing, Branding Studio, zones, analytics, guest-account UX, native shells, vendor deploy config. Those belong in a downstream consumer.

This design starts that consumer: **opendj-live**, the full-fledged product. It consumes the foundation as published packages, implements the Claude Design prototypes in `docs/designs/OpenDJ.live/` faithfully, and ships as a real deploy at **opendj.com**.

**Product target:** flagship portfolio deploy. Real billing/branding/zones get built in later sub-projects and are demoable, but hosts are Ethan plus allowlisted friends (Spotify Development Mode allows 5 users per Client ID; extended quota is unavailable to indies). Commercial SaaS is not the near-term goal; the Spotify cap is accepted. BYO-Client-ID mode is deferred.

## 2. Decisions made

| Decision               | Choice                                                                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Foundation consumption | Build + publish pipeline now; opendj-live pins exact published versions                                                                 |
| Product repo           | `github.com/viscoci/opendj-live`, **private**                                                                                           |
| Runtime                | Node 22 on home server ("basement box") behind a cloudflared tunnel; Cloudflare Workers/DO migration deferred until there are customers |
| Frontend               | Angular 21 + Capacitor-ready architecture retained; implement the existing design prototypes (`docs/designs/OpenDJ.live/`) closely      |
| Domain                 | **opendj.com**                                                                                                                          |
| First slice            | Bootstrap + free-tier core app, deployed end-to-end                                                                                     |

## 3. Decomposition roadmap

Sub-project 1 (this spec) is the bootstrap. Each later sub-project gets its own spec → plan → implementation cycle, in rough priority order:

1. **Bootstrap + core app** (this spec)
2. Lyrics/karaoke surfaces (guest live view, three TV lyric layouts)
3. Guest accounts (OAuth sign-in, playlists, venues)
4. Billing + upgrade flow (Stripe) + plan-gate enforcement UI
5. Protection/abuse settings + analytics (PRO)
6. Branding Studio
7. Zone management
8. Host library + smart sets + playlist scheduling
9. Capacitor native shells (iOS/Android)
10. Workers/Durable Objects migration (when customers exist)

## 4. Foundation publish pipeline (work in the OpenDJ repo)

Foundation packages currently expose TS source (`main: ./src/index.ts`, no dist), so they cannot be consumed outside the workspace without builds.

- **Builds:** tsup (ESM + `.d.ts`) for the runtime-neutral packages: `core`, `db`, `auth`, `backend`, `realtime`, `abuse`, `sync`, `lyrics`, `app-shell`. ng-packagr for `@opendj/frontend`. `frontend-template` and `apps/oss-demo` remain unpublished (reference app code).
- **Entry points:** each package's `exports` points at `dist/` for publishing; workspace-internal development keeps resolving TS source via a `development` exports condition (tsconfig paths as fallback if Angular tooling misbehaves) so the existing DX inside the monorepo is unchanged.
- **Versioning:** Changesets, single version line, starting at `0.1.0`. GitHub Actions publishes on changeset-release merge.
- **npm scope:** claim the npm org `opendj` first (availability could not be verified from the registry — the org endpoints are auth-gated). If the scope is taken, fall back to `@viscoci/*` (public) and do a mechanical scope-rename sweep across the workspace before the first publish. This decision gate is step one of implementation.

## 5. opendj-live repo structure

```
opendj-live/                    private — github.com/viscoci/opendj-live
├── apps/
│   ├── web/                    Angular 21 SPA — the product frontend
│   └── server/                 Node 22 Hono host
├── packages/
│   └── theme/                  design tokens ported from wedj-tokens.css + shared UI primitives
├── deploy/
│   ├── docker-compose.yml      app + postgres (+ valkey later) + cloudflared
│   └── cloudflared/            tunnel config; credentials are NOT committed
├── docs/
│   ├── designs/                copy of docs/designs/OpenDJ.live — design source of truth
│   └── ...                     private specs, runbooks
├── pnpm-workspace.yaml
└── turbo.json
```

- pnpm + turborepo, mirroring the foundation's conventions.
- The server composes the foundation's `createDeps()`; product-specific configuration and overrides live here, never as forked copies of foundation code.
- Gaps discovered in the foundation (missing routes, template assumptions) are fixed **upstream**, released via changeset, and version-bumped here.

## 6. Frontend (apps/web)

- Angular 21: standalone components, signals, zoneless change detection, route-level lazy loading. Layout and routing stay Capacitor-compatible from day one; no native shell ships in this slice.
- **Design fidelity is the point.** Each design-canvas artboard maps to a route/component. `packages/theme` ports `wedj-tokens.css` (palette, type ramp, spacing, radii) into CSS custom properties + Angular theme wiring. Screens are built against tokens, not hardcoded values. PR review compares screenshots against the corresponding artboards.
- Reuse `@opendj/frontend` services where they fit (API client, realtime client, session state). UI components are new, matching the prototypes.
- State: Angular signals + the `@opendj/realtime` snapshot/event client over WebSocket. No NgRx or other global state library.

**Route map (slice 1):**

| Route                         | Screens (design-canvas sections)                                                                                        |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `/`                           | Landing (desktop + mobile)                                                                                              |
| `/login`, `/signup`, `/reset` | Host auth incl. reset-sent state (host-p1b L)                                                                           |
| `/onboarding`                 | Welcome → pick service → OAuth in progress → connected/device pick (onboarding 1–4), OAuth error variants (host-p1b K)  |
| `/dashboard`                  | Empty, active + pending, now-playing focus, settings (host A–D); mobile tabs (host-mobile A–C)                          |
| `/session/new`                | New session wizard (host-lifecycle B)                                                                                   |
| QR share                      | Share drawer (host-p1 I)                                                                                                |
| `/u/:slug`                    | Guest request page, all 9 states (guest A–G) incl. playback-unavailable                                                 |
| `/tv/:slug`                   | TV fullscreen base view (tv section; lyric layouts deferred to sub-project 2)                                           |
| Lifecycle                     | No-device + picker (desktop/mobile), re-auth banner/modal/success/failure, session-ended recap (host-lifecycle A, C, D) |

Free tier only: ad surfaces, PRO badges/gates render nothing in this slice.

## 7. Server (apps/server)

- Node 22 Hono app: mounts the foundation `/api/v1` route tree via `createDeps()`, serves the built SPA, handles the WebSocket upgrade into `NodeSessionRoom`.
- Product config layer: env-driven defaults; plan enforcement is the foundation's existing free-tier gates.
- Postgres schema comes entirely from foundation Drizzle migrations; **no new tables in slice 1**.

## 8. Deploy

- Basement box runs docker compose: `app`, `postgres`, and a `cloudflared` container in the same compose file; the tunnel points at `app:8888`.
- Cloudflare terminates TLS at the edge; the origin is reached over the tunnel, so the public origin is HTTPS and the foundation's `__Host-`/Secure cookies work unchanged.
- Spotify Developer app: add the production callback URL for opendj.com; allowlist hosts (5-user Development Mode cap accepted).
- Forgot-password email needs a real sender: default **Resend free tier** (Brevo as fallback). Slice 1 wires the env/config; no mail infrastructure is built.
- Backups: nightly `pg_dump` via cron to local disk plus an off-box copy.
- Home-box uptime is best effort — acceptable at portfolio stage.

## 9. Testing and CI

- opendj-live GitHub Actions: lint + typecheck + Vitest unit + build + docker compose boot smoke.
- Playwright smoke: signup → onboarding → create session → guest requests a song → request appears in dashboard pending list. Spotify is mocked via the foundation's fake-provider pattern; real-Spotify checks remain manual.
- Design fidelity gate: per-screen PR screenshots compared against canvas artboards (manual review; no pixel-diff tooling in this slice).

## 10. Error handling

- Foundation error contracts are reused verbatim: `no_active_device`, `guest_cap_reached`, `no_provider_connected`, `501 not_supported_by_provider`.
- The design canvas specs the error surfaces explicitly — OAuth denied / Premium required / missing scopes / timeout / no network, re-auth banner flow, no-device picker, session ended — and all of these are in slice 1 scope, built as designed.

## 11. Risks

| Risk                                                                  | Mitigation                                                                                            |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| npm `opendj` scope taken                                              | Decide at implementation step 1; fallback scope `@viscoci/*` with a rename sweep before first publish |
| First dist consumer shakes out packaging bugs (ng-packagr especially) | Budgeted as part of pipeline work; oss-demo can smoke-test built dists in foundation CI               |
| Home box availability                                                 | Best effort accepted; revisit when customers exist (Workers migration is sub-project 10)              |
| Spotify 5-host cap                                                    | Accepted for portfolio stage; BYO-Client-ID deferred                                                  |
| Mail deliverability for password reset                                | Managed sender (Resend/Brevo free tier), not self-hosted SMTP                                         |
