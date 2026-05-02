import { describe, expect, it } from 'vitest';
import {
  AbuseModerationService,
  AbuseModerationServiceError,
} from '../../src/abuse/AbuseModerationService.js';
import {
  InMemoryAbuseSubjectRepository,
  InMemoryActionEventRepository,
} from '../../src/repositories/in-memory/index.js';

const SESSION_ID = '11111111-1111-1111-1111-111111111111';
const ACCOUNT_ID = '22222222-2222-2222-2222-222222222222';
const HOST_USER_ID = '33333333-3333-3333-3333-333333333333';

function setup(nowEpochMs = Date.now()) {
  const clock = { now: () => new Date(nowEpochMs) };
  const abuseSubjects = new InMemoryAbuseSubjectRepository(clock);
  const actionEvents = new InMemoryActionEventRepository(clock);
  const service = new AbuseModerationService({ abuseSubjects, actionEvents });
  return { service, abuseSubjects, actionEvents };
}

describe('AbuseModerationService.blockGuest', () => {
  it('upserts the abuse_subjects row to status=blocked + records an abuse_blocked event', async () => {
    const { service, abuseSubjects, actionEvents } = setup();
    const subject = await service.blockGuest({
      sessionId: SESSION_ID,
      accountId: ACCOUNT_ID,
      subjectHash: 'sub-1',
      reason: 'spam',
      byUserId: HOST_USER_ID,
    });
    expect(subject.status).toBe('blocked');
    expect(subject.reason).toBe('spam');
    expect(abuseSubjects.rows.size).toBe(1);
    expect(actionEvents.rows).toHaveLength(1);
    expect(actionEvents.rows[0]?.eventKind).toBe('abuse_blocked');
    expect(actionEvents.rows[0]?.subjectHash).toBe('sub-1');
    expect(actionEvents.rows[0]?.userId).toBe(HOST_USER_ID);
  });

  it('respects expiresAt for time-bound blocks', async () => {
    const { service } = setup();
    const expiresAt = new Date(Date.now() + 60 * 60_000);
    const subject = await service.blockGuest({
      sessionId: SESSION_ID,
      accountId: ACCOUNT_ID,
      subjectHash: 'sub-1',
      byUserId: HOST_USER_ID,
      expiresAt,
    });
    expect(subject.expiresAt?.getTime()).toBe(expiresAt.getTime());
  });
});

describe('AbuseModerationService.unblockGuest', () => {
  it('deletes the abuse_subjects row + records an abuse_unblocked event', async () => {
    const { service, abuseSubjects, actionEvents } = setup();
    await service.blockGuest({
      sessionId: SESSION_ID,
      accountId: ACCOUNT_ID,
      subjectHash: 'sub-1',
      byUserId: HOST_USER_ID,
    });
    await service.unblockGuest({
      sessionId: SESSION_ID,
      accountId: ACCOUNT_ID,
      subjectHash: 'sub-1',
      byUserId: HOST_USER_ID,
    });
    expect(abuseSubjects.rows.size).toBe(0);
    expect(actionEvents.rows.map((r) => r.eventKind)).toEqual(['abuse_blocked', 'abuse_unblocked']);
  });

  it('throws session_mismatch when the subject belongs to a different session', async () => {
    const { service } = setup();
    await service.blockGuest({
      sessionId: SESSION_ID,
      accountId: ACCOUNT_ID,
      subjectHash: 'sub-1',
      byUserId: HOST_USER_ID,
    });
    await expect(
      service.unblockGuest({
        sessionId: 'other-session',
        accountId: ACCOUNT_ID,
        subjectHash: 'sub-1',
        byUserId: HOST_USER_ID,
      }),
    ).rejects.toBeInstanceOf(AbuseModerationServiceError);
  });

  it('is idempotent — unblocking a non-existent subject is a no-op', async () => {
    const { service, actionEvents } = setup();
    await service.unblockGuest({
      sessionId: SESSION_ID,
      accountId: ACCOUNT_ID,
      subjectHash: 'never-blocked',
      byUserId: HOST_USER_ID,
    });
    // Still records the unblock event so audit trails are consistent.
    expect(actionEvents.rows.map((r) => r.eventKind)).toEqual(['abuse_unblocked']);
  });
});

describe('AbuseModerationService.summary', () => {
  it('returns active subjects + recent event counts within the window', async () => {
    const NOW = new Date('2026-04-30T12:00:00Z').getTime();
    const { service, actionEvents } = setup(NOW);
    await service.blockGuest({
      sessionId: SESSION_ID,
      accountId: ACCOUNT_ID,
      subjectHash: 'sub-1',
      byUserId: HOST_USER_ID,
    });
    // Manually inject a few action events
    await actionEvents.create({
      sessionId: SESSION_ID,
      eventKind: 'song_requested',
    });
    await actionEvents.create({
      sessionId: SESSION_ID,
      eventKind: 'song_requested',
    });
    await actionEvents.create({
      sessionId: SESSION_ID,
      eventKind: 'rate_limited',
    });

    const summary = await service.summary({
      sessionId: SESSION_ID,
      windowMs: 60 * 60_000,
      nowEpochMs: NOW,
    });
    expect(summary.subjects).toHaveLength(1);
    expect(summary.subjects[0]?.subjectHash).toBe('sub-1');

    const counts = new Map(summary.recentEventCounts.map((r) => [r.eventKind, r.count]));
    expect(counts.get('song_requested')).toBe(2);
    expect(counts.get('rate_limited')).toBe(1);
    expect(counts.get('abuse_blocked')).toBe(1);
  });

  it('filters subjects by status when provided', async () => {
    const { service, abuseSubjects } = setup();
    await abuseSubjects.upsert({
      subjectHash: 'normal-1',
      sessionId: SESSION_ID,
      status: 'normal',
    });
    await service.blockGuest({
      sessionId: SESSION_ID,
      accountId: ACCOUNT_ID,
      subjectHash: 'blocked-1',
      byUserId: HOST_USER_ID,
    });
    const summary = await service.summary({
      sessionId: SESSION_ID,
      statuses: ['blocked'],
    });
    expect(summary.subjects.map((s) => s.subjectHash)).toEqual(['blocked-1']);
  });

  it('omits expired subjects', async () => {
    const NOW = Date.now();
    const { service, abuseSubjects } = setup(NOW);
    await abuseSubjects.upsert({
      subjectHash: 'expired',
      sessionId: SESSION_ID,
      status: 'blocked',
      expiresAt: new Date(NOW - 1),
    });
    const summary = await service.summary({ sessionId: SESSION_ID, nowEpochMs: NOW });
    expect(summary.subjects).toEqual([]);
  });
});
