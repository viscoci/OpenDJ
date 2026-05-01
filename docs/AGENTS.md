# Agents guide

> **Status:** placeholder. Filled in alongside the `@opendj/core` + `@opendj/backend` work and again when `@opendj/agent-tools` is implemented.

This doc is for AI coding agents (and humans skimming for orientation) working on OpenDJ. It will cover:

1. Explicit dependency graph: how `deps.ts`, the provider registry, the app factory, and runtime adapters fit together
2. How to add a new streaming provider (links to [`PROVIDERS.md`](./PROVIDERS.md))
3. Provider capability matrix
4. Provider API reference links
5. Guest identity system: fingerprint construction, slot lifecycle, heartbeat, expiry sweep
6. Realtime room architecture: `RealtimeRoom`, `SessionRoom`, snapshots, events, replay rules
7. Lyrics/karaoke architecture: LRCLIB adapter, cache rules, LRC parsing, feedback, fallback display behavior
8. MCP/dev-agent guide: allowed tools (`get_architecture_summary`, `list_routes`, `list_db_tables`, `get_provider_contract`, `get_session_event_contract`, `get_frontend_routes`, `run_typecheck`, `run_tests`); forbidden tools (no arbitrary shell, no production DB writes, no production secrets); how to keep OpenAPI + event contracts in sync
9. Local dev setup → [`ONBOARDING.md`](./ONBOARDING.md)

Until this doc is filled in, the authoritative source is [`docs/agent-brief.md`](./agent-brief.md). Read it end-to-end before generating code.

## Hard rules for agents

- **TypeScript strict everywhere.** No `any` without a justification comment.
- **No hosted-only code in this repo.** See [`REPO_BOUNDARY.md`](./REPO_BOUNDARY.md).
- **No SDKs that break in Cloudflare Workers** (e.g. `node-postgres`, `spotify-web-api-node`). Use `fetch` and Workers-compatible adapters.
- **Capability gating is mandatory.** Never call provider feature methods without a type-guard check on `getCapabilities()`.
- **Conventional Commits + DCO sign-off** on every commit. See [`CONTRIBUTING.md`](../CONTRIBUTING.md).
