# Foundation Publish Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the ten `@opendj/*` packages consumable from npm so the private `opendj-live` product repo can pin published versions (Plan A of spec `docs/superpowers/specs/2026-07-23-opendj-live-bootstrap-design.md`).

**Architecture:** Packages already build with `tsc → dist/` (ESM + `.d.ts`) and changesets is already configured with 37 pending changesets. The pipeline work is therefore: publish-time metadata (`publishConfig` rewrites `exports`/`main`/`types` from `src` to `dist` at pack time — workspace DX unchanged), two verification scripts (tarball contents, dist consumption from a scratch project), a changesets release workflow, and the npm scope claim. The spec mentioned tsup/ng-packagr; exploration showed `tsc` builds already exist and `@opendj/frontend` contains no Angular imports (plain TS services), so **neither tsup nor ng-packagr is needed** — this plan keeps the existing `tsc` builds.

**Tech Stack:** pnpm 9.15.4, turborepo, tsc (TS 5.7), Changesets (`@changesets/cli` + `changelog-github`, already installed), GitHub Actions, `changesets/action@v1`.

## Global Constraints

- Node `>=22.0.0`, pnpm `9.15.4` (`packageManager` field), Windows dev box — scripts must be cross-platform Node `.mjs` (no bash-isms).
- Commits: Conventional Commits (commitlint) **and DCO sign-off — always `git commit -s`**. Pre-commit runs Prettier check: run `pnpm exec prettier --write <files>` before committing.
- Any change under `packages/*` requires a changeset file (CI `changeset-check`).
- Publishable packages (10): `core`, `db`, `auth`, `backend`, `realtime`, `abuse`, `sync`, `lyrics`, `app-shell`, `frontend`. Not published: `frontend-template` (private), `agent-tools` (private + ignored), `apps/oss-demo` (ignored).
- npm scope: `@opendj` if the org claim succeeds; fallback `@viscoci` (Task 6 decides; Task 6b is the conditional rename).
- ESM only (`"type": "module"` everywhere). No new runtime dependencies.
- Work on branch `feat/publish-pipeline`; merge to `main` via PR.

---

### Task 1: Tarball verification script (write it failing first)

**Files:**

- Create: `scripts/verify-publish.mjs`

**Interfaces:**

- Produces: `node scripts/verify-publish.mjs` — exits 0 when every publishable package's packed tarball has `main`/`types`/`exports` pointing into `dist/` and the referenced files exist; exits 1 listing failures. Task 2 makes it pass; Task 4 runs it in CI.
- Consumes: `pnpm --filter <pkg> pack` (already works), `tar` CLI (present on Windows 10+ and ubuntu runners).

- [ ] **Step 1: Write the script**

```js
// scripts/verify-publish.mjs
// Packs each publishable package and asserts the published package.json
// points at dist/ and that every referenced file is inside the tarball.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PACKAGES = [
  { name: '@opendj/core', dir: 'packages/core' },
  { name: '@opendj/db', dir: 'packages/db', extra: assertDbMigrations },
  { name: '@opendj/auth', dir: 'packages/auth' },
  { name: '@opendj/backend', dir: 'packages/backend' },
  { name: '@opendj/realtime', dir: 'packages/realtime' },
  { name: '@opendj/abuse', dir: 'packages/abuse' },
  { name: '@opendj/sync', dir: 'packages/sync' },
  { name: '@opendj/lyrics', dir: 'packages/lyrics' },
  { name: '@opendj/app-shell', dir: 'packages/app-shell' },
  { name: '@opendj/frontend', dir: 'packages/frontend' },
];

const failures = [];
const work = mkdtempSync(join(tmpdir(), 'opendj-publish-'));

function stringLeaves(node, out = []) {
  if (typeof node === 'string') out.push(node);
  else if (node && typeof node === 'object')
    Object.values(node).forEach((v) => stringLeaves(v, out));
  return out;
}

function assertDbMigrations(pkgRoot, fail) {
  const dir = join(pkgRoot, 'migrations');
  const sql = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.sql')) : [];
  if (sql.length === 0) fail('tarball is missing migrations/*.sql');
}

for (const { name, dir, extra } of PACKAGES) {
  const fail = (msg) => failures.push(`${name}: ${msg}`);
  const dest = join(work, name.replace(/[@/]/g, '_'));
  const out = execFileSync('pnpm', ['--filter', name, 'pack', '--pack-destination', dest], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  const tarball = out.trim().split('\n').at(-1).trim();
  execFileSync('tar', ['-xzf', tarball, '-C', dest], { shell: process.platform === 'win32' });
  const pkgRoot = join(dest, 'package');
  const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));

  for (const field of ['main', 'types']) {
    if (!pkg[field]?.startsWith('./dist/'))
      fail(`${field} is "${pkg[field]}" — must point into ./dist/`);
  }
  const leaves = stringLeaves(pkg.exports);
  if (leaves.length === 0) fail('exports has no entries');
  for (const leaf of leaves) {
    if (!leaf.startsWith('./dist/')) fail(`exports leaf "${leaf}" — must point into ./dist/`);
    else if (!existsSync(resolve(pkgRoot, leaf)))
      fail(`exports leaf "${leaf}" not present in tarball`);
  }
  for (const field of ['main', 'types']) {
    if (pkg[field]?.startsWith('./dist/') && !existsSync(resolve(pkgRoot, pkg[field])))
      fail(`${field} "${pkg[field]}" not present in tarball`);
  }
  extra?.(pkgRoot, fail);
}

rmSync(work, { recursive: true, force: true });
if (failures.length) {
  console.error('verify-publish FAILED:\n' + failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
console.log(`verify-publish OK — ${PACKAGES.length} packages point at dist/`);
```

