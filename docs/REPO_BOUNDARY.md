# Repo boundary: OSS vs hosted

OpenDJ ships as **two repositories**, on purpose:

|               | Public OSS                                                                                        | Private hosted                                                       |
| ------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Repo          | [`viscoci/opendj`](https://github.com/viscoci/opendj) (this one)                                  | [`viscoci/opendj-live`](https://github.com/viscoci/opendj-live)      |
| License       | MIT                                                                                               | Proprietary                                                          |
| Purpose       | Reusable foundation: domain logic, contracts, primitives, basic frontend template, self-host demo | Commercial implementation deployed to `opendj.live`                  |
| Deploy target | Docker Compose on a single Node host                                                              | Cloudflare Pages + Workers + Durable Objects + Hyperdrive (Postgres) |

## Belongs in this OSS repo

- `@opendj/core` — domain logic, provider contracts, queue rules, plan gates
- `@opendj/db` — Drizzle schema, migrations, query helpers
- `@opendj/auth` — OAuth/OIDC login providers, email/password fallback, sessions, claims
- `@opendj/backend` — Hono routes/services usable from Node and Workers
- `@opendj/realtime` — runtime-neutral realtime contracts/events/snapshots
- `@opendj/abuse` — abuse signals, risk scoring, rate-limit contracts
- `@opendj/sync` — song timing/synchronization primitives
- `@opendj/lyrics` — lyrics lookup, LRC parsing, cache contracts, feedback hooks
- `@opendj/frontend` — reusable Angular components/services
- `@opendj/frontend-template` — basic Angular 21 OSS frontend (Capacitor-ready, web-first)
- `@opendj/app-shell` — runtime/platform adapter interfaces
- `@opendj/agent-tools` — dev-only MCP server (P2)
- `apps/oss-demo` — Docker Compose self-host reference
- `examples/` — minimal usage examples
- `docs/` — public architecture + onboarding

## Belongs ONLY in `opendj-live`

- Cloudflare deployment configuration for `opendj.live`, `app.opendj.live`, `api.opendj.live`
- Durable Object `SessionRoom` implementation
- Billing webhook handlers, Stripe (or other) subscription provider secrets
- `subscriptions` table migrations and any private hosted funnel/product analytics
- Branding Studio, white-label, paid zone management UI, ad suppression
- Hosted product analytics dashboards
- Capacitor iOS/Android wrapper (`apps/mobile`)
- Desktop shell experiment
- Production dashboards, incident docs, internal board documents
- Any `.env` or secrets (only `.env.example` is allowed in OSS)
- MCP config files referencing local absolute paths or private tokens

## Why two repos?

The OSS repo is a **portfolio-grade reusable foundation**. The private repo is the **commercial business implementation**.

Open-sourcing the entire hosted product would either (a) leak business logic that pays for further development, or (b) require constant scrubbing of "private files removed" diffs. Splitting at the package boundary keeps both repos honest:

- OSS contributors can extend the libraries without seeing or maintaining hosted secrets.
- The hosted product can iterate on commercial features (Branding Studio, billing, analytics) without polluting the public repo's history.
- `opendj.live` is presented as **a working hosted example built on these libraries**, not "the same code with private files removed."

If you find yourself wanting to add hosted-only content to a PR here, that work belongs in `opendj-live` instead.
