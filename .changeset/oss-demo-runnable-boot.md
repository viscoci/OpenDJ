---
'@opendj/backend': patch
---

Wire `apps/oss-demo` to actually boot — the OSS reference deploy now starts a real Hono server via `@hono/node-server`.

**`apps/oss-demo/src/main.ts`:**

- Loads config from `process.env` via `loadConfig`; pretty-prints `ConfigError` issues and exits 1 on misconfigured boots
- Builds `createDeps({ config, db: createDb(config.databaseUrl) })` with the full Drizzle stack
- Mounts `createApp` (every route from /api/v1/health onward) on the configured `PORT` (default 8888)
- Logs Spotify-not-configured warning when `SPOTIFY_CLIENT_ID/SECRET` are unset
- Graceful SIGINT/SIGTERM shutdown with a 5s hard-timeout safety net

**`package.json` updates:**

- Adds `@hono/node-server`, `@opendj/backend`, `@opendj/db` (workspace), `hono` deps
- `start` runs Node 22's `--experimental-strip-types` so TypeScript executes directly with no build step
- New `db:migrate` script delegates to `pnpm --filter @opendj/db db:generate` for schema-driven migration generation

**README rewrite:** quickstart with `docker compose up`, local-dev path with Drizzle migrate + start, what's not yet wired (WS realtime, login OAuth, email/password), how to verify without a running server.

Drizzle-kit migration generation has a known ESM/.js-extension incompatibility at `drizzle-kit@0.28` — running `db:generate` requires an upgrade or a small config tweak. Boot wiring itself is correct and the typecheck pipeline is green; the demo can be brought all the way up once that's resolved.