- [ ] **Step 2: Build packages, run script, verify it FAILS for the right reason**

Run: `pnpm turbo run build --filter='./packages/*'` then `node scripts/verify-publish.mjs`
Expected: exit 1; every package listed with `main is "./src/index.ts" — must point into ./dist/` (and db listed with missing migrations).

- [ ] **Step 3: Commit**

```bash
pnpm exec prettier --write scripts/verify-publish.mjs
git add scripts/verify-publish.mjs
git commit -s -m "test: add publish tarball verification script"
```

---

### Task 2: Publish metadata — `publishConfig` + `files` fixes

**Files:**

- Modify: `packages/core/package.json`, `packages/auth/package.json`, `packages/backend/package.json`, `packages/realtime/package.json`, `packages/abuse/package.json`, `packages/sync/package.json`, `packages/lyrics/package.json`, `packages/app-shell/package.json`, `packages/frontend/package.json` (identical block)
- Modify: `packages/db/package.json` (block + subpaths + `files`)
- Create: `.changeset/publish-metadata.md`

**Interfaces:**

- Consumes: `scripts/verify-publish.mjs` from Task 1.
- Produces: tarballs whose `package.json` points at `dist/` (pnpm rewrites `main`/`types`/`exports` from `publishConfig` at pack/publish time). Workspace-internal resolution still uses `src` — nothing else changes.

- [ ] **Step 1: Add the standard `publishConfig` block to the nine single-entry packages**

In each listed package.json (all nine are identical in shape — `exports` has only `"."`), add after the `"files"` array:

```json
  "publishConfig": {
    "access": "public",
    "main": "./dist/index.js",
    "types": "./dist/index.d.ts",
    "exports": {
      ".": {
        "types": "./dist/index.d.ts",
        "import": "./dist/index.js"
      }
    }
  },
```

- [ ] **Step 2: db package — subpath exports + migrations in files**

In `packages/db/package.json`, change `"files"` to include migrations and add the subpath-aware block:

```json
  "files": ["dist", "src", "migrations", "drizzle.config.ts"],
  "publishConfig": {
    "access": "public",
    "main": "./dist/index.js",
    "types": "./dist/index.d.ts",
    "exports": {
      ".": {
        "types": "./dist/index.d.ts",
        "import": "./dist/index.js"
      },
      "./schema": {
        "types": "./dist/schema/index.d.ts",
        "import": "./dist/schema/index.js"
      },
      "./migrate": {
        "types": "./dist/migrate.d.ts",
        "import": "./dist/migrate.js"
      }
    }
  },
```

- [ ] **Step 3: Run verification, expect PASS**

Run: `node scripts/verify-publish.mjs`
Expected: exit 0, `verify-publish OK — 10 packages point at dist/`

- [ ] **Step 4: Sanity-check workspace DX is unchanged**

Run: `pnpm turbo run typecheck test --filter='./packages/*'`
Expected: all green (publishConfig is inert inside the workspace).

- [ ] **Step 5: Add changeset and commit**

Create `.changeset/publish-metadata.md`:

