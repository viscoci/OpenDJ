import { beforeEach, describe, expect, it } from 'vitest';
import { hashSessionToken } from '@opendj/auth';
import {
  AuthService,
  DEFAULT_SESSION_TTL_MS,
  parseSessionCookie,
  SESSION_COOKIE_NAME,
  TOUCH_DEBOUNCE_MS,
} from '../../src/auth/AuthService.js';
import { ClaimsService } from '../../src/auth/ClaimsService.js';
import {
  InMemoryAccountRepository,
  InMemoryAuthSessionRepository,
  InMemoryMembershipRepository,
} from '../../src/repositories/in-memory/index.js';

const NOW = new Date('2026-04-30T12:00:00Z').getTime();

function setup(opts: { ttlMs?: number; nowEpochMs?: number } = {}) {
  const fixedNow = opts.nowEpochMs ?? NOW;
  const clock = { now: () => new Date(fixedNow) };
  const memberships = new InMemoryMembershipRepository();
  const accounts = new InMemoryAccountRepository();
  const authSessions = new InMemoryAuthSessionRepository(clock);
  const claims = new ClaimsService({ memberships, accounts });
  const service = new AuthService({
    authSessions,
    claims,
    ...(opts.ttlMs !== undefined && { sessionTtlMs: opts.ttlMs }),
  });
  return { memberships, accounts, authSessions, claims, service };
}

