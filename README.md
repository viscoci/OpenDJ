# OpenDJ

[![CI](https://github.com/viscoci/opendj/actions/workflows/ci.yml/badge.svg)](https://github.com/viscoci/opendj/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-22%20LTS-339933?logo=node.js&logoColor=white)](./.nvmrc)
[![pnpm](https://img.shields.io/badge/pnpm-9-F69220?logo=pnpm&logoColor=white)](https://pnpm.io)
[![Conventional Commits](https://img.shields.io/badge/Conventional%20Commits-1.0.0-FE5196?logo=conventionalcommits&logoColor=white)](https://www.conventionalcommits.org)
[![Contributor Covenant](https://img.shields.io/badge/Contributor%20Covenant-2.1-4baaaa.svg)](./CODE_OF_CONDUCT.md)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

> Collaborative, multi-provider music queue management for live events.
> Guests scan a QR code to request songs; hosts moderate the queue from a dashboard.

OpenDJ is the **public OSS foundation** for a collaborative music queue product. It provides reusable packages — provider abstractions, realtime room contracts, queue logic, lyrics/karaoke primitives, an Angular template — that you can self-host or build on top of.

A working hosted implementation lives at [opendj.live](https://opendj.live), built on these libraries. **The hosted product is a separate, private repository** ([`opendj-live`](https://github.com/viscoci/opendj-live)) — not the same source code with private files removed.

## Status

🚧 **Early scaffold.** Package boundaries, TypeScript contracts, CI, and conventions are in place. Real implementations land package-by-package — see [`ROADMAP.md`](./ROADMAP.md).

## Quickstart (self-host)

> The OSS demo is being scaffolded — full instructions land in [`docs/ONBOARDING.md`](./docs/ONBOARDING.md) once `apps/oss-demo` boots.

```bash
git clone https://github.com/viscoci/opendj.git
cd opendj
pnpm install
pnpm turbo run lint typecheck test
```

When the demo is ready:

```bash
cd apps/oss-demo
cp .env.example .env   # fill SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET
docker compose up
# → http://localhost:8888
```

## Repo layout

```
packages/
  core/              Pure TS domain logic, provider contracts, queue rules
  db/                Drizzle schema + migrations
  auth/              OSS identity, OAuth/OIDC, password fallback, sessions, claims
  backend/           Hono routes/services usable from Node + Workers
  realtime/          Runtime-neutral realtime room contracts + events
  abuse/             Abuse signals, risk scoring, rate-limit contracts
  sync/              Song timing/synchronization primitives
  lyrics/            Lyrics lookup, LRC parsing, LRCLIB adapter, feedback
  frontend/          Reusable Angular components + services
  frontend-template/ Basic Angular 21 OSS frontend (Capacitor-ready, web-first)
  app-shell/         Browser/Capacitor platform adapter interfaces
  agent-tools/       Dev-only MCP server (P2)
apps/
  oss-demo/          Reference self-host: Node + Postgres via docker compose
examples/            Minimal usage examples
docs/                Architecture, providers, repo boundary, agent guide
```

See [`docs/agent-brief.md`](./docs/agent-brief.md) for the full architectural specification.

## Tech stack

- **TypeScript strict** everywhere — no exceptions
- **Hono** server framework (Node + Cloudflare Workers compatible)
- **Drizzle ORM + Postgres** (Postgres.js adapter; Workers + Node)
- **Angular 21** for the OSS frontend template (standalone, signals, zoneless)
- **Capacitor-ready** but web-first; native shells live in `opendj-live`
- **Vitest** for unit tests
- **Turborepo + pnpm workspaces**
- **Changesets** for versioning and changelogs
- Realtime: in-process room registry for OSS (optional Valkey scale-out); Cloudflare Durable Objects for hosted

## Contributing

Contributions welcome. Read [`CONTRIBUTING.md`](./CONTRIBUTING.md) first — it covers dev setup, Conventional Commits, DCO sign-off, Changesets, and what does (and doesn't) belong in this repo.

By participating you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Community

- 💬 [Discussions](https://github.com/viscoci/opendj/discussions) — questions, ideas, show & tell
- 🐛 [Issues](https://github.com/viscoci/opendj/issues) — bugs and feature requests
- 🔒 [Security](./SECURITY.md) — report vulnerabilities privately
- 📜 [Code of Conduct](./CODE_OF_CONDUCT.md)

## License

MIT — see [`LICENSE`](./LICENSE).
