import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { AuthService, SESSION_COOKIE_NAME } from '../../src/auth/AuthService.js';
import { ClaimsService } from '../../src/auth/ClaimsService.js';
import type { AuthVariables } from '../../src/auth/middleware.js';
import { defaultStreamingProviderOAuthConfigs } from '../../src/providers/streaming/oauthConfigs.js';
import { StreamingRouter } from '../../src/providers/streaming/StreamingRouter.js';
import {
  InMemoryAccountRepository,
  InMemoryAuthSessionRepository,
  InMemoryMembershipRepository,
  InMemoryOAuthStateRepository,
  InMemoryProviderConnectionRepository,
} from '../../src/repositories/in-memory/index.js';
import { providerOAuthRoutes } from '../../src/routes/providerOAuth.js';
import { defineCapabilities, PROVIDER_FEATURES, type IStreamingProvider } from '@opendj/core';

const NOW = new Date('2026-04-30T12:00:00Z').getTime();
const ACCOUNT_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';

const stubCaps = defineCapabilities('spotify', {
  [PROVIDER_FEATURES.Search]: {
    id: PROVIDER_FEATURES.Search,
    supported: true,
    access: 'guest',
    reliability: 'native',
  },
});

function makeStubProvider(): IStreamingProvider {
  return {
    providerId: 'spotify',
    displayName: 'Spotify',
    async connect() {},
    async disconnect() {},
    isConnected() {
      return true;
    },
    async refreshCredentials() {
      return {};
    },
    getCapabilities() {
      return stubCaps;
    },
  };
}

interface SetupOptions {
  withClaim?: boolean;
  withSpotifyConfig?: boolean;
  fetchImpl?: typeof fetch;
}

async function setup(options: SetupOptions = {}) {
  const clock = { now: () => new Date(NOW) };
  const accounts = new InMemoryAccountRepository();
  const memberships = new InMemoryMembershipRepository();
  const authSessions = new InMemoryAuthSessionRepository(clock);
  const oauthStates = new InMemoryOAuthStateRepository(clock);
  const providerConnections = new InMemoryProviderConnectionRepository(clock);
  const claims = new ClaimsService({ memberships, accounts });
  const authService = new AuthService({ authSessions, claims, clock: () => NOW });

  accounts.seed({
    id: ACCOUNT_ID,
    displayName: 'A',
    slug: 'a',
    plan: 'free',
    createdAt: new Date(NOW),
  });

  if (options.withClaim) {
    memberships.seed({
      accountId: ACCOUNT_ID,
      userId: USER_ID,
      status: 'active',
      role: 'host',
      claims: ['provider:connect'],
      createdAt: new Date(NOW),
      updatedAt: new Date(NOW),
    });
  }

  const streamingRouter = new StreamingRouter({
    providerConnections,
    registry: { spotify: () => makeStubProvider() },
    context: { fetch: options.fetchImpl ?? globalThis.fetch },
  });

  const app = new Hono<{ Variables: AuthVariables }>();
  app.route(
    '/connections',
    providerOAuthRoutes({
      authService,
      streamingRouter,
      oauthStates,
      providerConnections,
      configs: defaultStreamingProviderOAuthConfigs,
      ...(options.fetchImpl !== undefined && { fetchImpl: options.fetchImpl }),
      ...(options.withSpotifyConfig !== false && {
        spotify: {
          clientId: 'cid',
          clientSecret: 'csec',
          redirectUri: 'http://localhost:8888/api/v1/provider/connections/spotify/callback',
        },
      }),
    }),
  );

  return {
    app,
    authService,
    accounts,
    memberships,
    authSessions,
    oauthStates,
    providerConnections,
  };
}

async function login(authService: AuthService, claims: string[] = ['provider:connect']) {
  const issued = await authService.issueSession({
    userId: USER_ID,
    currentAccountId: ACCOUNT_ID,
    claimsSnapshot: claims as Parameters<typeof authService.issueSession>[0]['claimsSnapshot'],
    nowEpochMs: NOW,
  });
  return `${SESSION_COOKIE_NAME}=${issued.token}`;
}

