import { describe, expect, it } from 'vitest';
import { enforcePerGuestCap } from '../../src/queue/enforcePerGuestCap.js';
import { makeItem } from '../helpers/fixtures.js';

describe('enforcePerGuestCap', () => {
  it('blocks when guest is at the cap', () => {
    const items = [
      makeItem({ id: 'a', guestId: 'g', status: 'pending' }),
      makeItem({ id: 'b', guestId: 'g', status: 'approved' }),
      makeItem({ id: 'c', guestId: 'g', status: 'queued' }),
    ];
    expect(enforcePerGuestCap(items, 'g', 3)).toBe(true);
  });

  it('blocks when guest is over the cap', () => {
    const items = [
      makeItem({ id: 'a', guestId: 'g', status: 'pending' }),
      makeItem({ id: 'b', guestId: 'g', status: 'approved' }),
      makeItem({ id: 'c', guestId: 'g', status: 'queued' }),
      makeItem({ id: 'd', guestId: 'g', status: 'playing' }),
    ];
    expect(enforcePerGuestCap(items, 'g', 3)).toBe(true);
  });

  it('allows when guest is under the cap', () => {
    const items = [makeItem({ id: 'a', guestId: 'g', status: 'pending' })];
    expect(enforcePerGuestCap(items, 'g', 3)).toBe(false);
  });

  it('does not count rejected items toward the cap', () => {
    const items = [
      makeItem({ id: 'a', guestId: 'g', status: 'rejected' }),
      makeItem({ id: 'b', guestId: 'g', status: 'rejected' }),
      makeItem({ id: 'c', guestId: 'g', status: 'pending' }),
    ];
    expect(enforcePerGuestCap(items, 'g', 3)).toBe(false);
  });

  it('treats cap of 0 as "always blocked"', () => {
    expect(enforcePerGuestCap([], 'g', 0)).toBe(true);
  });

  it('treats negative cap as blocked', () => {
    expect(enforcePerGuestCap([], 'g', -1)).toBe(true);
  });
});
