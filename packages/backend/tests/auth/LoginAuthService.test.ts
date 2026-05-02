/**
 * LoginAuthService — unit tests with a fake login provider + mocked fetch.
 *
 * Real Google OIDC isn't called; the fake handler returns a profile we control
 * so we can assert all four matching paths:
 *   1. Brand-new user (no auth_identity, no user-by-email)
 *   2. Returning user (existing auth_identity)
 *   3. Auto-link to existing user-by-email (verified email only)
 *   4. Don't auto-link when email is unverified — create a new user instead
 */

import { describe, expect, it } from 'vitest';
import type { OAuthProviderConfig, OAuthTokens } from '@opendj/auth';
import { AuthService } from '../../src/auth/AuthService.js';
import { ClaimsService } from '../../src/auth/ClaimsService.js';
import { LoginAuthError, LoginAuthService } from '../../src/auth/LoginAuthService.js';
import type { LoginProviderHandler, ProviderProfile } from '../../src/auth/loginProviders/types.js';
import {
  InMemoryAccountRepository,
  InMemoryAuthIdentityRepository,
  InMemoryAuthSessionRepository,
  InMemoryMembershipRepository,
  InMemoryOAuthStateRepository,
  InMemoryUserRepository,
} from '../../src/repositories/in-memory/index.js';

const NOW = new Date('2026-04-30T10:00:00Z').getTime();
const FAKE_TOKEN_URL = 'https://example.test/token';

const FAKE_OAUTH_CONFIG: OAuthProviderConfig = {
  providerId: 'fakeoidc',
  authorizeUrl: 'https://example.test/authorize',
  tokenUrl: FAKE_TOKEN_URL,
  defaultScopes: ['openid', 'email', 'profile'],
  verifiesIdToken: true,
};

class FakeLoginHandler implements LoginProviderHandler {
  readonly providerId = 'fakeoidc';
  readonly oauthConfig = FAKE_OAUTH_CONFIG;
  constructor(private readonly profile: ProviderProfile) {}
  async fetchProfile(_tokens: OAuthTokens, _fetchImpl: typeof fetch): Promise<ProviderProfile> {
    return this.profile;
  }
}

