import { describe, expect, it } from 'vitest';
import { countActiveItemsForGuest } from '../../src/queue/countActiveItemsForGuest.js';
import { makeItem } from '../helpers/fixtures.js';

describe('countActiveItemsForGuest', () => {
  it('counts only items belonging to the guest', () => {
    const items = [
      makeItem({ id: 'a', guestId: 'guest-1', status: 'pending' }),
      makeItem({ id: 'b', guestId: 'guest-2', status: 'pending' }),
      makeItem({ id: 'c', guestId: 'guest-1', status: 'queued' }),
    ];
    expect(countActiveItemsForGuest(items, 'guest-1')).toBe(2);
  });

  it('counts each active status (pending/approved/queued/playing)', () => {
    const items = [
      makeItem({ id: 'a', guestId: 'g', status: 'pending' }),
      makeItem({ id: 'b', guestId: 'g', status: 'approved' }),
      makeItem({ id: 'c', guestId: 'g', status: 'queued' }),
      makeItem({ id: 'd', guestId: 'g', status: 'playing' }),
    ];
    expect(countActiveItemsForGuest(items, 'g')).toBe(4);
  });

  it('does NOT count rejected items', () => {
    const items = [
      makeItem({ id: 'a', guestId: 'g', status: 'pending' }),
      makeItem({ id: 'b', guestId: 'g', status: 'rejected' }),
    ];
    expect(countActiveItemsForGuest(items, 'g')).toBe(1);
  });

  it('returns 0 for unknown guest', () => {
    const items = [makeItem({ id: 'a', guestId: 'guest-1' })];
    expect(countActiveItemsForGuest(items, 'guest-99')).toBe(0);
  });

  it('returns 0 on empty list', () => {
    expect(countActiveItemsForGuest([], 'g')).toBe(0);
  });
});
