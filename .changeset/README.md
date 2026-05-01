# Changesets

This directory holds [Changesets](https://github.com/changesets/changesets) — small markdown files describing how each PR affects published `@opendj/*` packages.

## Adding a changeset

```bash
pnpm changeset
```

The CLI will:

1. Ask which packages this PR changes.
2. Ask the bump type for each (`patch` / `minor` / `major`).
3. Prompt for a one-line summary.
4. Write a `.changeset/<random-name>.md` file. Commit it with your PR.

## When to skip

Pure docs/CI/chore PRs that don't change any `packages/*` source can skip a changeset. Add `[skip-changeset]` to your PR title or apply the `skip-changeset` label.

`@opendj/agent-tools`, `opendj-oss-demo`, and `opendj-template` are private/dev-only — they're listed under `ignore` in `config.json` and don't need changesets.

## Releasing (maintainers)

1. Merge a "Version Packages" PR generated from accumulated changesets (`pnpm version`).
2. Tag + publish (`pnpm release`).
3. Per-package CHANGELOGs land in each `packages/*/CHANGELOG.md`.

A GitHub Action to automate (1) and (2) is planned but intentionally not wired yet — releases are manual until the first stable package lands.
