/**
 * Routes test for /api/v1/auth/oauth/:provider/{start,callback}.
 *
 * Uses a fake provider handler (no network calls). Covers:
 * - start: 302 to authorize URL (with state)
 * - start: 503 when provider is unconfigured
 * - callback: 302 to postLoginPath + Set-Cookie
 * - callback: 400 unknown provider, 400 invalid_callback_query, 400 provider_denied
 * - callback: 501 for the not-implemented stubs
 */

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { OAuthProviderConfig, OAuthTokens } from '@opendj/auth';
import { AuthService } from '../../src/auth/AuthService.js';
import { ClaimsService } from '../../src/auth/ClaimsService.js';
import { LoginAuthService } from '../../src/auth/LoginAuthService.js';
import { AppleLoginHandler } from '../../src/auth/loginProviders/apple.js';
import type {
  LoginProviderHandler,
  LoginProviderRegistry,
  ProviderProfile,
} from '../../src/auth/loginProviders/index.js';
import {
  InMemoryAccountRepository,
  InMemoryAuthIdentityRepository,
  InMemoryAuthSessionRepository,
  InMemoryMembershipRepository,
  InMemoryOAuthStateRepository,
  InMemoryUserRepository,
} from '../../src/repositories/in-memory/index.js';
import { loginAuthRoutes } from '../../src/routes/loginAuth.js';

const FAKE_OAUTH: OAuthProviderConfig = {
  providerId: 'fakeoidc',
  authorizeUrl: 'https://example.test/authorize',
  tokenUrl: 'https://example.test/token',
  defaultScopes: ['openid', 'email'],
};

class FakeLoginHandler implements LoginProviderHandler {
  readonly providerId = 'fakeoidc';
  readonly oauthConfig = FAKE_OAUTH;
  constructor(private readonly profile: ProviderProfile) {}
  async fetchProfile(_tokens: OAuthTokens): Promise<ProviderProfile> {
    return this.profile;
  }
}

