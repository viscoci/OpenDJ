# Releasing @opendj/\* packages

Releases are driven by [Changesets](https://github.com/changesets/changesets).

## Flow

1. Every PR that touches `packages/*` includes a changeset (`pnpm changeset`) describing the change and its bump (patch/minor/major). CI enforces this.
2. On merge to `main`, the Release workflow (`.github/workflows/release.yml`) opens/updates a bot PR titled `chore: version packages [skip-changeset]` that consumes pending changesets, bumps versions, and rewrites CHANGELOGs.
3. Merging that bot PR triggers the same workflow to build, verify tarball metadata (`scripts/verify-publish.mjs`), and `changeset publish` to npm with provenance.

## Package set

Published (public): core, db, auth, backend, realtime, abuse, sync, lyrics, app-shell, frontend.
Never published: frontend-template (private), agent-tools (private), apps/oss-demo.

## Publish-time metadata

Inside the workspace, packages resolve TS source (`main: ./src/index.ts`). At pack/publish time, pnpm replaces `main`/`types`/`exports` from each package's `publishConfig`, which points at `dist/`. If you add an export subpath, add it to **both** `exports` (src) and `publishConfig.exports` (dist) — `scripts/verify-publish.mjs` fails CI if the dist side is missing.

## Secrets

`NPM_TOKEN`: npm automation token with publish rights to the scope, stored as a GitHub Actions repo secret.

## First-release prerequisites

One-time GitHub repo settings before the first Version-Packages PR:

1. Settings → Actions → General → Workflow permissions: enable **"Allow GitHub Actions to create and approve pull requests"** — without it, changesets/action cannot open the version PR.
2. The bot PR is created with the default `GITHUB_TOKEN`, so it does **not** trigger `pull_request` CI checks (GitHub limitation). If `main` requires status checks, close and reopen the bot PR to trigger them (or switch the workflow to a PAT/GitHub App token later).
3. Repo secret `NPM_TOKEN` must exist (npm automation token with publish rights to the scope).
