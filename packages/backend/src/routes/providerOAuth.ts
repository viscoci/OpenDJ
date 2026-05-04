/**
 * `/api/v1/provider/connections/:provider/{start,callback}` routes.
 *
 * Generic OAuth bridge driven by `streamingProviderOAuthConfigs` — adds a new
 * provider by registering its `OAuthProviderConfig`. The exchange leg uses
 * `@opendj/auth`'s pure helpers (`exchangeCode`) and persists the resulting
 * tokens via `StreamingRouter.switchProvider`.
 *
 * See docs/agent-brief.md §"Music provider OAuth flow".
 */

import {
  buildAuthorizeUrl,
  exchangeCode,
  generateSessionToken,
  type AuthContext,
} from '@opendj/auth';
import type { Hono } from 'hono';
import { Hono as HonoApp } from 'hono';
import * as v from 'valibot';
import { requireAuth, requireClaim, type AuthVariables } from '../auth/middleware.js';
import { AuthService } from '../auth/AuthService.js';
import type { StreamingRouter } from '../providers/streaming/StreamingRouter.js';
import type { StreamingProviderOAuthRegistry } from '../providers/streaming/oauthConfigs.js';
import type { OAuthStateRepository, ProviderConnectionRepository } from '../repositories/types.js';

const STATE_TTL_MS = 10 * 60 * 1000;

export interface ProviderOAuthRouteDeps {
  authService: AuthService;
  streamingRouter: StreamingRouter;
  oauthStates: OAuthStateRepository;
  /** Used by GET /me — read-only; we never expose tokens through this route. */
  providerConnections: ProviderConnectionRepository;
  configs: StreamingProviderOAuthRegistry;
  spotify?: { clientId: string; clientSecret: string; redirectUri: string };
  /** Where to send the user after a successful callback. */
  postCallbackPath?: string;
  /** Inject fetch for the token-exchange leg. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

export function providerOAuthRoutes(
  deps: ProviderOAuthRouteDeps,
): Hono<{ Variables: AuthVariables }> {
  const app = new HonoApp<{ Variables: AuthVariables }>();
  const postCallbackPath = deps.postCallbackPath ?? '/settings/providers';

  /**
   * GET /me — list the current account's connected providers. Read-only,
   * never returns tokens; the UI uses this to render "Connect" vs "Connected
   * as <displayName>" badges.
   */
  app.get('/me', requireAuth(deps.authService), async (c) => {
    const auth = c.get('auth') as AuthContext;
    if (!auth.currentAccountId) {
      return c.json({ error: 'no_active_account' }, 400);
    }
    const rows = await deps.providerConnections.findAllForAccount(auth.currentAccountId);
    return c.json({
      connections: rows.map((row) => ({
        providerId: row.providerId,
        providerAccountId: row.providerAccountId,
        displayName: row.displayName,
        connectedByUserId: row.connectedByUserId,
        connectedAt: row.createdAt,
        updatedAt: row.updatedAt,
      })),
    });
  });

  /** GET /:provider/start — requires provider:connect; redirects to provider authorize URL. */
  app.get('/:provider/start', requireClaim(deps.authService, 'provider:connect'), async (c) => {
    const providerId = c.req.param('provider');
    const config = deps.configs[providerId];
    if (!config) return c.json({ error: 'unknown_provider', providerId }, 400);

    const auth = c.get('auth') as AuthContext;
    if (!auth.userId || !auth.currentAccountId) {
      return c.json({ error: 'no_active_account' }, 400);
    }

    const credentials = providerCredentials(deps, providerId);
    if (!credentials) {
      return c.json({ error: 'provider_oauth_not_configured', providerId }, 503);
    }

    const state = generateSessionToken();
    await deps.oauthStates.create({
      state,
      flowKind: 'connect-provider',
      providerId,
      accountId: auth.currentAccountId,
      userId: auth.userId,
      expiresAt: new Date(Date.now() + STATE_TTL_MS),
    });

    const url = buildAuthorizeUrl(config, credentials.clientId, credentials.redirectUri, state);
    return c.redirect(url, 302);
  });

  /** GET /:provider/callback — verifies state, exchanges code, persists tokens. */
  const CallbackQuery = v.object({
    code: v.pipe(v.string(), v.nonEmpty()),
    state: v.pipe(v.string(), v.nonEmpty()),
  });

  app.get('/:provider/callback', async (c) => {
    const providerId = c.req.param('provider');
    const config = deps.configs[providerId];
    if (!config) return c.json({ error: 'unknown_provider', providerId }, 400);

    const errorParam = c.req.query('error');
    if (errorParam) {
      return c.json({ error: 'provider_denied', providerError: errorParam }, 400);
    }

    const queryParsed = v.safeParse(CallbackQuery, {
      code: c.req.query('code'),
      state: c.req.query('state'),
    });
    if (!queryParsed.success) {
      return c.json({ error: 'invalid_callback_query' }, 400);
    }

    const { code, state } = queryParsed.output;
    const stateRow = await deps.oauthStates.findActive(state, Date.now());
    if (!stateRow) return c.json({ error: 'invalid_or_expired_state' }, 400);
    if (stateRow.providerId !== providerId) {
      return c.json({ error: 'state_provider_mismatch' }, 400);
    }
    if (stateRow.flowKind !== 'connect-provider') {
      return c.json({ error: 'wrong_flow_kind' }, 400);
    }
    if (!stateRow.accountId || !stateRow.userId) {
      return c.json({ error: 'state_missing_account' }, 400);
    }

    // Single-use: drop the state row before doing the exchange so a replay
    // can't try the same state twice even if exchange takes a while.
    await deps.oauthStates.delete(state);

    const credentials = providerCredentials(deps, providerId);
    if (!credentials) {
      return c.json({ error: 'provider_oauth_not_configured', providerId }, 503);
    }

    let tokens;
    try {
      tokens = await exchangeCode({
        config,
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        code,
        redirectUri: credentials.redirectUri,
        ...(deps.fetchImpl !== undefined && { fetchImpl: deps.fetchImpl }),
      });
    } catch (err) {
      return c.json({ error: 'token_exchange_failed', message: (err as Error).message }, 502);
    }

    await deps.streamingRouter.switchProvider(
      stateRow.accountId,
      providerId,
      {
        accessToken: tokens.accessToken,
        ...(tokens.refreshToken !== undefined && { refreshToken: tokens.refreshToken }),
        ...(tokens.tokenType !== undefined && { tokenType: tokens.tokenType }),
      },
      { connectedByUserId: stateRow.userId },
    );

    return c.redirect(postCallbackPath, 302);
  });

  return app;
}

function providerCredentials(
  deps: ProviderOAuthRouteDeps,
  providerId: string,
): { clientId: string; clientSecret: string; redirectUri: string } | null {
  if (providerId === 'spotify' && deps.spotify) return deps.spotify;
  return null;
}
