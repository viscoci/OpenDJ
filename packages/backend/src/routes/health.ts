import { Hono } from 'hono';
import type { AppDeps } from '../deps.js';

/**
 * GET /api/v1/health — liveness probe. Returns 200 with a minimal payload as
 * long as the process is running. Does NOT touch the database — that would
 * make the probe sensitive to transient DB blips.
 */
export function healthRoutes(_deps: AppDeps): Hono {
  const app = new Hono();
  app.get('/', (c) => c.json({ ok: true, service: 'opendj-backend' }));
  return app;
}
