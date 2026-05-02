/**
 * OpenDJ OSS demo entrypoint.
 *
 * Boots the Hono backend on Node 22 via `@hono/node-server`, with WebSocket
 * realtime via `@hono/node-ws`. Reads config from `process.env`; expects
 * Postgres to be reachable at `DATABASE_URL`.
 *
 * Run via:
 *   pnpm --filter opendj-oss-demo start
 *
 * Or via the bundled Docker Compose:
 *   cd apps/oss-demo && docker compose up
 *
 * Generate migrations after schema changes:
 *   pnpm --filter @opendj/db db:generate
 *
 * See docs/agent-brief.md §"OSS deploy story".
 */

import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { ConfigError, createApp, createDeps, loadConfig } from '@opendj/backend';
import { createDb } from '@opendj/db';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error('[opendj-oss-demo] invalid config:');
      for (const issue of err.issues) console.error(`  - ${issue}`);
      process.exit(1);
    }
    throw err;
  }

  const db = createDb(config.databaseUrl);
  const deps = createDeps({ config, db, realtime: 'in-process' });

  // We need an app instance to feed createNodeWebSocket — but createApp also
  // needs the upgradeWebSocket helper. Construct a placeholder app for the
  // WS factory, then build the real app passing its upgradeWebSocket back.
  // The factory is bound to the Hono instance it's first attached to, so
  // we build the real app with the helper and inject WS into the served HTTP
  // server afterwards.
  const tempApp = createApp({ deps });
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app: tempApp });
  const app = createApp({ deps, upgradeWebSocket });

  // ─── Serve the built Angular frontend ───────────────────────────────────
  // FRONTEND_DIST may be absolute or relative to the repo root (NOT cwd —
  // pnpm filters run in the package dir, not the repo root, so cwd-relative
  // would silently miss the built bundle). Default targets the workspace
  // path; the Dockerfile sets it to an absolute /app/frontend-dist.
  const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');
  const frontendDistRaw =
    process.env['FRONTEND_DIST'] ?? 'packages/frontend-template/dist/opendj-template/browser';
  const frontendDistAbs = isAbsolute(frontendDistRaw)
    ? frontendDistRaw
    : resolve(repoRoot, frontendDistRaw);
  const indexHtmlPath = resolve(frontendDistAbs, 'index.html');
  const frontendBuilt = existsSync(indexHtmlPath);
  if (frontendBuilt) {
    // Static asset middleware — only fires for non-API GETs so it never
    // shadows /api/v1/* (which would be a routing accident waiting to happen).
    // Path traversal is blocked: resolved file path must stay inside the
    // dist root.
    app.use('*', async (c, next) => {
      if (c.req.path.startsWith('/api/')) return next();
      if (c.req.method !== 'GET') return next();
      const requestedRel = c.req.path === '/' ? 'index.html' : c.req.path.replace(/^\//, '');
      const candidate = resolve(frontendDistAbs, requestedRel);
      if (!candidate.startsWith(frontendDistAbs)) return next();
      try {
        const info = await stat(candidate);
        if (!info.isFile()) return next();
        const body = await readFile(candidate);
        return c.body(new Uint8Array(body), 200, { 'content-type': mimeFor(candidate) });
      } catch {
        return next();
      }
    });
    // SPA fallback for unmatched GETs — Angular's router needs index.html
    // for deep links (`/u/:slug`, `/host`, etc.).
    app.notFound(async (c) => {
      if (c.req.path.startsWith('/api/')) return c.json({ error: 'not_found' }, 404);
      if (c.req.method !== 'GET') return c.notFound();
      try {
        const html = await readFile(indexHtmlPath, 'utf8');
        return c.html(html);
      } catch {
        return c.json({ error: 'frontend_index_unreadable' }, 500);
      }
    });
  }

  const port = readPort(process.env['PORT']);

  const server = serve(
    {
      fetch: app.fetch,
      port,
    },
    (info) => {
      console.log(`[opendj-oss-demo] listening on http://localhost:${info.port}`);
      console.log(`[opendj-oss-demo] base URL: ${config.baseUrl}`);
      if (frontendBuilt) {
        console.log(`[opendj-oss-demo] serving frontend from ${frontendDistAbs}/`);
      } else {
        console.warn(
          `[opendj-oss-demo] frontend not built at ${frontendDistAbs} — API only. ` +
            `Run \`pnpm --filter @opendj/frontend-template build\`.`,
        );
      }
      if (!config.spotify) {
        console.warn(
          '[opendj-oss-demo] SPOTIFY_CLIENT_ID/SECRET not set — Spotify connect flow disabled.',
        );
      }
    },
  );

  injectWebSocket(server);
  console.log('[opendj-oss-demo] WebSocket realtime ready at /api/v1/sessions/:id/realtime');

  // Graceful shutdown so docker stop doesn't dangle in-flight requests.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      console.log(`[opendj-oss-demo] received ${signal}, shutting down`);
      server.close(() => process.exit(0));
      // Hard timeout in case a connection lingers.
      setTimeout(() => process.exit(1), 5000).unref();
    });
  }
}

/** Tiny extension → MIME map. The Angular build only emits a handful of types. */
function mimeFor(filePath: string): string {
  const ext = filePath.toLowerCase().split('.').pop() ?? '';
  switch (ext) {
    case 'html':
      return 'text/html; charset=utf-8';
    case 'js':
    case 'mjs':
      return 'text/javascript; charset=utf-8';
    case 'css':
      return 'text/css; charset=utf-8';
    case 'json':
      return 'application/json; charset=utf-8';
    case 'svg':
      return 'image/svg+xml';
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    case 'ico':
      return 'image/x-icon';
    case 'woff':
      return 'font/woff';
    case 'woff2':
      return 'font/woff2';
    case 'map':
      return 'application/json; charset=utf-8';
    case 'txt':
      return 'text/plain; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}

function readPort(value: string | undefined): number {
  const fallback = 8888;
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

main().catch((err) => {
  console.error('[opendj-oss-demo] fatal:', err);
  process.exit(1);
});
