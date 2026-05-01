/**
 * Hono app factory.
 *
 * One factory drives both the Node OSS deploy and the Cloudflare Worker hosted
 * deploy in `opendj-live`. The deps graph is constructed by the caller — for
 * the OSS demo, by `apps/oss-demo/src/main.ts`; for the hosted Worker, by
 * `opendj-live/apps/api/src/worker.ts`.
 *
 * Routes are mounted under `/api/v1`. Future breaking changes use `/api/v2`
 * rather than mutating in place.
 */

import { Hono } from 'hono';
import type { AppDeps } from './deps.js';
import { healthRoutes } from './routes/health.js';

export interface AppOptions {
  deps: AppDeps;
}

export function createApp(options: AppOptions): Hono {
  const app = new Hono();

  const v1 = new Hono();
  v1.route('/health', healthRoutes(options.deps));
  // Subsequent slices will route('/auth', authRoutes(...)) etc.

  app.route('/api/v1', v1);

  return app;
}