function tokenResponse(): Response {
  return new Response(
    JSON.stringify({
      access_token: 'tok-access',
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: 'tok-refresh',
      scope: 'openid email profile',
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function setup(profile: ProviderProfile, opts: { configured?: boolean } = {}) {
  const clock = { now: () => new Date(NOW) };
  const users = new InMemoryUserRepository(clock);
  const accounts = new InMemoryAccountRepository();
  const memberships = new InMemoryMembershipRepository();
  const authIdentities = new InMemoryAuthIdentityRepository(clock);
  const authSessions = new InMemoryAuthSessionRepository(clock);
  const oauthStates = new InMemoryOAuthStateRepository(clock);
  const claims = new ClaimsService({ memberships, accounts });
  const authService = new AuthService({ authSessions, claims });

  const handler = new FakeLoginHandler(profile);
  const fetchImpl: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === FAKE_TOKEN_URL) return tokenResponse();
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const service = new LoginAuthService({
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
    fetchImpl,
  });

  return { service, handler, users, authIdentities, authSessions, oauthStates };
}

const baseProfile: ProviderProfile = {
  providerSubject: 'goog-sub-123',
  email: 'user@example.com',
  emailVerified: true,
  displayName: 'Real User',
  avatarUrl: 'https://cdn.test/u.png',
  raw: { sub: 'goog-sub-123' },
};

describe('LoginAuthService.start', () => {
  it('persists an oauth_states row and returns the authorize URL with state', async () => {
    const { service, handler, oauthStates } = setup(baseProfile);
    const result = await service.start(handler);
    expect(result.state).toMatch(/^[0-9a-f]{64}$/);
    expect(result.authorizeUrl).toContain('https://example.test/authorize?');
    expect(result.authorizeUrl).toContain(`state=${result.state}`);
    expect(result.authorizeUrl).toContain('client_id=fake-client');
    const row = oauthStates.rows.get(result.state);
    expect(row?.flowKind).toBe('login');
    expect(row?.providerId).toBe('fakeoidc');
  });

  it('throws provider_not_configured when no credentials are present', async () => {
    const { service, handler } = setup(baseProfile, { configured: false });
    await expect(service.start(handler)).rejects.toMatchObject({ code: 'provider_not_configured' });
  });
});

describe('LoginAuthService.complete', () => {
  it('creates a brand-new user + identity and issues a session', async () => {
    const { service, handler, users, authIdentities } = setup(baseProfile);
    const start = await service.start(handler);
    const result = await service.complete(handler, 'auth-code', start.state);
    expect(result.session.token).toMatch(/^[0-9a-f]{64}$/);
    expect(users.rows.size).toBe(1);
    const user = [...users.rows.values()][0]!;
    expect(user.primaryEmail).toBe('user@example.com');
    expect(user.emailVerified).toBe(true);
    expect(user.displayName).toBe('Real User');
    const identity = await authIdentities.findByProvider('fakeoidc', 'goog-sub-123');
    expect(identity?.userId).toBe(user.id);
  });

  it('reuses an existing identity → existing user, no duplicate user', async () => {
    const { service, handler, users } = setup(baseProfile);
    const start1 = await service.start(handler);
    const first = await service.complete(handler, 'code-1', start1.state);
    const start2 = await service.start(handler);
    const second = await service.complete(handler, 'code-2', start2.state);
    expect(second.user.id).toBe(first.user.id);
    expect(users.rows.size).toBe(1);
  });

  it('auto-links to an existing user-by-email when the provider verified the email', async () => {
    const { service, handler, users } = setup(baseProfile);
    const existing = await users.create({
      primaryEmail: 'user@example.com',
      emailVerified: false,
    });
    const start = await service.start(handler);
    const result = await service.complete(handler, 'code', start.state);
    expect(result.user.id).toBe(existing.id);
    expect(users.rows.size).toBe(1);
  });

  it('does NOT auto-link when the provider did not verify the email — creates a new user', async () => {
    const profile: ProviderProfile = { ...baseProfile, emailVerified: false };
    const { service, handler, users } = setup(profile);
    await users.create({ primaryEmail: 'user@example.com', emailVerified: false });
    const start = await service.start(handler);
    const result = await service.complete(handler, 'code', start.state);
    expect(users.rows.size).toBe(2);
    const newUser = [...users.rows.values()].find((u) => u.id === result.user.id);
    expect(newUser?.id).toBe(result.user.id);
  });

  it('throws invalid_or_expired_state when the state is unknown', async () => {
    const { service, handler } = setup(baseProfile);
    await expect(service.complete(handler, 'code', 'never-issued')).rejects.toMatchObject({
      code: 'invalid_or_expired_state',
    });
  });

  it('throws state_provider_mismatch when state was issued for another provider', async () => {
    const { service, handler, oauthStates } = setup(baseProfile);
    // Manually-seeded state — use real-clock expiry since LoginAuthService.complete
    // calls Date.now() internally for the expiry check.
    await oauthStates.create({
      state: 'cross-provider-state',
      flowKind: 'login',
      providerId: 'someone-else',
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(service.complete(handler, 'code', 'cross-provider-state')).rejects.toMatchObject({
      code: 'state_provider_mismatch',
    });
  });

  it('throws wrong_flow_kind when state was issued for connect-provider flow', async () => {
    const { service, handler, oauthStates } = setup(baseProfile);
    await oauthStates.create({
      state: 'connect-state',
      flowKind: 'connect-provider',
      providerId: 'fakeoidc',
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(service.complete(handler, 'code', 'connect-state')).rejects.toMatchObject({
      code: 'wrong_flow_kind',
    });
  });

  it('consumes state — replay attempts fail', async () => {
    const { service, handler } = setup(baseProfile);
    const start = await service.start(handler);
    await service.complete(handler, 'code', start.state);
    await expect(service.complete(handler, 'code', start.state)).rejects.toMatchObject({
      code: 'invalid_or_expired_state',
    });
  });
});

describe('LoginAuthService error mapping', () => {
  it('LoginAuthError carries a code', () => {
    const err = new LoginAuthError('provider_not_configured', 'no creds');
    expect(err.code).toBe('provider_not_configured');
    expect(err.name).toBe('LoginAuthError');
  });
});
