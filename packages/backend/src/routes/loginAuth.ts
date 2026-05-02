/**
 * `/api/v1/auth/:provider/{start,callback}` routes for login OAuth.
 *
 * Music-provider OAuth lives at `/api/v1/provider/connections/:provider/...`
 * (separate route tree, separate state flow_kind). Don't confuse the two.
 */

import { Hono } from 'hono';
import * as v from 'valibot';
import type { AuthVariables } from '../auth/middleware.js';
import { LoginAuthError, type LoginAuthService } from '../auth/LoginAuthService.js';
import { buildSessionCookie } from '../auth/cookies.js';
import {
  LoginProviderNotImplementedError,
  type LoginProviderRegistry,
} from '../auth/loginProviders/index.js';

export interface LoginAuthRouteDeps {
  loginAuth: LoginAuthService;
  providers: LoginProviderRegistry;
  /** Where to redirect after successful login. Defaults to `/`. */
  postLoginPath?: string;
}

const CallbackQuery = v.object({
  code: v.pipe(v.string(), v.nonEmpty()),
  state: v.pipe(v.string(), v.nonEmpty()),
});

function statusForCode(code: string): number {
  switch (code) {
    case 'provider_not_configured':
      return 503;
    case 'invalid_or_expired_state':
    case 'state_provider_mismatch':
    case 'wrong_flow_kind':
      return 400;
    case 'token_exchange_failed':
      return 502;
    default:
      return 400;
  }
}

export function loginAuthRoutes(deps: LoginAuthRouteDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const postLoginPath = deps.postLoginPath ?? '/';

  /** GET /:provider/start — redirect to provider authorize URL. */
  app.get('/:provider/start', async (c) => {
    const providerId = c.req.param('provider') ?? '';
    const handler = deps.providers[providerId];
    if (!handler) return c.json({ error: 'unknown_provider', providerId }, 400);
    try {
      const result = await deps.loginAuth.start(handler);
      return c.redirect(result.authorizeUrl, 302);
    } catch (err) {
      if (err instanceof LoginAuthError) {
        return c.json({ error: err.code }, statusForCode(err.code) as 400 | 502 | 503);
      }
      throw err;
    }
  });

  /** GET /:provider/callback — exchange + login. */
  app.get('/:provider/callback', async (c) => {
    const providerId = c.req.param('provider') ?? '';
    const handler = deps.providers[providerId];
    if (!handler) return c.json({ error: 'unknown_provider', providerId }, 400);

    const errorParam = c.req.query('error');
    if (errorParam) {
      return c.json({ error: 'provider_denied', providerError: errorParam }, 400);
    }

    const parsed = v.safeParse(CallbackQuery, {
      code: c.req.query('code'),
      state: c.req.query('state'),
    });
    if (!parsed.success) {
      return c.json({ error: 'invalid_callback_query' }, 400);
    }

    try {
      const result = await deps.loginAuth.complete(
        handler,
        parsed.output.code,
        parsed.output.state,
      );
      c.header(
        'Set-Cookie',
        buildSessionCookie({
          value: result.session.token,
          expiresAt: result.session.expiresAt,
        }),
      );
      return c.redirect(postLoginPath, 302);
    } catch (err) {
      if (err instanceof LoginProviderNotImplementedError) {
        return c.json({ error: 'login_provider_not_implemented', providerId: err.providerId }, 501);
      }
      if (err instanceof LoginAuthError) {
        return c.json({ error: err.code }, statusForCode(err.code) as 400 | 502 | 503);
      }
      throw err;
    }
  });

  return app;
}
