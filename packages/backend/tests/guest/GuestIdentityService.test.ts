import { beforeEach, describe, expect, it } from 'vitest';
import {
  GuestIdentityService,
  SessionEndedError,
  SessionNotFoundError,
} from '../../src/guest/GuestIdentityService.js';
import {
  InMemoryAccountRepository,
  InMemoryFingerprintPriorityRepository,
  InMemoryGuestRepository,
  InMemoryGuestSlotRepository,
  InMemorySessionRepository,
} from '../../src/repositories/in-memory/index.js';

const SESSION_ID = '11111111-1111-1111-1111-111111111111';
const ACCOUNT_ID = '22222222-2222-2222-2222-222222222222';
const NOW = new Date('2026-04-30T12:00:00Z').getTime();

function setup(opts: { plan?: 'free' | 'oss' | 'paid_monthly'; cap?: number | null } = {}) {
  const clock = { now: () => new Date(NOW) };
  const sessions = new InMemorySessionRepository();
  const accounts = new InMemoryAccountRepository();
  const guests = new InMemoryGuestRepository(clock);
  const guestSlots = new InMemoryGuestSlotRepository(clock);
  const fingerprintPriority = new InMemoryFingerprintPriorityRepository(clock);

  accounts.seed({
    id: ACCOUNT_ID,
    displayName: 'A',
    slug: 'a',
    plan: opts.plan ?? 'free',
    createdAt: new Date(NOW),
  });
  sessions.seed({
    id: SESSION_ID,
    accountId: ACCOUNT_ID,
    name: 'Test',
    qrSlug: 'test-event',
    guestCapOverride: opts.cap ?? null,
    songsPerGuestCap: 3,
    maxConsecutivePerGuest: null,
    moderationEnabled: false,
    voteSkipMode: 'fixed',
    voteSkipThreshold: 5,
    karaokeMode: 'off',
    karaokeMicCount: 1,
    karaokePauseMode: 'manual',
    karaokePauseTimeoutSec: 30,
    startedAt: new Date(NOW),
    endedAt: null,
  });

  const service = new GuestIdentityService({
    sessions,
    accounts,
    guests,
    guestSlots,
    fingerprintPriority,
  });

  return { service, sessions, accounts, guests, guestSlots, fingerprintPriority };
}

