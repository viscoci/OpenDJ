/**
 * `/api/v1/config/public` — surfaces configuration FLAGS (never values) so the
 * frontend can gate UI affordances. For example, the host dashboard hides the
 * Connect Spotify button when SPOTIFY_CLIENT_ID isn't set; the login page
 * hides Google/Apple/Facebook buttons that aren't configured.
 *
 * The payload is intentionally minimal — just booleans. We never echo client
 * IDs, secrets, or redirect URIs back through this surface, since the page
 * may be served to anonymous browsers.
 */

import { Hono } from 'hono';
import type { Config } from '../config.js';
import type { AuthVariables } from '../auth/middleware.js';

export interface PublicConfigRouteDeps {
  config: Config;
}

export interface PublicConfigPayload {
  loginProviders: {
    google: boolean;
    apple: boolean;
    facebook: boolean;
  };
  musicProviders: {
    spotify: boolean;
  };
}

export function publicConfigRoutes(
  deps: PublicConfigRouteDeps,
): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();

  app.get('/', (c) => {
    const payload: PublicConfigPayload = {
      loginProviders: {
        google: deps.config.loginProviders.google !== undefined,
        apple: deps.config.loginProviders.apple !== undefined,
        facebook: deps.config.loginProviders.facebook !== undefined,
      },
      musicProviders: {
        spotify: deps.config.spotify !== undefined,
      },
    };
    return c.json(payload);
  });

  return app;
}