function buildApp(opts: { configured?: boolean; postLoginPath?: string } = {}) {
  const clock = { now: () => new Date('2026-04-30T10:00:00Z') };
  const users = new InMemoryUserRepository(clock);
  const accounts = new InMemoryAccountRepository();
  const memberships = new InMemoryMembershipRepository();
  const authIdentities = new InMemoryAuthIdentityRepository(clock);
  const authSessions = new InMemoryAuthSessionRepository(clock);
  const oauthStates = new InMemoryOAuthStateRepository(clock);
  const claims = new ClaimsService({ memberships, accounts });
  const authService = new AuthService({ authSessions, claims });

  const profile: ProviderProfile = {
    providerSubject: 'sub-1',
    email: 'a@b.test',
    emailVerified: true,
    displayName: 'A',
    avatarUrl: null,
    raw: {},
  };
  const fakeFetch: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === FAKE_OAUTH.tokenUrl) {
      return new Response(
        JSON.stringify({ access_token: 'tok', token_type: 'Bearer', expires_in: 3600 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  const loginAuth = new LoginAuthService({
    users,
    authIdentities,
    oauthStates,
    authService,
    credentials:
      opts.configured === false
        ? {}
        : {
            fakeoidc: {
              clientId: 'fake-client',
              clientSecret: 'fake-secret',
              redirectUri: 'https://app.test/api/v1/auth/oauth/fakeoidc/callback',
            },
          },
    fetchImpl: fakeFetch,
  });
  const providers: LoginProviderRegistry = {
    fakeoidc: new FakeLoginHandler(profile),
    apple: new AppleLoginHandler(),
  };
  const app = new Hono();
  const routeOpts: {
    loginAuth: LoginAuthService;
    providers: LoginProviderRegistry;
    postLoginPath?: string;
  } = {
    loginAuth,
    providers,
  };
  if (opts.postLoginPath !== undefined) routeOpts.postLoginPath = opts.postLoginPath;
  app.route('/oauth', loginAuthRoutes(routeOpts));
  return { app, oauthStates };
}

describe('GET /:provider/start', () => {
  it('redirects to the provider authorize URL', async () => {
    const { app } = buildApp();
    const res = await app.request('http://x/oauth/fakeoidc/start');
    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    expect(location).toContain('https://example.test/authorize?');
    expect(location).toContain('state=');
    expect(location).toContain('client_id=fake-client');
  });

  it('returns 400 unknown_provider for an unknown provider id', async () => {
    const { app } = buildApp();
    const res = await app.request('http://x/oauth/nope/start');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({ error: 'unknown_provider' });
  });

  it('returns 503 provider_not_configured when no credentials', async () => {
    const { app } = buildApp({ configured: false });
    const res = await app.request('http://x/oauth/fakeoidc/start');
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toMatchObject({ error: 'provider_not_configured' });
  });
});

describe('GET /:provider/callback', () => {
  it('issues a session cookie and redirects to postLoginPath', async () => {
    const { app, oauthStates } = buildApp({ postLoginPath: '/dashboard' });
    // Pre-create a state row (simulates the start side)
    const startRes = await app.request('http://x/oauth/fakeoidc/start');
    const stateMatch = (startRes.headers.get('location') ?? '').match(/state=([0-9a-f]+)/);
    const state = stateMatch?.[1];
    expect(state).toBeDefined();

    const cb = await app.request(`http://x/oauth/fakeoidc/callback?code=auth-code&state=${state}`);
    expect(cb.status).toBe(302);
    expect(cb.headers.get('location')).toBe('/dashboard');
    const cookie = cb.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('__Host-opendj_session=');
    // State should have been consumed
    expect(oauthStates.rows.has(state!)).toBe(false);
  });

  it('returns 400 provider_denied when ?error= is present', async () => {
    const { app } = buildApp();
    const res = await app.request('http://x/oauth/fakeoidc/callback?error=access_denied');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({ error: 'provider_denied', providerError: 'access_denied' });
  });

  it('returns 400 invalid_callback_query when code or state is missing', async () => {
    const { app } = buildApp();
    const res = await app.request('http://x/oauth/fakeoidc/callback?code=onlycode');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({ error: 'invalid_callback_query' });
  });

  it('returns 400 invalid_or_expired_state for unknown state', async () => {
    const { app } = buildApp();
    const res = await app.request('http://x/oauth/fakeoidc/callback?code=c&state=bogus');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({ error: 'invalid_or_expired_state' });
  });

  it('returns 501 login_provider_not_implemented for the Apple stub', async () => {
    const { app } = buildApp();
    // Have to register an Apple oauth_states row manually (Apple has no creds in the harness).
    // The handler's fetchProfile throws BEFORE token exchange — but token exchange runs first
    // and would 502 because there's no token endpoint mock. So instead we plumb credentials
    // for apple too via a dedicated harness:
    const clock = { now: () => new Date('2026-04-30T10:00:00Z') };
    const users = new InMemoryUserRepository(clock);
    const accounts = new InMemoryAccountRepository();
    const memberships = new InMemoryMembershipRepository();
    const authIdentities = new InMemoryAuthIdentityRepository(clock);
    const authSessions = new InMemoryAuthSessionRepository(clock);
    const oauthStates = new InMemoryOAuthStateRepository(clock);
    const claims = new ClaimsService({ memberships, accounts });
    const authService = new AuthService({ authSessions, claims });
    const fakeFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({ access_token: 'tok', token_type: 'Bearer', expires_in: 3600 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const loginAuth = new LoginAuthService({
      users,
      authIdentities,
      oauthStates,
      authService,
      credentials: {
        apple: {
          clientId: 'apple-cid',
          clientSecret: 'apple-secret',
          redirectUri: 'https://app.test/cb',
        },
      },
      fetchImpl: fakeFetch,
    });
    const providers: LoginProviderRegistry = { apple: new AppleLoginHandler() };
    const localApp = new Hono();
    localApp.route('/oauth', loginAuthRoutes({ loginAuth, providers }));
    const start = await localApp.request('http://x/oauth/apple/start');
    const stateMatch = (start.headers.get('location') ?? '').match(/state=([0-9a-f]+)/);
    const state = stateMatch?.[1];
    const cb = await localApp.request(`http://x/oauth/apple/callback?code=c&state=${state}`);
    expect(cb.status).toBe(501);
    const body = await cb.json();
    expect(body).toMatchObject({ error: 'login_provider_not_implemented', providerId: 'apple' });
  });
});
