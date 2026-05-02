/**
 * Hono app factory.
 *
 * One factory drives both the Node OSS deploy and the Cloudflare Worker hosted
 * deploy in `opendj-live`. The deps graph is constructed by the caller —
 * `apps/oss-demo/src/main.ts` for OSS, `opendj-live/apps/api/src/worker.ts`
 * for hosted.
 *
 * Routes are mounted under `/api/v1`. Future breaking changes use `/api/v2`.
 */

import { Hono } from 'hono';
import type { AuthVariables } from './auth/middleware.js';
import type { AppDeps } from './deps.js';
import { authRoutes } from './routes/auth.js';
import { guestRoutes } from './routes/guest.js';
import { healthRoutes } from './routes/health.js';
import { providerOAuthRoutes } from './routes/providerOAuth.js';
import { queueRoutes } from './routes/queue.js';
import { sessionRoutes } from './routes/session.js';

export interface AppOptions {
  deps: AppDeps;
  /** fetch impl for outbound calls — usually only set in tests. */
  fetchImpl?: typeof fetch;
}

export function createApp(options: AppOptions): Hono<{ Variables: AuthVariables }> {
  const { deps } = options;
  const app = new Hono<{ Variables: AuthVariables }>();

  const v1 = new Hono<{ Variables: AuthVariables }>();
  v1.route('/health', healthRoutes(deps));
  v1.route(
    '/auth',
    authRoutes({
      authService: deps.authService,
      claimsService: deps.claimsService,
      users: deps.repositories.users,
    }),
  );
  v1.route('/guest', guestRoutes({ guestIdentity: deps.guestIdentityService }));
  v1.route(
    '/sessions',
    sessionRoutes({ authService: deps.authService, sessionService: deps.sessionService }),
  );
  v1.route(
    '/sessions/:id/queue',
    queueRoutes({ authService: deps.authService, queueService: deps.queueService }),
  );
  v1.route(
    '/provider/connections',
    providerOAuthRoutes({
      authService: deps.authService,
      streamingRouter: deps.streamingRouter,
      oauthStates: deps.repositories.oauthStates,
      configs: deps.streamingProviderOAuthConfigs,
      ...(deps.config.spotify !== undefined && { spotify: deps.config.spotify }),
      ...(options.fetchImpl !== undefined && { fetchImpl: options.fetchImpl }),
    }),
  );

  app.route('/api/v1', v1);

  return app;
}
