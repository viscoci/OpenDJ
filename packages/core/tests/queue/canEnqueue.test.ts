import { describe, expect, it } from 'vitest';
import { canEnqueue } from '../../src/queue/canEnqueue.js';
import { makeGuest, makeItem, makeSession } from '../helpers/fixtures.js';

describe('canEnqueue', () => {
  const now = new Date('2026-04-30T12:00:00Z');

  it('allows when session is live, guest matches, and under cap', () => {
    const session = makeSession({ songsPerGuestCap: 3 });
    const guest = makeGuest();
    const result = canEnqueue(session, guest, [], now);
    expect(result.ok).toBe(true);
  });

  it('rejects when session has ended (endedAt <= now)', () => {
    const session = makeSession({ endedAt: new Date('2026-04-30T11:00:00Z') });
    const guest = makeGuest();
    const result = canEnqueue(session, guest, [], now);
    expect(result).toEqual({ ok: false, reason: 'session_ended' });
  });

  it('allows when endedAt is in the future (session scheduled to end later)', () => {
    const session = makeSession({ endedAt: new Date('2026-04-30T13:00:00Z') });
    const guest = makeGuest();
    const result = canEnqueue(session, guest, [], now);
    expect(result.ok).toBe(true);
  });

  it('rejects when guest belongs to a different session', () => {
    const session = makeSession({ id: 'sess-1' });
    const guest = makeGuest({ sessionId: 'sess-other' });
    const result = canEnqueue(session, guest, [], now);
    expect(result).toEqual({ ok: false, reason: 'guest_session_mismatch' });
  });

  it('rejects when guest is at the per-guest cap', () => {
    const session = makeSession({ songsPerGuestCap: 2 });
    const guest = makeGuest({ id: 'guest-1' });
    const items = [
      makeItem({ id: 'a', guestId: 'guest-1', status: 'pending' }),
      makeItem({ id: 'b', guestId: 'guest-1', status: 'queued' }),
    ];
    const result = canEnqueue(session, guest, items, now);
    expect(result).toEqual({ ok: false, reason: 'cap_reached' });
  });

  it('does not count rejected items toward the cap', () => {
    const session = makeSession({ songsPerGuestCap: 2 });
    const guest = makeGuest({ id: 'guest-1' });
    const items = [
      makeItem({ id: 'a', guestId: 'guest-1', status: 'rejected' }),
      makeItem({ id: 'b', guestId: 'guest-1', status: 'rejected' }),
    ];
    const result = canEnqueue(session, guest, items, now);
    expect(result.ok).toBe(true);
  });

  it('checks ended-state BEFORE cap so a closed session always rejects', () => {
    const session = makeSession({
      endedAt: new Date('2026-04-30T11:00:00Z'),
      songsPerGuestCap: 99,
    });
    const guest = makeGuest();
    const result = canEnqueue(session, guest, [], now);
    expect(result).toEqual({ ok: false, reason: 'session_ended' });
  });
});
