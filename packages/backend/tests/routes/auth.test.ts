import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { AuthService, SESSION_COOKIE_NAME } from '../../src/auth/AuthService.js';
import { ClaimsService } from '../../src/auth/ClaimsService.js';
import { type AuthVariables } from '../../src/auth/middleware.js';
import {
  InMemoryAccountRepository,
  InMemoryAuthSessionRepository,
  InMemoryMembershipRepository,
  InMemoryUserRepository,
} from '../../src/repositories/in-memory/index.js';
import { authRoutes } from '../../src/routes/auth.js';

const NOW = new Date('2026-04-30T12:00:00Z').getTime();

interface SetupOptions {
  withMembership?: boolean;
}

async function setup(options: SetupOptions = {}) {
  const fixedNow = NOW;
  const clock = { now: () => new Date(fixedNow) };
  const users = new InMemoryUserRepository(clock);
  const accounts = new InMemoryAccountRepository();
  const memberships = new InMemoryMembershipRepository();
  const authSessions = new InMemoryAuthSessionRepository(clock);
  const claimsService = new ClaimsService({ memberships, accounts });
  const authService = new AuthService({
    authSessions,
    claims: claimsService,
    clock: () => fixedNow,
  });

  const user = await users.create({ primaryEmail: 'u@example.com', displayName: 'U One' });
  accounts.seed({
    id: '11111111-1111-1111-1111-111111111111',
    displayName: 'Test Account',
    slug: 'test',
    plan: 'free',
    createdAt: new Date(fixedNow),
  });
  if (options.withMembership) {
    memberships.seed({
      accountId: '11111111-1111-1111-1111-111111111111',
      userId: user.id,
      status: 'active',
      role: 'host',
      claims: ['account:read', 'session:create'],
      createdAt: new Date(fixedNow),
      updatedAt: new Date(fixedNow),
    });
  }

  const app = new Hono<{ Variables: AuthVariables }>();
  app.route('/', authRoutes({ authService, claimsService, users }));

  return { app, authService, claimsService, users, accounts, memberships, authSessions, user };
}

async function login(authService: AuthService, userId: string, accountId?: string) {
  const issued = await authService.issueSession({
    userId,
    ...(accountId !== undefined && { currentAccountId: accountId }),
    nowEpochMs: NOW,
  });
  return `${SESSION_COOKIE_NAME}=${issued.token}`;
}

describe('GET /me', () => {
  it('returns 401 without a session', async () => {
    const { app } = await setup();
    const res = await app.request('/me');
    expect(res.status).toBe(401);
  });

  it('returns user + claims + accounts list', async () => {
    const { app, authService, user } = await setup({ withMembership: true });
    const cookie = await login(authService, user.id, '11111111-1111-1111-1111-111111111111');
    const res = await app.request('/me', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      user: { id: string; primaryEmail: string };
      currentAccountId: string;
      claims: string[];
      accounts: Array<{ accountId: string; role: string }>;
    };
    expect(body.user.id).toBe(user.id);
    expect(body.user.primaryEmail).toBe('u@example.com');
    expect(body.currentAccountId).toBe('11111111-1111-1111-1111-111111111111');
    expect(body.claims).toEqual(['account:read', 'session:create']);
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0]?.role).toBe('host');
  });

  it('returns user even when no account is selected (logged-in guest)', async () => {
    const { app, authService, user } = await setup();
    const cookie = await login(authService, user.id);
    const res = await app.request('/me', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { currentAccountId: string | null; accounts: unknown[] };
    expect(body.currentAccountId).toBeNull();
    expect(body.accounts).toEqual([]);
  });

  it('401s when the session points at a deleted user', async () => {
    const { app, authService, users, user } = await setup();
    const cookie = await login(authService, user.id);
    users.rows.delete(user.id);
    const res = await app.request('/me', { headers: { cookie } });
    expect(res.status).toBe(401);
  });
});

describe('POST /logout', () => {
  it('returns 401 without a session', async () => {
    const { app } = await setup();
    const res = await app.request('/logout', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('revokes the session, clears the cookie, and the session no longer authenticates', async () => {
    const { app, authService, user } = await setup();
    const cookie = await login(authService, user.id);

    const res = await app.request('/logout', { method: 'POST', headers: { cookie } });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(setCookie).toContain('Max-Age=0');

    // Same cookie should now fail auth.
    const me = await app.request('/me', { headers: { cookie } });
    expect(me.status).toBe(401);
  });
});

describe('POST /switch-account', () => {
  it('returns 401 without a session', async () => {
    const { app } = await setup();
    const res = await app.request('/switch-account', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('returns 400 on invalid body', async () => {
    const { app, authService, user } = await setup();
    const cookie = await login(authService, user.id);
    const res = await app.request('/switch-account', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: '{"accountId": "not-a-uuid"}',
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 on non-JSON body', async () => {
    const { app, authService, user } = await setup();
    const cookie = await login(authService, user.id);
    const res = await app.request('/switch-account', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
  });

  it('returns 403 when user is not a member of the target account', async () => {
    const { app, authService, user } = await setup();
    const cookie = await login(authService, user.id);
    const res = await app.request('/switch-account', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: '{"accountId": "00000000-0000-0000-0000-000000000999"}',
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('not_account_member');
  });

  it('switches account, refreshes claims, and persists on the session row', async () => {
    const { app, authService, authSessions, user } = await setup({ withMembership: true });
    const cookie = await login(authService, user.id);
    const res = await app.request('/switch-account', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: '{"accountId": "11111111-1111-1111-1111-111111111111"}',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { currentAccountId: string; claims: string[] };
    expect(body.currentAccountId).toBe('11111111-1111-1111-1111-111111111111');
    expect(body.claims).toEqual(['account:read', 'session:create']);

    const stored = [...authSessions.rows.values()][0]!;
    expect(stored.currentAccountId).toBe('11111111-1111-1111-1111-111111111111');
    expect(stored.claimsSnapshot).toEqual(['account:read', 'session:create']);
  });
});
