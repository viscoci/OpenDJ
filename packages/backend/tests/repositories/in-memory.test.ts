import { beforeEach, describe, expect, it } from 'vitest';
import {
  createInMemoryRepositories,
  InMemoryAuthSessionRepository,
  InMemoryKaraokeClaimRepository,
  InMemoryProviderConnectionRepository,
  InMemoryUserRepository,
} from '../../src/repositories/in-memory/index.js';

describe('InMemoryProviderConnectionRepository.extendRateLimitedUntil', () => {
  const base = Date.UTC(2026, 9, 23, 12, 0, 0, 0);

  function ext(
    accountId: string,
    until: Date,
    group: 'search' | 'player' = 'player',
    clientId: string | null = 'client-a',
  ) {
    return { accountId, providerId: 'spotify', group, until, clientId };
  }

  async function withConnection() {
    let now = new Date(base);
    const repo = new InMemoryProviderConnectionRepository({ now: () => now });
    await repo.upsert({ accountId: 'acct-1', providerId: 'spotify', accessToken: 'tok' });
    return {
      repo,
      setNow(d: Date) {
        now = d;
      },
    };
  }

  it('starts with no rate-limit deadline', async () => {
    const { repo } = await withConnection();
    const row = await repo.findByAccountAndProvider('acct-1', 'spotify');
    expect(row?.rateLimitedUntil).toBeNull();
    expect(row?.searchRateLimitedUntil).toBeNull();
    expect(row?.rateLimitedClientId).toBeNull();
  });

  it('stores the deadline at millisecond precision', async () => {
    const { repo } = await withConnection();
    const until = new Date(base + 123_457);

    expect(await repo.extendRateLimitedUntil(ext('acct-1', until))).toBe(true);

    const row = await repo.findByAccountAndProvider('acct-1', 'spotify');
    expect(row?.rateLimitedUntil?.getTime()).toBe(until.getTime());
  });

  it('keeps the larger deadline when writes land out of order', async () => {
    const { repo } = await withConnection();
    await repo.extendRateLimitedUntil(ext('acct-1', new Date(base + 200_000)));
    await repo.extendRateLimitedUntil(ext('acct-1', new Date(base + 100_000)));

    const row = await repo.findByAccountAndProvider('acct-1', 'spotify');
    expect(row?.rateLimitedUntil?.getTime()).toBe(base + 200_000);
  });

  it('keeps the larger deadline per quota group, each in its own column', async () => {
    const { repo } = await withConnection();
    await repo.extendRateLimitedUntil(ext('acct-1', new Date(base + 900_000), 'search'));
    await repo.extendRateLimitedUntil(ext('acct-1', new Date(base + 100_000), 'player'));
    await repo.extendRateLimitedUntil(ext('acct-1', new Date(base + 300_000), 'search'));

    const row = await repo.findByAccountAndProvider('acct-1', 'spotify');
    expect(row?.searchRateLimitedUntil?.getTime()).toBe(base + 900_000);
    expect(row?.rateLimitedUntil?.getTime()).toBe(base + 100_000);
    expect(row?.rateLimitedClientId).toBe('client-a');
  });

  it('a write under a new client id replaces the old client deadlines', async () => {
    const { repo } = await withConnection();
    await repo.extendRateLimitedUntil(ext('acct-1', new Date(base + 900_000), 'search', 'old'));
    await repo.extendRateLimitedUntil(ext('acct-1', new Date(base + 800_000), 'player', 'old'));

    await repo.extendRateLimitedUntil(ext('acct-1', new Date(base + 60_000), 'player', 'new'));

    const row = await repo.findByAccountAndProvider('acct-1', 'spotify');
    expect(row?.rateLimitedUntil?.getTime()).toBe(base + 60_000);
    expect(row?.searchRateLimitedUntil).toBeNull();
    expect(row?.rateLimitedClientId).toBe('new');
  });

  it('is a no-op that does not throw when the connection row is missing', async () => {
    const { repo } = await withConnection();

    expect(await repo.extendRateLimitedUntil(ext('acct-2', new Date(base + 1_000)))).toBe(false);
    expect(await repo.findByAccountAndProvider('acct-2', 'spotify')).toBeNull();
    expect(repo.rows.size).toBe(1);
  });

  it('leaves updatedAt untouched', async () => {
    const { repo, setNow } = await withConnection();
    const before = (await repo.findByAccountAndProvider('acct-1', 'spotify'))!.updatedAt;
    setNow(new Date(base + 60_000));

    await repo.extendRateLimitedUntil(ext('acct-1', new Date(base + 600_000)));

    const row = await repo.findByAccountAndProvider('acct-1', 'spotify');
    expect(row?.updatedAt.getTime()).toBe(before.getTime());
  });

  it('a reconnect upsert keeps an existing future deadline', async () => {
    const { repo } = await withConnection();
    await repo.extendRateLimitedUntil(ext('acct-1', new Date(base + 600_000)));

    const upserted = await repo.upsert({
      accountId: 'acct-1',
      providerId: 'spotify',
      accessToken: 'new-tok',
    });

    expect(upserted.accessToken).toBe('new-tok');
    expect(upserted.rateLimitedUntil?.getTime()).toBe(base + 600_000);
  });
});

describe('createInMemoryRepositories', () => {
  it('returns one of each repository', () => {
    const repos = createInMemoryRepositories();
    expect(repos.users).toBeDefined();
    expect(repos.accounts).toBeDefined();
    expect(repos.memberships).toBeDefined();
    expect(repos.authIdentities).toBeDefined();
    expect(repos.authSessions).toBeDefined();
    expect(repos.passwordCredentials).toBeDefined();
    expect(repos.karaokeClaims).toBeDefined();
  });
});

