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

  describe('maxConsecutivePerGuest', () => {
    it("N=1: rejects when the tail item of the waiting list is the guest's own", () => {
      const session = makeSession({ songsPerGuestCap: 99, maxConsecutivePerGuest: 1 });
      const guest = makeGuest({ id: 'guest-1' });
      const items = [
        makeItem({
          id: 'a',
          guestId: 'guest-1',
          status: 'pending',
          createdAt: new Date('2026-04-30T10:00:00Z'),
        }),
      ];
      const result = canEnqueue(session, guest, items, now);
      expect(result).toEqual({ ok: false, reason: 'consecutive_cap_reached' });
    });

    it('N=1: allows when the tail item of the waiting list belongs to another guest', () => {
      const session = makeSession({ songsPerGuestCap: 99, maxConsecutivePerGuest: 1 });
      const guest = makeGuest({ id: 'guest-1' });
      const items = [
        makeItem({
          id: 'a',
          guestId: 'guest-2',
          status: 'pending',
          createdAt: new Date('2026-04-30T10:00:00Z'),
        }),
      ];
      const result = canEnqueue(session, guest, items, now);
      expect(result.ok).toBe(true);
    });

    it('N=2: rejects when the last two waiting items both belong to the guest', () => {
      const session = makeSession({ songsPerGuestCap: 99, maxConsecutivePerGuest: 2 });
      const guest = makeGuest({ id: 'guest-1' });
      const items = [
        makeItem({
          id: 'a',
          guestId: 'guest-2',
          status: 'pending',
          createdAt: new Date('2026-04-30T09:00:00Z'),
        }),
        makeItem({
          id: 'b',
          guestId: 'guest-1',
          status: 'approved',
          createdAt: new Date('2026-04-30T10:00:00Z'),
        }),
        makeItem({
          id: 'c',
          guestId: 'guest-1',
          status: 'queued',
          createdAt: new Date('2026-04-30T11:00:00Z'),
        }),
      ];
      const result = canEnqueue(session, guest, items, now);
      expect(result).toEqual({ ok: false, reason: 'consecutive_cap_reached' });
    });

    it('N=2: allows when the last two waiting items are mixed between guests', () => {
      const session = makeSession({ songsPerGuestCap: 99, maxConsecutivePerGuest: 2 });
      const guest = makeGuest({ id: 'guest-1' });
      const items = [
        makeItem({
          id: 'a',
          guestId: 'guest-1',
          status: 'pending',
          createdAt: new Date('2026-04-30T09:00:00Z'),
        }),
        makeItem({
          id: 'b',
          guestId: 'guest-1',
          status: 'approved',
          createdAt: new Date('2026-04-30T10:00:00Z'),
        }),
        makeItem({
          id: 'c',
          guestId: 'guest-2',
          status: 'queued',
          createdAt: new Date('2026-04-30T11:00:00Z'),
        }),
      ];
      const result = canEnqueue(session, guest, items, now);
      expect(result.ok).toBe(true);
    });

    it('null: never rejects for consecutive_cap_reached regardless of tail composition', () => {
      const session = makeSession({ songsPerGuestCap: 99, maxConsecutivePerGuest: null });
      const guest = makeGuest({ id: 'guest-1' });
      const items = [
        makeItem({
          id: 'a',
          guestId: 'guest-1',
          status: 'pending',
          createdAt: new Date('2026-04-30T09:00:00Z'),
        }),
        makeItem({
          id: 'b',
          guestId: 'guest-1',
          status: 'approved',
          createdAt: new Date('2026-04-30T10:00:00Z'),
        }),
        makeItem({
          id: 'c',
          guestId: 'guest-1',
          status: 'queued',
          createdAt: new Date('2026-04-30T11:00:00Z'),
        }),
      ];
      const result = canEnqueue(session, guest, items, now);
      expect(result.ok).toBe(true);
    });

    it('played/rejected items in between do not count as part of the waiting tail', () => {
      const session = makeSession({ songsPerGuestCap: 99, maxConsecutivePerGuest: 1 });
      const guest = makeGuest({ id: 'guest-1' });
      const items = [
        makeItem({
          id: 'a',
          guestId: 'guest-1',
          status: 'pending',
          createdAt: new Date('2026-04-30T09:00:00Z'),
        }),
        makeItem({
          id: 'b',
          guestId: 'guest-1',
          status: 'played',
          createdAt: new Date('2026-04-30T10:00:00Z'),
        }),
        makeItem({
          id: 'c',
          guestId: 'guest-2',
          status: 'rejected',
          createdAt: new Date('2026-04-30T10:30:00Z'),
        }),
        makeItem({
          id: 'd',
          guestId: 'guest-2',
          status: 'queued',
          createdAt: new Date('2026-04-30T11:00:00Z'),
        }),
      ];
      // Waiting tail (pending/approved/queued only) is just [d] (guest-2) —
      // the played/rejected items must not shield or count toward guest-1's
      // consecutive run, nor otherwise affect the tail check.
      const result = canEnqueue(session, guest, items, now);
      expect(result.ok).toBe(true);
    });
  });
});
