import { describe, expect, it } from 'vitest';
import { canRemoveClaim } from '../../src/queue/canRemoveClaim.js';
import { makeClaim, makeItem } from '../helpers/fixtures.js';

describe('canRemoveClaim', () => {
  it.each(['pending', 'approved', 'queued'] as const)(
    'allows removing your own claim while the item is %s (still waiting)',
    (status) => {
      const item = makeItem({ status });
      const claim = makeClaim({ guestId: 'guest-1' });
      expect(canRemoveClaim(item, claim, 'guest-1')).toEqual({ ok: true });
    },
  );

  it("rejects removing another guest's claim", () => {
    const item = makeItem({ status: 'queued' });
    const claim = makeClaim({ guestId: 'guest-2' });
    expect(canRemoveClaim(item, claim, 'guest-1')).toEqual({
      ok: false,
      reason: 'not_claim_owner',
    });
  });

  it.each(['playing', 'played', 'rejected'] as const)(
    'rejects removing your own claim once the item is %s (no longer waiting)',
    (status) => {
      const item = makeItem({ status });
      const claim = makeClaim({ guestId: 'guest-1' });
      expect(canRemoveClaim(item, claim, 'guest-1')).toEqual({
        ok: false,
        reason: 'item_not_waiting',
      });
    },
  );

  it('ownership is checked before the waiting-status rule', () => {
    const item = makeItem({ status: 'playing' });
    const claim = makeClaim({ guestId: 'guest-2' });
    expect(canRemoveClaim(item, claim, 'guest-1')).toEqual({
      ok: false,
      reason: 'not_claim_owner',
    });
  });
});
