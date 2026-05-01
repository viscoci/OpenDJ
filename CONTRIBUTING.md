# Contributing to OpenDJ

Thanks for your interest in OpenDJ! This document covers everything you need to land a clean PR.

## Scope of this repo

This is the **public OSS foundation**. It contains reusable libraries (`@opendj/*`), the Angular template, and a reference self-host demo (`apps/oss-demo`).

**Out of scope here** (these belong in the private `opendj-live` repo):

- Hosted Cloudflare deployment (`opendj.live`, `app.opendj.live`, `api.opendj.live`)
- Billing, subscriptions, payment provider integration
- Branding Studio, white-label features, hosted product analytics
- Capacitor native iOS/Android wrapper (`apps/mobile`)
- Anything tied to a specific commercial deployment

PRs that mix hosted-only content into this repo will be asked to split. See [`docs/REPO_BOUNDARY.md`](./docs/REPO_BOUNDARY.md).

## Dev setup

Requirements:

- **Node 22 LTS** (use `nvm use` — `.nvmrc` pins the version)
- **pnpm 9** (enable via `corepack enable && corepack prepare pnpm@9.15.4 --activate`)
- Docker Desktop (only for `apps/oss-demo`)

```bash
git clone https://github.com/viscoci/opendj.git
cd opendj
pnpm install
pnpm turbo run lint typecheck test
```

`pnpm prepare` runs automatically and installs git hooks via [lefthook](https://github.com/evilmartians/lefthook).

## Branching + PRs

- Default branch: `main`
- Branch from `main`, name like `feat/queue-dedupe` or `fix/spotify-token-refresh`
- One logical change per PR
- Squash-merge into `main` (history stays linear and matches Conventional Commits)

## Conventional Commits

All commit messages MUST follow [Conventional Commits 1.0.0](https://www.conventionalcommits.org). The `commit-msg` hook (and CI) will reject malformed messages.

Common types:

- `feat:` — new user-facing capability
- `fix:` — bug fix
- `chore:` — tooling, deps, config
- `docs:` — documentation only
- `refactor:` — code change without behavior change
- `test:` — tests only
- `ci:` — CI/CD config

Use a scope when it adds clarity: `feat(core): add canSkip helper`.

## DCO sign-off

OpenDJ uses the [Developer Certificate of Origin](https://developercertificate.org/) (DCO) instead of a CLA. Every commit must include a `Signed-off-by:` trailer:

```bash
git commit -s -m "feat(queue): enforce per-guest cap"
```

`-s` adds the trailer automatically using your `git config user.name` / `user.email`. The CI DCO check will block PRs without it.

## Changesets

Any PR that changes something inside `packages/*` (other than `packages/agent-tools`) needs a [Changeset](https://github.com/changesets/changesets):

```bash
pnpm changeset
```

Pick the affected packages, choose `patch` / `minor` / `major`, and write a one-line summary. The generated `.changeset/*.md` file is committed alongside your code. CI fails if a `packages/*` change ships without a changeset.

Pure docs/CI/chore PRs don't need a changeset — add `[skip-changeset]` to your PR title or apply the `skip-changeset` label.

## Tests + lint

Before pushing:

```bash
pnpm turbo run lint typecheck test
```

- Tests: Vitest. Each package has its own `vitest.config.ts`. Aim for fast unit tests; integration tests live in their respective packages.
- Lint: ESLint flat config. Prettier handles formatting (`pnpm format`).
- TypeScript: strict mode is non-negotiable. No `any` without a `// eslint-disable-next-line` and a comment explaining why.

## Adding a streaming provider

See [`docs/PROVIDERS.md`](./docs/PROVIDERS.md) and [`docs/AGENTS.md`](./docs/AGENTS.md). The short version:

1. Implement `IStreamingProvider` from `@opendj/core` plus only the modular `ISupports*` interfaces your provider actually supports.
2. Declare granular capabilities via `getCapabilities()` — don't pretend to support things you can't reliably do.
3. Register in `providerRegistry` in `@opendj/backend`.
4. Add tests covering capability gating and an integration smoke for at least search + queueTrack.
5. Update the provider matrix in `docs/PROVIDERS.md`.

## Good first issues

Look for issues labeled [`good first issue`](https://github.com/viscoci/opendj/labels/good%20first%20issue) or [`help wanted`](https://github.com/viscoci/opendj/labels/help%20wanted). If you want a starter task suggested, ask in [Discussions](https://github.com/viscoci/opendj/discussions).

## Questions?

- General questions → [Discussions](https://github.com/viscoci/opendj/discussions)
- Bug reports / feature requests → [Issues](https://github.com/viscoci/opendj/issues)
- Security vulnerabilities → [`SECURITY.md`](./SECURITY.md) (private disclosure only)

By contributing you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md) and certify the DCO.
