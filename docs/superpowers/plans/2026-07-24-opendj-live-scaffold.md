# opendj-live Scaffold Implementation Plan (Plan B)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Private repo `viscoci/opendj-live` running the demo app end-to-end from **published** `@opendj/*@0.2.0` packages, boot-verified locally via docker compose, ready for the cloudflared/opendj.com deploy (spec `2026-07-24-lyrics-sync-and-demo-deploy-design.md` §5 + `2026-07-24-tv-design-pass-design.md` §3).

**Architecture:** Direct implementation of the demo app: `apps/server` mirrors `apps/oss-demo` (createDeps/createApp, WS mount, static SPA serve) but resolves `@opendj/*` from npm; `apps/web` is a vendored copy of `frontend-template` with workspace deps swapped for npm versions and a self-contained tsconfig. `deploy/` carries compose (app + postgres + cloudflared). The TV design pass (Plan C) lands on top of `apps/web` afterwards.

**Tech Stack:** pnpm workspace (no turbo tonight), Node 22, Angular 21, Docker Compose, published `@opendj/*@0.2.0`.

## Global Constraints

- **Blocked on:** `@opendj/*@0.2.0` live on npm (verify with `npm view @opendj/backend version` → `0.2.0` before Task 2).
- New repo working dir: `d:\Repositories\opendj-live`. Foundation repo is READ-ONLY reference (copy from it; never modify it).
- All `@opendj/*` deps pinned EXACTLY (`"0.2.0"`, no `^`).
- Repo is private → no DCO/commitlint hooks required; still use Conventional Commits (`git commit -m`, `-s` optional). No changesets in this repo.
- Never commit secrets: `.env`, tunnel tokens → `.gitignore`; ship `.env.example` only.
- Windows dev box; commands PowerShell-compatible.

---

### Task B1: Repo + workspace skeleton (repo creation = MANUAL Ethan step)

**Files:** Create `d:\Repositories\opendj-live\{package.json, pnpm-workspace.yaml, .gitignore, .npmrc, README.md}`

**Interfaces:**

- Produces: initialized git repo on `main`, pushed to `github.com/viscoci/opendj-live` (private — **Ethan creates the empty repo on GitHub web first**, no gh CLI). Workspace globs `apps/*`.

- [ ] Step 1: **MANUAL (Ethan):** create empty private repo `opendj-live` under `viscoci` on github.com (no README/license/gitignore — fully empty).
- [ ] Step 2: Scaffold locally:

```jsonc
// package.json
{
  "name": "opendj-live",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.0.0", "pnpm": ">=9.0.0" },
  "packageManager": "pnpm@9.15.4",
  "scripts": {
    "build": "pnpm --filter @opendj-live/web build && pnpm --filter @opendj-live/server build",
    "dev:server": "pnpm --filter @opendj-live/server dev",
  },
}
```

```yaml
# pnpm-workspace.yaml
packages:
  - 'apps/*'
```

`.gitignore`: `node_modules/`, `dist/`, `.angular/`, `.env`, `*.tgz`, `.DS_Store`, `deploy/cloudflared/*.json`. `.npmrc`: `engine-strict=true`. README: two paragraphs — what this repo is (private product deploy of OpenDJ consuming published `@opendj/*`), how to run (`pnpm install`, compose up in deploy/).

- [ ] Step 3: `git init -b main`, commit `chore: workspace skeleton`, `git remote add origin https://github.com/viscoci/opendj-live.git`, push.

---

### Task B2: apps/server from the oss-demo pattern

**Files:** Create `apps/server/{package.json, tsconfig.json, src/main.ts, Dockerfile}`

**Interfaces:**

- Consumes: foundation reference `d:\Repositories\opendj\apps\oss-demo\{src/main.ts, package.json, Dockerfile, tsconfig.json}` — copy and adapt.
- Produces: `@opendj-live/server` — `pnpm build` (tsc) + `node dist/main.js` boots the API on `PORT` (default 8888) and serves the SPA from `../web/dist/opendj-template/browser` (confirm the exact Angular output path from apps/web's build in Task B3; oss-demo's main.ts shows the pattern + env override `STATIC_DIR`).

- [ ] Step 1: Copy `apps/oss-demo/src/main.ts` → `apps/server/src/main.ts`. Adapt: static-serve path env default points at the sibling web build; everything else (createDeps, createApp, WS mount, migrations, graceful shutdown) stays byte-identical — imports (`@opendj/backend`, `@opendj/db`, ...) resolve from npm now.
- [ ] Step 2: `package.json`: name `@opendj-live/server`; copy oss-demo's deps but pin every `@opendj/*` to `"0.2.0"` and keep third-party deps at oss-demo's ranges; scripts `build: tsc -p tsconfig.json`, `dev: tsx src/main.ts`, `start: node dist/main.js`. `tsconfig.json`: standalone (no monorepo extends) — `target ES2022, module ESNext, moduleResolution bundler, strict true, outDir dist, rootDir src, declaration false, skipLibCheck true`.
- [ ] Step 3: Dockerfile: copy oss-demo's, adjust paths (build context = repo root; install with `pnpm install --frozen-lockfile`, build web then server, runtime image runs `node apps/server/dist/main.js`).
- [ ] Step 4: Verify: `pnpm install` at repo root resolves 0.2.0 from npm (no workspace links: `pnpm why @opendj/backend` shows registry version). `pnpm --filter @opendj-live/server build` green.
- [ ] Step 5: Commit `feat: server app consuming published @opendj packages`.