describe('GuestIdentityService.computeStoredHash', () => {
  it('produces a 64-char hex SHA-256', async () => {
    const { service } = setup();
    const h = await service.computeStoredHash('event-1', 'fp-1', new Date(NOW));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('different fingerprints + same event/day yield different hashes', async () => {
    const { service } = setup();
    const a = await service.computeStoredHash('event-1', 'fp-1', new Date(NOW));
    const b = await service.computeStoredHash('event-1', 'fp-2', new Date(NOW));
    expect(a).not.toBe(b);
  });

  it('different events + same fingerprint yield different hashes', async () => {
    const { service } = setup();
    const a = await service.computeStoredHash('event-1', 'fp-1', new Date(NOW));
    const b = await service.computeStoredHash('event-2', 'fp-1', new Date(NOW));
    expect(a).not.toBe(b);
  });

  it('different days yield different hashes', async () => {
    const { service } = setup();
    const a = await service.computeStoredHash('event-1', 'fp-1', new Date('2026-04-30T12:00:00Z'));
    const b = await service.computeStoredHash('event-1', 'fp-1', new Date('2026-05-01T12:00:00Z'));
    expect(a).not.toBe(b);
  });
});

describe('GuestIdentityService.issueIdentity', () => {
  it('throws SessionNotFoundError for an unknown event slug', async () => {
    const { service } = setup();
    await expect(
      service.issueIdentity({ eventSlug: 'nope', fingerprintHash: 'fp' }, NOW),
    ).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it('throws SessionEndedError when the session already ended', async () => {
    const { service, sessions } = setup();
    const row = await sessions.findByQrSlug('test-event');
    if (row) (row as { endedAt: Date | null }).endedAt = new Date(NOW - 1);
    await expect(
      service.issueIdentity({ eventSlug: 'test-event', fingerprintHash: 'fp' }, NOW),
    ).rejects.toBeInstanceOf(SessionEndedError);
  });

  it('issues an active slot under cap', async () => {
    const { service, guestSlots } = setup({ plan: 'oss' });
    const result = await service.issueIdentity(
      { eventSlug: 'test-event', fingerprintHash: 'fp-1' },
      NOW,
    );
    expect(result.status).toBe('active');
    expect(result.slotToken).toMatch(/^[0-9a-f]{64}$/);
    expect(await guestSlots.countByStatus(SESSION_ID, 'active')).toBe(1);
  });

  it('refreshes heartbeat + returns existing slot on repeat call (same fingerprint same day)', async () => {
    const { service, guestSlots } = setup({ plan: 'oss' });
    const first = await service.issueIdentity(
      { eventSlug: 'test-event', fingerprintHash: 'fp-1' },
      NOW,
    );
    const second = await service.issueIdentity(
      { eventSlug: 'test-event', fingerprintHash: 'fp-1' },
      NOW + 1000,
    );
    expect(second.slotToken).toBe(first.slotToken);
    expect(await guestSlots.countByStatus(SESSION_ID, 'active')).toBe(1);
    const stored = await guestSlots.findBySlotToken(first.slotToken);
    expect(stored?.lastHeartbeat.getTime()).toBe(NOW + 1000);
  });

  it('queues new fingerprints once cap is reached', async () => {
    const { service } = setup({ plan: 'free', cap: 1 });
    const a = await service.issueIdentity(
      { eventSlug: 'test-event', fingerprintHash: 'fp-1' },
      NOW,
    );
    const b = await service.issueIdentity(
      { eventSlug: 'test-event', fingerprintHash: 'fp-2' },
      NOW + 1,
    );
    expect(a.status).toBe('active');
    expect(b.status).toBe('queued');
    expect(b.queuePosition).toBe(1);
  });

  it('immediately promotes priority re-entry when room exists', async () => {
    const { service, fingerprintPriority } = setup({ plan: 'oss' });
    const stored = await service.computeStoredHash('test-event', 'fp-rejoin', new Date(NOW));
    await fingerprintPriority.upsert({
      sessionId: SESSION_ID,
      fingerprintHash: stored,
      expiresAt: new Date(NOW + 60_000),
    });
    const result = await service.issueIdentity(
      { eventSlug: 'test-event', fingerprintHash: 'fp-rejoin' },
      NOW,
    );
    expect(result.status).toBe('active');
    // priority record consumed
    const remaining = await fingerprintPriority.find(SESSION_ID, stored, NOW);
    expect(remaining).toBeNull();
  });

  it('puts priority re-entry into priority_queued when cap is full', async () => {
    const { service, fingerprintPriority } = setup({ plan: 'free', cap: 1 });
    // Fill the cap
    await service.issueIdentity({ eventSlug: 'test-event', fingerprintHash: 'fp-1' }, NOW);

    const stored = await service.computeStoredHash('test-event', 'fp-rejoin', new Date(NOW));
    await fingerprintPriority.upsert({
      sessionId: SESSION_ID,
      fingerprintHash: stored,
      expiresAt: new Date(NOW + 60_000),
    });
    const result = await service.issueIdentity(
      { eventSlug: 'test-event', fingerprintHash: 'fp-rejoin' },
      NOW + 1,
    );
    expect(result.status).toBe('priority_queued');
  });

  it('creates the corresponding guests row exactly once across repeat calls', async () => {
    const { service, guests } = setup({ plan: 'oss' });
    await service.issueIdentity({ eventSlug: 'test-event', fingerprintHash: 'fp-1' }, NOW);
    await service.issueIdentity({ eventSlug: 'test-event', fingerprintHash: 'fp-1' }, NOW + 1000);
    expect(guests.rows.size).toBe(1);
  });
});

describe('GuestIdentityService.heartbeat', () => {
  it('updates lastHeartbeat for a known slot', async () => {
    const { service, guestSlots } = setup({ plan: 'oss' });
    const issued = await service.issueIdentity(
      { eventSlug: 'test-event', fingerprintHash: 'fp-1' },
      NOW,
    );
    await service.heartbeat(issued.slotToken, NOW + 60_000);
    const stored = await guestSlots.findBySlotToken(issued.slotToken);
    expect(stored?.lastHeartbeat.getTime()).toBe(NOW + 60_000);
  });

  it('throws on unknown token', async () => {
    const { service } = setup();
    await expect(service.heartbeat('does-not-exist')).rejects.toThrow(/Unknown slot token/);
  });
});

describe('GuestIdentityService.getSlot', () => {
  it('returns the slot row for a known token', async () => {
    const { service } = setup({ plan: 'oss' });
    const issued = await service.issueIdentity(
      { eventSlug: 'test-event', fingerprintHash: 'fp-1' },
      NOW,
    );
    const found = await service.getSlot(issued.slotToken);
    expect(found?.slotToken).toBe(issued.slotToken);
  });

  it('returns null for an unknown token', async () => {
    const { service } = setup();
    expect(await service.getSlot('does-not-exist')).toBeNull();
  });
});
