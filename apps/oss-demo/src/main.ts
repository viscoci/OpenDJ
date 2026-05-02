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

  const port = readPort(process.env['PORT']);

  const server = serve(
    {
      fetch: app.fetch,
      port,
    },
    (info) => {
      console.log(`[opendj-oss-demo] listening on http://localhost:${info.port}`);
      console.log(`[opendj-oss-demo] base URL: ${config.baseUrl}`);
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