describe('InMemoryKaraokeClaimRepository', () => {
  let claims: InMemoryKaraokeClaimRepository;
  beforeEach(() => {
    claims = new InMemoryKaraokeClaimRepository();
  });

  it('creates and finds by item + guest', async () => {
    const created = await claims.create({
      sessionId: 's-1',
      queueItemId: 'i-1',
      guestId: 'g-1',
      displayName: 'Ana',
    });
    expect(await claims.findByItemAndGuest('i-1', 'g-1')).toBe(created);
    expect(await claims.findByItemAndGuest('i-1', 'g-2')).toBeNull();
  });

  it('enforces the unique (item, guest) pair like the DB constraint', async () => {
    await claims.create({
      sessionId: 's-1',
      queueItemId: 'i-1',
      guestId: 'g-1',
      displayName: 'Ana',
    });
    await expect(
      claims.create({ sessionId: 's-1', queueItemId: 'i-1', guestId: 'g-1', displayName: 'Dup' }),
    ).rejects.toThrow();
  });

  it('lists per item and per session', async () => {
    await claims.create({
      sessionId: 's-1',
      queueItemId: 'i-1',
      guestId: 'g-1',
      displayName: 'Ana',
    });
    await claims.create({
      sessionId: 's-1',
      queueItemId: 'i-2',
      guestId: 'g-1',
      displayName: 'Ana',
    });
    await claims.create({
      sessionId: 's-2',
      queueItemId: 'i-9',
      guestId: 'g-9',
      displayName: 'Zoe',
    });
    expect(await claims.findAllForItem('i-1')).toHaveLength(1);
    expect(await claims.findAllForSession('s-1')).toHaveLength(2);
    expect(await claims.findAllForSession('s-2')).toHaveLength(1);
  });

  it('deletes by id', async () => {
    const created = await claims.create({
      sessionId: 's-1',
      queueItemId: 'i-1',
      guestId: 'g-1',
      displayName: 'Ana',
    });
    await claims.delete(created.id);
    expect(await claims.findAllForItem('i-1')).toEqual([]);
  });
});

describe('InMemoryUserRepository', () => {
  let users: InMemoryUserRepository;
  beforeEach(() => {
    users = new InMemoryUserRepository();
  });

  it('creates and looks up by id', async () => {
    const user = await users.create({ primaryEmail: 'a@example.com', displayName: 'A' });
    expect(await users.findById(user.id)).toBe(user);
  });

  it('looks up case-insensitively by primary email', async () => {
    await users.create({ primaryEmail: 'a@Example.com' });
    expect(await users.findByPrimaryEmail('A@example.COM')).toBeTruthy();
  });

  it('returns null for unknown lookups', async () => {
    expect(await users.findById('nope')).toBeNull();
    expect(await users.findByPrimaryEmail('nope@example.com')).toBeNull();
  });

  it('defaults emailVerified=false and status=active', async () => {
    const user = await users.create({ primaryEmail: 'x@example.com' });
    expect(user.emailVerified).toBe(false);
    expect(user.status).toBe('active');
  });

  it('assigns publicUserId monotonically', async () => {
    const a = await users.create({});
    const b = await users.create({});
    expect(b.publicUserId).toBeGreaterThan(a.publicUserId);
  });
});

describe('InMemoryAuthSessionRepository', () => {
  let sessions: InMemoryAuthSessionRepository;
  beforeEach(() => {
    sessions = new InMemoryAuthSessionRepository();
  });

  it('finds active sessions by hash', async () => {
    const created = await sessions.create({
      userId: 'u-1',
      currentAccountId: null,
      sessionHash: 'hash-1',
      claimsSnapshot: [],
      expiresAt: new Date('2030-01-01T00:00:00Z'),
    });
    const now = new Date('2026-04-30T12:00:00Z').getTime();
    const found = await sessions.findActiveByHash('hash-1', now);
    expect(found?.id).toBe(created.id);
  });

  it('does not return revoked sessions', async () => {
    const created = await sessions.create({
      userId: 'u-1',
      currentAccountId: null,
      sessionHash: 'hash-1',
      claimsSnapshot: [],
      expiresAt: new Date('2030-01-01T00:00:00Z'),
    });
    await sessions.revoke(created.id, Date.now());
    expect(await sessions.findActiveByHash('hash-1', Date.now())).toBeNull();
  });

  it('does not return expired sessions', async () => {
    await sessions.create({
      userId: 'u-1',
      currentAccountId: null,
      sessionHash: 'hash-1',
      claimsSnapshot: [],
      expiresAt: new Date('2026-04-30T11:00:00Z'),
    });
    const now = new Date('2026-04-30T12:00:00Z').getTime();
    expect(await sessions.findActiveByHash('hash-1', now)).toBeNull();
  });

  it('touches lastSeenAt', async () => {
    const created = await sessions.create({
      userId: 'u-1',
      currentAccountId: null,
      sessionHash: 'hash-1',
      claimsSnapshot: [],
      expiresAt: new Date('2030-01-01T00:00:00Z'),
    });
    const newNow = new Date('2026-05-15T12:00:00Z').getTime();
    await sessions.touch(created.id, newNow);
    expect(created.lastSeenAt.getTime()).toBe(newNow);
  });

  it('updates the claims snapshot in place (with copy semantics)', async () => {
    const created = await sessions.create({
      userId: 'u-1',
      currentAccountId: null,
      sessionHash: 'hash-1',
      claimsSnapshot: ['account:read'],
      expiresAt: new Date('2030-01-01T00:00:00Z'),
    });
    const newClaims = ['account:read', 'session:create'] as const;
    await sessions.updateClaimsSnapshot(created.id, [...newClaims]);
    expect(created.claimsSnapshot).toEqual(newClaims);
  });
});
