# Repository scope

OpenDJ aims to be a portfolio-grade, reusable foundation for collaborative music-queue products. Contributors land changes that fit that scope; product-polish or commercial concerns are intentionally out of scope so the foundation stays small and reusable.

## In scope

- `@opendj/core` — domain logic, provider contracts, queue rules, plan gates
- `@opendj/db` — Drizzle schema, migrations, query helpers
- `@opendj/auth` — OAuth/OIDC login providers, email/password fallback, sessions, claims
- `@opendj/backend` — Hono routes/services usable from Node and Workers
- `@opendj/realtime` — runtime-neutral realtime contracts/events/snapshots
- `@opendj/abuse` — abuse signals, risk scoring, rate-limit contracts
- `@opendj/sync` — song timing/synchronization primitives
- `@opendj/lyrics` — lyrics lookup, LRC parsing, cache contracts, feedback hooks
- `@opendj/frontend` — reusable Angular components/services
- `@opendj/frontend-template` — Angular 21 frontend (Capacitor-ready, web-first)
- `@opendj/app-shell` — runtime/platform adapter interfaces
- `@opendj/agent-tools` — dev-only MCP server (P2)
- `apps/oss-demo` — Docker Compose self-host reference
- `examples/` — minimal usage examples
- `docs/` — public architecture + onboarding

## Out of scope

These either belong in the consumer of the libraries (a deploy, a fork, a commercial product) or are deployment-environment specifics that don't generalize:

- Branding Studio, white-label, ad suppression, "Pro hides ads" upsells
- Billing / subscription provider integrations (Stripe webhooks, plan gates beyond the abstract claims model)
- Production analytics dashboards and any private funnel/product analytics tables
- Specific cloud-deploy configuration tied to a particular vendor account
- Polished TV layouts (overlay / centered / split lyrics, custom backdrops, sponsor strips)
- Polished onboarding wizards and multi-variant OAuth error screens
- Capacitor iOS/Android wrappers — the foundation is Capacitor-ready; the actual native shells live in your fork
- Internal incident docs, board documents, deployment runbooks
- Any `.env` or secrets — only `.env.example` files belong here
- MCP config files referencing local absolute paths or private tokens

## Why this split

A reusable foundation has two failure modes: (a) growing too narrow to be useful end-to-end, or (b) growing so wide it stops being a foundation and starts being a single product. The list above is the line — anything in scope must be either a generic primitive, a contract, or the minimum needed to demonstrate the primitives end-to-end.

If a PR adds product-polish, branded UX, or vendor-specific deploy config, that work belongs in the deployment / fork that consumes this repo, not here.