```markdown
---
'@opendj/core': patch
'@opendj/db': patch
'@opendj/auth': patch
'@opendj/backend': patch
'@opendj/realtime': patch
'@opendj/abuse': patch
'@opendj/sync': patch
'@opendj/lyrics': patch
'@opendj/app-shell': patch
'@opendj/frontend': patch
---

Publish metadata: tarballs now resolve `main`/`types`/`exports` from `dist/` via `publishConfig`; `@opendj/db` tarballs include `migrations/*.sql`.
```

```bash
pnpm exec prettier --write "packages/*/package.json" .changeset/publish-metadata.md
git add packages/*/package.json .changeset/publish-metadata.md
git commit -s -m "feat: point published package entries at dist via publishConfig"
```

---

### Task 3: Dist-consumption smoke script

**Files:**

- Create: `scripts/verify-dist-consumption.mjs`

**Interfaces:**

- Consumes: packed tarballs (same `pnpm --filter <pkg> pack` mechanism as Task 1).
- Produces: `node scripts/verify-dist-consumption.mjs` — exit 0 when a scratch npm project (no workspace, no tsconfig paths) can install every tarball and import the safe subset at runtime. Task 4 runs it in CI.

- [ ] **Step 1: Write the script**

```js
// scripts/verify-dist-consumption.mjs
// Installs the packed tarballs into a scratch npm project (npm overrides pin
// inter-package deps to the local tarballs since nothing is on the registry
// yet) and imports them from compiled dist output.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PACKAGES = [
  ['@opendj/core', 'packages/core'],
  ['@opendj/db', 'packages/db'],
  ['@opendj/auth', 'packages/auth'],
  ['@opendj/backend', 'packages/backend'],
  ['@opendj/realtime', 'packages/realtime'],
  ['@opendj/abuse', 'packages/abuse'],
  ['@opendj/sync', 'packages/sync'],
  ['@opendj/lyrics', 'packages/lyrics'],
  ['@opendj/app-shell', 'packages/app-shell'],
  ['@opendj/frontend', 'packages/frontend'],
];
// Imported at runtime in the scratch project. db/backend/auth are installed
// (their deps resolve) but not runtime-imported here: db opens no connection at
// import but depends on the postgres driver's platform bits, and auth's argon2
// is an optionalDependency — keep the smoke deterministic.
const RUNTIME_IMPORTS = [
  '@opendj/core',
  '@opendj/sync',
  '@opendj/lyrics',
  '@opendj/realtime',
  '@opendj/app-shell',
  '@opendj/frontend',
  '@opendj/abuse',
];

const shell = process.platform === 'win32';
const scratch = mkdtempSync(join(tmpdir(), 'opendj-consume-'));
const tarballs = {};
for (const [name, dir] of PACKAGES) {
  const out = execFileSync('pnpm', ['--filter', name, 'pack', '--pack-destination', scratch], {
    encoding: 'utf8',
    shell,
  });
  tarballs[name] = out.trim().split('\n').at(-1).trim();
}

const dependencies = {},
  overrides = {};
for (const name of Object.keys(tarballs)) {
  const fileRef = 'file:' + tarballs[name]; // absolute path; npm normalizes on all platforms
  dependencies[name] = fileRef;
  overrides[name] = fileRef;
}
writeFileSync(
  join(scratch, 'package.json'),
  JSON.stringify(
    { name: 'consume-smoke', private: true, type: 'module', dependencies, overrides },
    null,
    2,
  ),
);

execFileSync('npm', ['install', '--no-audit', '--no-fund'], {
  cwd: scratch,
  stdio: 'inherit',
  shell,
});

writeFileSync(
  join(scratch, 'smoke.mjs'),
  [
    ...RUNTIME_IMPORTS.map((n, i) => `import * as m${i} from '${n}';`),
    `const mods = [${RUNTIME_IMPORTS.map((_, i) => `m${i}`).join(', ')}];`,
    `for (const [i, m] of mods.entries()) {`,
    `  if (Object.keys(m).length === 0) { console.error('empty module: ' + ${JSON.stringify(RUNTIME_IMPORTS)}[i]); process.exit(1); }`,
    `}`,
    `import { PROVIDER_FEATURES } from '@opendj/core';`,
    `import { predictPlaybackPosition } from '@opendj/sync';`,
    `if (typeof PROVIDER_FEATURES !== 'object') process.exit(1);`,
    `if (typeof predictPlaybackPosition !== 'function') process.exit(1);`,
    `console.log('dist consumption OK: ' + mods.length + ' modules imported from dist');`,
  ].join('\n'),
);

execFileSync('node', ['smoke.mjs'], { cwd: scratch, stdio: 'inherit', shell });
rmSync(scratch, { recursive: true, force: true });
console.log('verify-dist-consumption OK');
```

- [ ] **Step 2: Run it, expect PASS (Task 2 already landed publishConfig)**

Run: `pnpm turbo run build --filter='./packages/*'` then `node scripts/verify-dist-consumption.mjs`
Expected: npm install output, then `dist consumption OK: 7 modules imported from dist` and `verify-dist-consumption OK`, exit 0.
If it fails: the failure output names the broken package/leaf — fix the package's `publishConfig` (Task 2 shape) and re-run.

- [ ] **Step 3: Commit**

```bash
pnpm exec prettier --write scripts/verify-dist-consumption.mjs
git add scripts/verify-dist-consumption.mjs
git commit -s -m "test: add dist consumption smoke for packed tarballs"
```

---

### Task 4: CI wiring — publish-verify job + bot-PR guards

**Files:**

- Modify: `.github/workflows/ci.yml`

**Interfaces:**

- Consumes: `scripts/verify-publish.mjs` (Task 1), `scripts/verify-dist-consumption.mjs` (Task 3).
- Produces: CI job `publish-verify`; `dco` and `changeset-check` jobs skip the changesets bot's "Version Packages" PR (Task 5's workflow opens it; without these guards that PR can never merge).

- [ ] **Step 1: Add the `publish-verify` job to `.github/workflows/ci.yml`**

Append after the `oss-demo-smoke` job (same indentation level):

```yaml
publish-verify:
  name: Publish tarball verification
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4

    - uses: pnpm/action-setup@v4
      with:
        version: 9.15.4

    - uses: actions/setup-node@v4
      with:
        node-version: 22
        cache: pnpm

    - run: pnpm install --frozen-lockfile

    - name: Build packages
      run: pnpm turbo run build --filter='./packages/*'

    - name: Verify tarball metadata
      run: node scripts/verify-publish.mjs

    - name: Verify dist consumption
      run: node scripts/verify-dist-consumption.mjs
```

- [ ] **Step 2: Guard `dco` and `changeset-check` against the version-packages bot PR**

Change the two `if:` lines:

```yaml
dco:
  name: DCO sign-off
  runs-on: ubuntu-latest
  if: github.event_name == 'pull_request' && github.event.pull_request.user.login != 'github-actions[bot]'
```

```yaml
changeset-check:
  name: Changeset check
  runs-on: ubuntu-latest
  if: github.event_name == 'pull_request' && github.event.pull_request.user.login != 'github-actions[bot]' && !contains(github.event.pull_request.labels.*.name, 'skip-changeset') && !contains(github.event.pull_request.title, '[skip-changeset]')
```

- [ ] **Step 3: Validate workflow formatting**

Run: `pnpm exec prettier --check .github/workflows/ci.yml`
Expected: no violations. (GitHub parses the YAML on push — a syntax error surfaces as a workflow-file error on the PR's Checks tab; watch for it in Task 7 Step 1.)

- [ ] **Step 4: Commit**

```bash
pnpm exec prettier --write .github/workflows/ci.yml
git add .github/workflows/ci.yml
git commit -s -m "ci: verify publish tarballs and guard bot version PRs"
```

---

### Task 5: Release workflow + RELEASING doc

**Files:**

- Create: `.github/workflows/release.yml`
- Create: `docs/RELEASING.md`

**Interfaces:**

- Consumes: existing root scripts (`changeset`, `version`, `release`), changesets config (`access: public`, ignores `@opendj/agent-tools` + `opendj-oss-demo`), `NPM_TOKEN` repo secret (created in Task 6).
- Produces: on every push to `main` — while unreleased changesets exist, a bot PR `chore: version packages [skip-changeset]`; when that PR merges, packages publish to npm.

- [ ] **Step 1: Create `.github/workflows/release.yml`**

```yaml
name: Release

on:
  push:
    branches: [main]

concurrency: release-${{ github.ref }}

permissions:
  contents: write
  pull-requests: write
  id-token: write

jobs:
  release:
    name: Version or publish
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: pnpm/action-setup@v4
        with:
          version: 9.15.4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
          registry-url: https://registry.npmjs.org

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build packages
        run: pnpm turbo run build --filter='./packages/*'

      - name: Verify tarball metadata
        run: node scripts/verify-publish.mjs

      - name: Create version PR or publish
        uses: changesets/action@v1
        with:
          version: pnpm changeset version
          publish: pnpm changeset publish
          commit: 'chore: version packages'
          title: 'chore: version packages [skip-changeset]'
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
          NPM_CONFIG_PROVENANCE: 'true'
```

- [ ] **Step 2: Create `docs/RELEASING.md`**

```markdown
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
```

- [ ] **Step 3: Commit**

```bash
pnpm exec prettier --write .github/workflows/release.yml docs/RELEASING.md
git add .github/workflows/release.yml docs/RELEASING.md
git commit -s -m "ci: add changesets release workflow and releasing doc"
```

---

### Task 6: npm scope claim + token (MANUAL — Ethan)

**Files:** none (npmjs.com + GitHub settings actions)

**Interfaces:**

- Produces: decision `SCOPE = @opendj | @viscoci`; repo secret `NPM_TOKEN`. Task 6b runs only if the fallback scope is chosen. Task 7 blocks on this task.

- [ ] **Step 1: Try to claim the org**

On npmjs.com (logged in): Profile → Add Organization → name `opendj` → free plan.
Expected: success → `SCOPE = @opendj`, skip Task 6b. If the name is taken → `SCOPE = @viscoci` (create org `viscoci` the same way if it doesn't exist), do Task 6b.

- [ ] **Step 2: Create an automation token**

npmjs.com → Access Tokens → Generate New Token → **Automation** (bypasses 2FA for CI publish).

- [ ] **Step 3: Store it**

GitHub → `viscoci/OpenDJ` → Settings → Secrets and variables → Actions → New repository secret → name `NPM_TOKEN`.

---

### Task 6b (CONDITIONAL — only if scope fallback): rename `@opendj/*` → `@viscoci/*`

**Files:**

- Modify: every `packages/*/package.json` (`name` + workspace deps), `tsconfig.base.json` (paths), `.changeset/config.json` (ignore list), all source imports, `scripts/verify-publish.mjs`, `scripts/verify-dist-consumption.mjs`, docs.

**Interfaces:**

- Produces: workspace where every package and import uses `@viscoci/*`; green build/test; single changeset noting the rename.

- [ ] **Step 1: Mechanical sweep (run from repo root, Git Bash)**

```bash
git grep -lz '@opendj/' -- ':!node_modules' ':!pnpm-lock.yaml' ':!docs/designs' | xargs -0 sed -i 's|@opendj/|@viscoci/|g'
pnpm install   # regenerates lockfile entries for renamed workspace packages
```

- [ ] **Step 2: Verify nothing referenced the old scope and everything is green**

Run: `git grep -l '@opendj/' -- ':!node_modules' ':!pnpm-lock.yaml' ':!docs' ':!.changeset'` (expect no output), then `pnpm turbo run build typecheck test --filter='./packages/*'` and `node scripts/verify-publish.mjs`
Expected: all green, `verify-publish OK`.

- [ ] **Step 3: Changeset + commit**

Create `.changeset/scope-rename.md` (note: after the sweep the package names are already `@viscoci/*`):

```markdown
---
'@viscoci/core': patch
'@viscoci/db': patch
'@viscoci/auth': patch
'@viscoci/backend': patch
'@viscoci/realtime': patch
'@viscoci/abuse': patch
'@viscoci/sync': patch
'@viscoci/lyrics': patch
'@viscoci/app-shell': patch
'@viscoci/frontend': patch
---

Rename npm scope to @viscoci/\* — the opendj org name was unavailable.
```

Then:

```bash
pnpm exec prettier --write .
git add -A
git commit -s -m "feat!: rename npm scope to @viscoci"
```

---

### Task 7: PR, merge, first release

**Files:** none (git/GitHub/npm operations)

**Interfaces:**

- Consumes: everything above; `NPM_TOKEN` secret from Task 6.
- Produces: `@opendj/*` (or `@viscoci/*`) `0.1.0` live on npm — the input Plan B (opendj-live scaffold) pins against.

- [ ] **Step 1: Push branch and open PR**

```bash
git push -u origin feat/publish-pipeline
gh pr create --title "feat: publish pipeline for @opendj packages" --body "Implements Plan A of docs/superpowers/specs/2026-07-23-opendj-live-bootstrap-design.md: publishConfig dist metadata, tarball + consumption verification, changesets release workflow.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

Expected: all CI jobs green including `publish-verify`.

- [ ] **Step 2: Merge PR; wait for the Release workflow**

Expected: bot PR `chore: version packages [skip-changeset]` appears with every publishable package at **0.1.0** (37 pending changesets, all minor/patch from 0.0.0). If any version differs from 0.1.0, inspect that package's changesets before merging.

- [ ] **Step 3: Merge the version PR; verify publish**

Run (after the Release workflow completes): `npm view @opendj/core version` (or `@viscoci/core`)
Expected: `0.1.0`. Spot-check one more: `npm view @opendj/backend dist.tarball`.

- [ ] **Step 4: Record the result for Plan B**

Note the final scope + version in the spec's risk table resolution: edit `docs/superpowers/specs/2026-07-23-opendj-live-bootstrap-design.md` §4 replacing the "availability could not be verified" sentence with the actual outcome, commit `docs: record npm scope outcome` (with `-s`, via PR or direct push per repo habit).