---

### Task B3: apps/web — vendor frontend-template

**Files:** Create `apps/web/` = copy of `d:\Repositories\opendj\packages\frontend-template\` (src, public, angular.json, tsconfig\*.json, .prettierrc — skip node_modules/dist/.angular/.turbo)

**Interfaces:**

- Produces: `@opendj-live/web` — `pnpm build` produces the Angular browser bundle the server serves. All `@opendj/*` imports resolve from npm 0.2.0.

- [ ] Step 1: Copy the tree. `package.json`: rename to `@opendj-live/web`, drop `private` changes not needed (keep private true), replace every `@opendj/*: workspace:*` dep with `"0.2.0"`; keep Angular deps at the template's versions; scripts as in template (`build: ng build`, `test` optional tonight).
- [ ] Step 2: tsconfigs: the template's tsconfig extends the monorepo base — inline the needed compilerOptions into a local `tsconfig.json` (copy the foundation's `tsconfig.base.json` compilerOptions MINUS the `paths` block — npm packages must resolve normally) and keep `tsconfig.app.json` extending it. Remove any `@opendj/*` paths mappings.
- [ ] Step 3: Verify: `pnpm --filter @opendj-live/web build` green; output path noted and wired into server's `STATIC_DIR` default (Task B2 step 1 — fix up now if it differs).
- [ ] Step 4: Commit `feat: vendor frontend-template as apps/web`.

---

### Task B4: deploy/ compose + boot verification

**Files:** Create `deploy/{docker-compose.yml, .env.example}`

**Interfaces:**

- Consumes: B2 Dockerfile; foundation reference `apps/oss-demo/docker-compose.yml`.
- Produces: `docker compose -f deploy/docker-compose.yml up --build -d` → app healthy on 8888 + postgres; `cloudflared` service present but only started with `--profile tunnel` (so local boot needs no token).

- [ ] Step 1: Compose file: services `app` (build context `..`, dockerfile `apps/server/Dockerfile`, env from `.env`, port 8888, depends_on postgres healthy), `postgres` (16, healthcheck `pg_isready`, volume), `cloudflared` (`image: cloudflare/cloudflared:latest`, `command: tunnel --no-autoupdate run --token ${TUNNEL_TOKEN}`, `profiles: ["tunnel"]`, depends_on app). `.env.example`: `DATABASE_URL`, `SPOTIFY_CLIENT_ID/SECRET/REDIRECT_URI` (default `https://opendj.com/api/v1/provider/connections/spotify/callback`), `BASE_URL=https://opendj.com`, `TUNNEL_TOKEN=`, `PORT=8888` — mirror oss-demo's key set.
- [ ] Step 2: Local boot check (no tunnel): copy `.env.example` → `.env` with local values (`BASE_URL=http://127.0.0.1:8888`, local redirect URI, real Spotify creds copied from `d:\Repositories\opendj\apps\oss-demo\.env`), `docker compose -f deploy/docker-compose.yml up --build -d`, then `curl http://127.0.0.1:8888/api/v1/health` → `{"ok":true,...}` and `/` → Angular index. **Stop the foundation oss-demo stack first if port 8888 is busy** (`docker compose -f d:\Repositories\opendj\apps\oss-demo\docker-compose.yml down`).
- [ ] Step 3: Commit `feat: compose deploy with optional cloudflared tunnel profile`.

---

### Task B5: Tunnel + DNS + Spotify (MANUAL Ethan + assistant-guided)

- [ ] Step 1 (Ethan, Cloudflare dashboard): Zero Trust → Networks → Tunnels → Create named tunnel `opendj-live` → copy the token. Route: public hostname `opendj.com` → `http://app:8888` (and `www.opendj.com` if wanted).
- [ ] Step 2 (Ethan, Spotify dashboard): add redirect URI `https://opendj.com/api/v1/provider/connections/spotify/callback`.
- [ ] Step 3: On the basement box (or laptop fallback): clone repo, `.env` with prod values + `TUNNEL_TOKEN`, `docker compose -f deploy/docker-compose.yml --profile tunnel up --build -d`.
- [ ] Step 4: Verify from a phone on cellular: `https://opendj.com/api/v1/health` → ok; host login; create session; TV + guest pages.
- [ ] Step 5: Pre-warm the lyrics cache: play each demo-setlist track once (or curl `/api/v1/lyrics/lookup?trackName=..&artistName=..` per track).
