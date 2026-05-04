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
import { abuseRoutes } from './routes/abuse.js';
import { authRoutes } from './routes/auth.js';
import { emailAuthRoutes } from './routes/emailAuth.js';
import { loginAuthRoutes } from './routes/loginAuth.js';
import { guestRoutes } from './routes/guest.js';
import { healthRoutes } from './routes/health.js';
import { lyricsRoutes, sessionLyricsRoutes } from './routes/lyrics.js';
import { providerOAuthRoutes } from './routes/providerOAuth.js';
import { publicConfigRoutes } from './routes/publicConfig.js';
import { queueRoutes } from './routes/queue.js';
import { realtimeRoutes, type UpgradeWebSocket } from './routes/realtime.js';
import { searchRoutes } from './routes/search.js';
import { sessionRoutes } from './routes/session.js';

export interface AppOptions {
  deps: AppDeps;
  /** fetch impl for outbound calls — usually only set in tests. */
  fetchImpl?: typeof fetch;
  /**
   * Adapter-supplied WebSocket upgrade helper. When provided AND
   * `deps.roomManager` is non-null, the realtime route is mounted at
   * `/api/v1/sessions/:id/realtime`.
   *
   * Node: pass `createNodeWebSocket(...).upgradeWebSocket` from `@hono/node-ws`.
   * Workers / Durable Objects: their own helper.
   */
  upgradeWebSocket?: UpgradeWebSocket;
}

export function createApp(options: AppOptions): Hono<{ Variables: AuthVariables }> {
  const { deps } = options;
  const app = new Hono<{ Variables: AuthVariables }>();

  const v1 = new Hono<{ Variables: AuthVariables }>();
  v1.route('/health', healthRoutes(deps));
  v1.route('/config/public', publicConfigRoutes({ config: deps.config }));
  v1.route(
    '/auth',
    authRoutes({
      authService: deps.authService,
      claimsService: deps.claimsService,
      users: deps.repositories.users,
    }),
  );
  v1.route(
    '/auth/email',
    emailAuthRoutes({
      emailPassword: deps.emailPasswordService,
      emailVerification: deps.emailVerificationService,
      passwordReset: deps.passwordResetService,
      authService: deps.authService,
      users: deps.repositories.users,
    }),
  );
  v1.route(
    '/auth/oauth',
    loginAuthRoutes({
      loginAuth: deps.loginAuthService,
      providers: deps.loginProviders,
      postLoginPath: deps.config.postLoginPath,
    }),
  );
  v1.route('/guest', guestRoutes({ guestIdentity: deps.guestIdentityService }));
  v1.route(
    '/lyrics',
    lyricsRoutes({
      lyricsLookup: deps.lyricsLookupService,
      guestSlots: deps.repositories.guestSlots,
      guests: deps.repositories.guests,
    }),
  );
  v1.route(
    '/sessions',
    sessionRoutes({ authService: deps.authService, sessionService: deps.sessionService }),
  );
  v1.route(
    '/sessions/:id/queue',
    queueRoutes({ authService: deps.authService, queueService: deps.queueService }),
  );
  v1.route(
    '/sessions/:id/search',
    searchRoutes({
      sessions: deps.repositories.sessions,
      providerConnections: deps.repositories.providerConnections,
      streamingRouter: deps.streamingRouter,
    }),
  );
  v1.route(
    '/sessions/:id/lyrics',
    sessionLyricsRoutes({
      lyricsLookup: deps.lyricsLookupService,
      guestSlots: deps.repositories.guestSlots,
      guests: deps.repositories.guests,
    }),
  );
  v1.route(
    '/sessions/:id/abuse',
    abuseRoutes({
      authService: deps.authService,
      abuseModeration: deps.abuseModerationService,
    }),
  );
  v1.route(
    '/provider/connections',
    providerOAuthRoutes({
      authService: deps.authService,
      streamingRouter: deps.streamingRouter,
      oauthStates: deps.repositories.oauthStates,
      providerConnections: deps.repositories.providerConnections,
      configs: deps.streamingProviderOAuthConfigs,
      postCallbackPath: deps.config.postProviderCallbackPath,
      ...(deps.config.spotify !== undefined && { spotify: deps.config.spotify }),
      ...(options.fetchImpl !== undefined && { fetchImpl: options.fetchImpl }),
    }),
  );

  if (options.upgradeWebSocket && deps.roomManager) {
    v1.route(
      '/sessions/:id/realtime',
      realtimeRoutes({ rooms: deps.roomManager }, options.upgradeWebSocket),
    );
  }

  app.route('/api/v1', v1);

  return app;
}
