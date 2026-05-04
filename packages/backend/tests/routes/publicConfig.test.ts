import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { AuthVariables } from '../../src/auth/middleware.js';
import type { Config } from '../../src/config.js';
import { publicConfigRoutes } from '../../src/routes/publicConfig.js';

function baseConfig(): Config {
  return {
    databaseUrl: 'postgres://localhost/test',
    baseUrl: 'http://localhost:8888',
    loginProviders: {},
    postLoginPath: '/',
    postProviderCallbackPath: '/host/dashboard',
    maxSongsPerGuest: 3,
    maxGuestsPerSession: null,
    moderationEnabledDefault: false,
  };
}

function buildApp(config: Config) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.route('/config/public', publicConfigRoutes({ config }));
  return app;
}

describe('GET /config/public', () => {
  it('reports no providers configured by default', async () => {
    const app = buildApp(baseConfig());
    const res = await app.request('/config/public');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, Record<string, boolean>>;
    expect(body).toEqual({
      loginProviders: { google: false, apple: false, facebook: false },
      musicProviders: { spotify: false },
    });
  });

  it('flags spotify configured when SPOTIFY_CLIENT_ID is set', async () => {
    const config = baseConfig();
    config.spotify = {
      clientId: 'cid',
      clientSecret: 'secret',
      redirectUri: 'http://localhost:8888/cb',
    };
    const app = buildApp(config);
    const res = await app.request('/config/public');
    const body = (await res.json()) as Record<string, Record<string, boolean>>;
    expect(body['musicProviders']).toEqual({ spotify: true });
  });

  it('flags google login provider when GOOGLE_CLIENT_ID is set', async () => {
    const config = baseConfig();
    config.loginProviders = {
      google: {
        clientId: 'gcid',
        clientSecret: 'gsecret',
        redirectUri: 'http://localhost:8888/cb',
      },
    };
    const app = buildApp(config);
    const res = await app.request('/config/public');
    const body = (await res.json()) as { loginProviders: Record<string, boolean> };
    expect(body.loginProviders.google).toBe(true);
    expect(body.loginProviders.apple).toBe(false);
  });

  it('never echoes secrets or client IDs', async () => {
    const config = baseConfig();
    config.spotify = {
      clientId: 'SECRET_CID',
      clientSecret: 'SECRET_SECRET',
      redirectUri: 'http://localhost:8888/cb',
    };
    const app = buildApp(config);
    const res = await app.request('/config/public');
    const text = await res.text();
    expect(text).not.toContain('SECRET_CID');
    expect(text).not.toContain('SECRET_SECRET');
  });
});
