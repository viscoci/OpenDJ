---
'opendj-oss-demo': minor
---

OSS demo now serves the built Angular frontend alongside the API on the same port.

**What changed**

- `apps/oss-demo/src/main.ts` now mounts a static-asset middleware + SPA fallback for any `GET` outside `/api/*`. Path traversal is bounded — the resolved file path must stay inside the dist root; anything else falls through to the SPA fallback (which serves `index.html`).
- `FRONTEND_DIST` env var controls the bundle location. May be absolute or relative to the **repo root** (NOT cwd, since `pnpm --filter` runs in the package dir). Defaults to `packages/frontend-template/dist/opendj-template/browser`. The Dockerfile copies the built bundle to `/app/frontend-dist` and sets `FRONTEND_DIST=frontend-dist`.
- When the frontend isn't built, the demo starts in API-only mode and prints a warning telling the user how to build it.
- A small in-file MIME map covers what Angular emits (`.html`, `.js`, `.css`, `.svg`, `.ico`, `.png`, fonts).

**`tsx` over `--experimental-strip-types`**

Pre-existing local-dev issue: `node --experimental-strip-types src/main.ts` doesn't resolve the `.js` import-specifier convention used throughout the workspace (NodeNext module resolution writes `import './foo.js'` for what's actually `./foo.ts`). Switched `start` to `tsx`, added it as a runtime dep, and updated the Dockerfile `CMD` to call it via `pnpm exec`.

**Dockerfile**

Now also runs `pnpm --filter @opendj/frontend-template build` so a single `docker compose up` boots a fully demoable stack: Postgres + the Hono backend on `:8888` + the Angular guest UI at `/`.

**`.env.example`**

Documents the new knobs: `FRONTEND_DIST`, `POST_LOGIN_PATH`, and the per-provider OAuth login env vars (`GOOGLE_CLIENT_ID`, `APPLE_*`, `FACEBOOK_*`).

**Smoke-tested** locally:

- `GET /api/v1/health` → 200 JSON
- `GET /` → 200 `text/html` (Angular index)
- `GET /u/<slug>` → 200 `text/html` (SPA fallback for Angular router)
- `GET /<hashed-bundle>.js` → 200 `text/javascript` (~256 kB)
- `GET /api/v1/no-such-route` → 404 JSON (API miss, not SPA fallback)