describe('GET /:provider/start', () => {
  it('returns 401 without a session', async () => {
    const { app } = await setup({ withClaim: true });
    const res = await app.request('/connections/spotify/start');
    expect(res.status).toBe(401);
  });

  it('returns 403 without provider:connect claim', async () => {
    const { app, authService } = await setup({ withClaim: true });
    const cookie = await login(authService, ['account:read']);
    const res = await app.request('/connections/spotify/start', { headers: { cookie } });
    expect(res.status).toBe(403);
  });

  it('returns 400 for unknown provider', async () => {
    const { app, authService } = await setup({ withClaim: true });
    const cookie = await login(authService);
    const res = await app.request('/connections/unknown/start', { headers: { cookie } });
    expect(res.status).toBe(400);
  });

  it('returns 503 when spotify config is missing', async () => {
    const { app, authService } = await setup({ withClaim: true, withSpotifyConfig: false });
    const cookie = await login(authService);
    const res = await app.request('/connections/spotify/start', { headers: { cookie } });
    expect(res.status).toBe(503);
  });

  it('redirects to provider authorize URL with state', async () => {
    const { app, authService, oauthStates } = await setup({ withClaim: true });
    const cookie = await login(authService);
    const res = await app.request('/connections/spotify/start', {
      headers: { cookie },
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    const location = res.headers.get('location');
    expect(location).toContain('https://accounts.spotify.com/authorize');
    const url = new URL(location!);
    expect(url.searchParams.get('client_id')).toBe('cid');
    const state = url.searchParams.get('state');
    expect(state).toMatch(/^[0-9a-f]{64}$/);
    const stored = await oauthStates.findActive(state!, NOW);
    expect(stored?.accountId).toBe(ACCOUNT_ID);
    expect(stored?.userId).toBe(USER_ID);
    expect(stored?.flowKind).toBe('connect-provider');
  });
});

function fakeFetch(impl: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    return impl(url, init);
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('GET /:provider/callback', () => {
  async function seedState(opts: {
    state: string;
    providerId?: string;
    flowKind?: 'login' | 'connect-provider';
    expired?: boolean;
  }) {
    const { app, oauthStates, providerConnections } = await setup({
      fetchImpl: fakeFetch(() =>
        jsonResponse({
          access_token: 'AT',
          refresh_token: 'RT',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
      ),
    });
    await oauthStates.create({
      state: opts.state,
      flowKind: opts.flowKind ?? 'connect-provider',
      providerId: opts.providerId ?? 'spotify',
      accountId: ACCOUNT_ID,
      userId: USER_ID,
      // Route checks against real Date.now() — use a far-future date so the
      // assertion isn't sensitive to wall-clock drift between test setup and
      // the route invocation. `expired` flips to a past date.
      expiresAt: new Date(opts.expired ? Date.now() - 1 : Date.now() + 60 * 60_000),
    });
    return { app, oauthStates, providerConnections };
  }

  it('returns 400 with provider_denied when ?error= present', async () => {
    const { app } = await setup();
    const res = await app.request(
      '/connections/spotify/callback?error=access_denied&state=anything',
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; providerError: string };
    expect(body).toEqual({ error: 'provider_denied', providerError: 'access_denied' });
  });

  it('returns 400 on unknown provider', async () => {
    const { app } = await setup();
    const res = await app.request('/connections/unknown/callback?code=c&state=s');
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid query (missing code)', async () => {
    const { app } = await setup();
    const res = await app.request('/connections/spotify/callback?state=abc');
    expect(res.status).toBe(400);
  });

  it('returns 400 for unknown state', async () => {
    const { app } = await setup();
    const res = await app.request('/connections/spotify/callback?code=c&state=does-not-exist');
    expect(res.status).toBe(400);
  });

  it('returns 400 for expired state', async () => {
    const { app } = await seedState({ state: 'st-expired', expired: true });
    const res = await app.request('/connections/spotify/callback?code=c&state=st-expired');
    expect(res.status).toBe(400);
  });

  it('returns 400 when state.providerId mismatches the URL :provider', async () => {
    const { app } = await seedState({ state: 'st-mismatch', providerId: 'soundtrack' });
    const res = await app.request('/connections/spotify/callback?code=c&state=st-mismatch');
    expect(res.status).toBe(400);
  });

  it('returns 400 when state has the wrong flow_kind', async () => {
    const { app } = await seedState({ state: 'st-loginkind', flowKind: 'login' });
    const res = await app.request('/connections/spotify/callback?code=c&state=st-loginkind');
    expect(res.status).toBe(400);
  });

  it('exchanges the code, persists tokens, and redirects', async () => {
    const { app, oauthStates, providerConnections } = await seedState({ state: 'st-good' });
    const res = await app.request('/connections/spotify/callback?code=c&state=st-good', {
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/settings/providers');

    // State row consumed (single-use)
    const remaining = await oauthStates.findActive('st-good', NOW);
    expect(remaining).toBeNull();

    const stored = await providerConnections.findByAccountAndProvider(ACCOUNT_ID, 'spotify');
    expect(stored?.accessToken).toBe('AT');
    expect(stored?.refreshToken).toBe('RT');
    expect(stored?.tokenType).toBe('Bearer');
    expect(stored?.connectedByUserId).toBe(USER_ID);
  });

  it('returns 502 when the token endpoint fails', async () => {
    const { app, oauthStates } = await setup({
      fetchImpl: fakeFetch(() => new Response('bad', { status: 400 })),
    });
    await oauthStates.create({
      state: 'st-bad',
      flowKind: 'connect-provider',
      providerId: 'spotify',
      accountId: ACCOUNT_ID,
      userId: USER_ID,
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });
    const res = await app.request('/connections/spotify/callback?code=c&state=st-bad');
    expect(res.status).toBe(502);
  });
});

describe('GET /me — list current account connections', () => {
  it('returns 401 without a session', async () => {
    const { app } = await setup();
    const res = await app.request('/connections/me');
    expect(res.status).toBe(401);
  });

  it('returns 400 when the session has no current account', async () => {
    const { app, authService } = await setup();
    // Issue a session with no currentAccountId — simulate a brand-new user
    // who somehow hit /me before bootstrap (defensive case).
    const issued = await authService.issueSession({
      userId: USER_ID,
      claimsSnapshot: ['provider:connect'],
      nowEpochMs: NOW,
    });
    const cookie = `${SESSION_COOKIE_NAME}=${issued.token}`;
    const res = await app.request('/connections/me', { headers: { cookie } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('no_active_account');
  });

  it('returns an empty list when nothing is connected', async () => {
    const { app, authService } = await setup({ withClaim: true });
    const cookie = await login(authService);
    const res = await app.request('/connections/me', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { connections: unknown[] };
    expect(body.connections).toEqual([]);
  });

  it('returns connection metadata without leaking tokens', async () => {
    const { app, authService, providerConnections } = await setup({ withClaim: true });
    await providerConnections.upsert({
      accountId: ACCOUNT_ID,
      providerId: 'spotify',
      providerAccountId: 'spotify-user-1',
      displayName: 'Ethan',
      connectedByUserId: USER_ID,
      accessToken: 'SECRET_AT',
      refreshToken: 'SECRET_RT',
    });
    const cookie = await login(authService);
    const res = await app.request('/connections/me', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      connections: Array<Record<string, unknown>>;
    };
    expect(body.connections).toHaveLength(1);
    const [conn] = body.connections;
    expect(conn).toMatchObject({
      providerId: 'spotify',
      providerAccountId: 'spotify-user-1',
      displayName: 'Ethan',
      connectedByUserId: USER_ID,
    });
    // Crucial: tokens must never be exposed.
    expect(JSON.stringify(body)).not.toContain('SECRET_AT');
    expect(JSON.stringify(body)).not.toContain('SECRET_RT');
  });
});