describe('AuthService.issueSession', () => {
  it('returns token + sessionId + expiresAt', async () => {
    const { service } = setup();
    const issued = await service.issueSession({ userId: 'u-1', nowEpochMs: NOW });
    expect(issued.token).toMatch(/^[0-9a-f]{64}$/);
    expect(issued.sessionId).toBeTypeOf('string');
    expect(issued.expiresAt.getTime()).toBe(NOW + DEFAULT_SESSION_TTL_MS);
  });

  it('persists the SHA-256 hash, not the plaintext token', async () => {
    const { service, authSessions } = setup();
    const issued = await service.issueSession({ userId: 'u-1', nowEpochMs: NOW });
    const hash = await hashSessionToken(issued.token);
    const stored = [...authSessions.rows.values()][0]!;
    expect(stored.sessionHash).toBe(hash);
    expect(stored.sessionHash).not.toBe(issued.token);
  });

  it('captures claims snapshot when currentAccountId is provided', async () => {
    const { service, memberships, accounts, authSessions } = setup();
    accounts.seed({
      id: 'acc-1',
      displayName: 'A',
      slug: 'a',
      plan: 'free',
      createdAt: new Date(),
    });
    memberships.seed({
      accountId: 'acc-1',
      userId: 'u-1',
      status: 'active',
      role: 'host',
      claims: ['account:read', 'session:create'],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await service.issueSession({ userId: 'u-1', currentAccountId: 'acc-1', nowEpochMs: NOW });
    const stored = [...authSessions.rows.values()][0]!;
    expect(stored.claimsSnapshot).toEqual(['account:read', 'session:create']);
    expect(stored.currentAccountId).toBe('acc-1');
  });

  it('uses the provided claimsSnapshot override (skips ClaimsService)', async () => {
    const { service, authSessions } = setup();
    await service.issueSession({
      userId: 'u-svc',
      currentAccountId: 'acc-1',
      claimsSnapshot: ['admin:global'],
      nowEpochMs: NOW,
    });
    const stored = [...authSessions.rows.values()][0]!;
    expect(stored.claimsSnapshot).toEqual(['admin:global']);
  });

  it('records ipHash + userAgentHash when provided', async () => {
    const { service, authSessions } = setup();
    await service.issueSession({
      userId: 'u-1',
      ipHash: 'ip-hash',
      userAgentHash: 'ua-hash',
      nowEpochMs: NOW,
    });
    const stored = [...authSessions.rows.values()][0]!;
    expect(stored.ipHash).toBe('ip-hash');
    expect(stored.userAgentHash).toBe('ua-hash');
  });

  it('respects per-session ttlMs override', async () => {
    const { service } = setup();
    const issued = await service.issueSession({
      userId: 'u-1',
      nowEpochMs: NOW,
      ttlMs: 60_000,
    });
    expect(issued.expiresAt.getTime()).toBe(NOW + 60_000);
  });

  it('respects constructor-level sessionTtlMs', async () => {
    const { service } = setup({ ttlMs: 30_000 });
    const issued = await service.issueSession({ userId: 'u-1', nowEpochMs: NOW });
    expect(issued.expiresAt.getTime()).toBe(NOW + 30_000);
  });
});

describe('AuthService.resolveAuthContext', () => {
  it('returns null for an unknown token', async () => {
    const { service } = setup();
    expect(await service.resolveAuthContext('does-not-exist', NOW)).toBeNull();
  });

  it('returns context + sessionId for a fresh session', async () => {
    const { service } = setup();
    const issued = await service.issueSession({
      userId: 'u-1',
      currentAccountId: 'acc-1',
      claimsSnapshot: ['account:read'],
      nowEpochMs: NOW,
    });
    const resolved = await service.resolveAuthContext(issued.token, NOW + 1000);
    expect(resolved).not.toBeNull();
    expect(resolved!.sessionId).toBe(issued.sessionId);
    expect(resolved!.context.userId).toBe('u-1');
    expect(resolved!.context.currentAccountId).toBe('acc-1');
    expect(resolved!.context.claims).toEqual(['account:read']);
    expect(resolved!.context.authKind).toBe('host');
  });

  it('returns logged_in_guest when no claims are held', async () => {
    const { service } = setup();
    const issued = await service.issueSession({ userId: 'u-1', nowEpochMs: NOW });
    const resolved = await service.resolveAuthContext(issued.token, NOW + 1000);
    expect(resolved!.context.authKind).toBe('logged_in_guest');
  });

  it('returns null after the session is revoked', async () => {
    const { service } = setup();
    const issued = await service.issueSession({ userId: 'u-1', nowEpochMs: NOW });
    await service.revokeSession(issued.sessionId, NOW + 100);
    expect(await service.resolveAuthContext(issued.token, NOW + 200)).toBeNull();
  });

  it('returns null after the session expires', async () => {
    const { service } = setup({ ttlMs: 60_000 });
    const issued = await service.issueSession({ userId: 'u-1', nowEpochMs: NOW });
    expect(await service.resolveAuthContext(issued.token, NOW + 70_000)).toBeNull();
  });

  it('does NOT touch lastSeenAt within the debounce window', async () => {
    const { service, authSessions } = setup();
    const issued = await service.issueSession({ userId: 'u-1', nowEpochMs: NOW });
    const before = [...authSessions.rows.values()][0]!.lastSeenAt;
    await service.resolveAuthContext(issued.token, NOW + 1000);
    const after = [...authSessions.rows.values()][0]!.lastSeenAt;
    expect(after.getTime()).toBe(before.getTime());
  });

  it('touches lastSeenAt after the debounce window elapses', async () => {
    const { service, authSessions } = setup();
    const issued = await service.issueSession({ userId: 'u-1', nowEpochMs: NOW });
    await service.resolveAuthContext(issued.token, NOW + TOUCH_DEBOUNCE_MS + 1);
    const stored = [...authSessions.rows.values()][0]!;
    expect(stored.lastSeenAt.getTime()).toBe(NOW + TOUCH_DEBOUNCE_MS + 1);
  });
});

describe('AuthService.refreshClaimsSnapshot', () => {
  it('re-reads ClaimsService and writes back to the session row', async () => {
    const { service, memberships, accounts, authSessions } = setup();
    accounts.seed({
      id: 'acc-1',
      displayName: 'A',
      slug: 'a',
      plan: 'free',
      createdAt: new Date(),
    });

    const issued = await service.issueSession({
      userId: 'u-1',
      currentAccountId: 'acc-1',
      nowEpochMs: NOW,
    });
    expect([...authSessions.rows.values()][0]!.claimsSnapshot).toEqual([]);

    memberships.seed({
      accountId: 'acc-1',
      userId: 'u-1',
      status: 'active',
      role: 'host',
      claims: ['account:read'],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const claims = await service.refreshClaimsSnapshot(issued.sessionId, 'u-1', 'acc-1');
    expect(claims).toEqual(['account:read']);
    expect([...authSessions.rows.values()][0]!.claimsSnapshot).toEqual(['account:read']);
  });
});

describe('parseSessionCookie', () => {
  it('returns the token when present', () => {
    expect(parseSessionCookie(`${SESSION_COOKIE_NAME}=abc123`)).toBe('abc123');
  });

  it('tolerates surrounding cookies + whitespace', () => {
    expect(parseSessionCookie(`other=val; ${SESSION_COOKIE_NAME}=mine; trailing=tail`)).toBe(
      'mine',
    );
  });

  it('returns null when cookie absent', () => {
    expect(parseSessionCookie('other=val')).toBeNull();
    expect(parseSessionCookie('')).toBeNull();
    expect(parseSessionCookie(null)).toBeNull();
    expect(parseSessionCookie(undefined)).toBeNull();
  });

  it('returns null when value is empty', () => {
    expect(parseSessionCookie(`${SESSION_COOKIE_NAME}=`)).toBeNull();
  });
});
