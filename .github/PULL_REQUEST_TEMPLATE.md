<!-- Thanks for the PR! Please complete the checklist below. -->

## Summary

<!-- 1-3 sentences. What changed and why. -->

## Type

- [ ] feat — new capability
- [ ] fix — bug fix
- [ ] refactor — no behavior change
- [ ] docs / chore / ci / test

## Checklist

- [ ] Conventional Commits in commit messages (e.g. `feat(core): ...`)
- [ ] Commits signed off (`git commit -s`) — DCO required
- [ ] `pnpm turbo run lint typecheck test` passes locally
- [ ] Changeset added (`pnpm changeset`) if `packages/*` changed — or `[skip-changeset]` in PR title for docs/CI/chore-only
- [ ] Docs updated (README, package README, `docs/`) if behavior or API changed
- [ ] No hosted-only content (billing, Branding Studio, hosted analytics, native mobile) — that lives in `opendj-live`

## Linked issues

<!-- Closes #123, refs #456 -->

## Notes for reviewers

<!-- Anything reviewers should focus on, edge cases you're unsure about, follow-up tasks. -->
