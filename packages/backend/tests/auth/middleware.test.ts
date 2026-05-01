import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { AuthService, SESSION_COOKIE_NAME } from '../../src/auth/AuthService.js';
import { ClaimsService } from '../../src/auth/ClaimsService.js';
import {
  optionalAuth,
  requireAnyClaim,
  requireAuth,
  requireClaim,
  type AuthVariables,
} from '../../src/auth/middleware.js';
import {
  InMemoryAccountRepository,
  InMemoryAuthSessionRepository,
  InMemoryMembershipRepository,
} from '../../src/repositories/in-memory/index.js';

function newApp() {
  const memberships = new InMemoryMembershipRepository();
  const accounts = new InMemoryAccountRepository();
  const authSessions = new InMemoryAuthSessionRepository();
  const claims = new ClaimsService({ memberships, accounts });
  const auth = new AuthService({ authSessions, claims });
  const app = new Hono<{ Variables: AuthVariables }>();
  return { app, auth, memberships, accounts, authSessions };
}

async function issueAndCookie(auth: AuthService, opts: { claims?: string[] } = {}) {
  const issued = await auth.issueSession({
    userId: 'u-1',
    currentAccountId: 'acc-1',
    claimsSnapshot: (opts.claims ?? []) as Parameters<
      typeof auth.issueSession
    >[0]['claimsSnapshot'],
  });
  return `${SESSION_COOKIE_NAME}=${issued.token}`;
}

describe('optionalAuth', () => {
  it('sets auth to null when no cookie', async () => {
    const { app, auth } = newApp();
    app.use(optionalAuth(auth));
    app.get('/', (c) => c.json({ auth: c.get('auth') }));
    const res = await app.request('/');
    const body = (await res.json()) as { auth: unknown };
    expect(body.auth).toBeNull();
  });

  it('sets auth to AuthContext when cookie is valid', async () => {
    const { app, auth } = newApp();
    app.use(optionalAuth(auth));
    app.get('/', (c) => c.json({ auth: c.get('auth') }));
    const cookie = await issueAndCookie(auth, { claims: ['account:read'] });
    const res = await app.request('/', { headers: { cookie } });
    const body = (await res.json()) as { auth: { userId: string; claims: string[] } | null };
    expect(body.auth?.userId).toBe('u-1');
    expect(body.auth?.claims).toEqual(['account:read']);
  });

  it('sets auth to null when cookie is unknown / invalid', async () => {
    const { app, auth } = newApp();
    app.use(optionalAuth(auth));
    app.get('/', (c) => c.json({ auth: c.get('auth') }));
    const res = await app.request('/', {
      headers: { cookie: `${SESSION_COOKIE_NAME}=invalid-token` },
    });
    const body = (await res.json()) as { auth: unknown };
    expect(body.auth).toBeNull();
  });
});

describe('requireAuth', () => {
  it('returns 401 with no cookie', async () => {
    const { app, auth } = newApp();
    app.use(requireAuth(auth));
    app.get('/', (c) => c.text('ok'));
    const res = await app.request('/');
    expect(res.status).toBe(401);
  });

  it('returns 401 with invalid cookie', async () => {
    const { app, auth } = newApp();
    app.use(requireAuth(auth));
    app.get('/', (c) => c.text('ok'));
    const res = await app.request('/', {
      headers: { cookie: `${SESSION_COOKIE_NAME}=invalid-token` },
    });
    expect(res.status).toBe(401);
  });

  it('passes through with a valid session and exposes c.var.auth', async () => {
    const { app, auth } = newApp();
    app.use(requireAuth(auth));
    app.get('/', (c) => c.json({ user: c.get('auth')!.userId }));
    const cookie = await issueAndCookie(auth);
    const res = await app.request('/', { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: 'u-1' });
  });
});

describe('requireClaim', () => {
  it('returns 401 unauth when no session', async () => {
    const { app, auth } = newApp();
    app.use(requireClaim(auth, 'account:read'));
    app.get('/', (c) => c.text('ok'));
    const res = await app.request('/');
    expect(res.status).toBe(401);
  });

  it('returns 403 with missingClaim payload when claim not held', async () => {
    const { app, auth } = newApp();
    app.use(requireClaim(auth, 'billing:manage'));
    app.get('/', (c) => c.text('ok'));
    const cookie = await issueAndCookie(auth, { claims: ['account:read'] });
    const res = await app.request('/', { headers: { cookie } });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; missingClaim: string };
    expect(body).toEqual({ error: 'forbidden', missingClaim: 'billing:manage' });
  });

  it('passes when claim is held', async () => {
    const { app, auth } = newApp();
    app.use(requireClaim(auth, 'account:read'));
    app.get('/', (c) => c.text('ok'));
    const cookie = await issueAndCookie(auth, { claims: ['account:read'] });
    const res = await app.request('/', { headers: { cookie } });
    expect(res.status).toBe(200);
  });
});

describe('requireAnyClaim', () => {
  it('passes when any of the listed claims is held', async () => {
    const { app, auth } = newApp();
    app.use(requireAnyClaim(auth, ['billing:manage', 'account:read']));
    app.get('/', (c) => c.text('ok'));
    const cookie = await issueAndCookie(auth, { claims: ['account:read'] });
    const res = await app.request('/', { headers: { cookie } });
    expect(res.status).toBe(200);
  });

  it('returns 403 with missingAnyClaim payload when none held', async () => {
    const { app, auth } = newApp();
    app.use(requireAnyClaim(auth, ['billing:manage', 'admin:global']));
    app.get('/', (c) => c.text('ok'));
    const cookie = await issueAndCookie(auth, { claims: ['account:read'] });
    const res = await app.request('/', { headers: { cookie } });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; missingAnyClaim: string[] };
    expect(body.error).toBe('forbidden');
    expect(body.missingAnyClaim).toEqual(['billing:manage', 'admin:global']);
  });
});
