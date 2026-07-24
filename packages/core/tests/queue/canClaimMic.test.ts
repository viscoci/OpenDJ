import { describe, expect, it } from 'vitest';
import { canClaimMic } from '../../src/queue/canClaimMic.js';
import { makeClaim, makeItem, makeSession } from '../helpers/fixtures.js';

describe('canClaimMic', () => {
  describe('karaoke_off', () => {
    it("rejects when karaokeMode is 'off' even when everything else would pass", () => {
      const session = makeSession({ karaokeMode: 'off' });
      const item = makeItem({ status: 'queued' });
      const result = canClaimMic(session, item, [], 'guest-1');
      expect(result).toEqual({ ok: false, reason: 'karaoke_off' });
    });

    it('karaoke_off wins over any other reject reason (checked first)', () => {
      const session = makeSession({ karaokeMode: 'off', karaokeMicCount: 1 });
      const item = makeItem({ status: 'rejected' });
      const claims = [makeClaim({ guestId: 'guest-1' })];
      const result = canClaimMic(session, item, claims, 'guest-1');
      expect(result).toEqual({ ok: false, reason: 'karaoke_off' });
    });
  });

  describe('item_not_claimable', () => {
    it.each(['played', 'rejected'] as const)('rejects when item status is %s', (status) => {
      const session = makeSession({ karaokeMode: 'optional' });
      const item = makeItem({ status });
      const result = canClaimMic(session, item, [], 'guest-1');
      expect(result).toEqual({ ok: false, reason: 'item_not_claimable' });
    });

    it.each(['pending', 'approved', 'queued', 'playing'] as const)(
      'allows claiming an item with status %s',
      (status) => {
        const session = makeSession({ karaokeMode: 'optional' });
        const item = makeItem({ status });
        const result = canClaimMic(session, item, [], 'guest-1');
        expect(result.ok).toBe(true);
      },
    );
  });

  describe('mics_full', () => {
    it('rejects when claims on the item reach exactly karaokeMicCount', () => {
      const session = makeSession({ karaokeMode: 'optional', karaokeMicCount: 2 });
      const item = makeItem({ status: 'queued' });
      const claims = [
        makeClaim({ id: 'c1', guestId: 'guest-2' }),
        makeClaim({ id: 'c2', guestId: 'guest-3' }),
      ];
      const result = canClaimMic(session, item, claims, 'guest-1');
      expect(result).toEqual({ ok: false, reason: 'mics_full' });
    });

    it('allows when claims are below karaokeMicCount', () => {
      const session = makeSession({ karaokeMode: 'optional', karaokeMicCount: 2 });
      const item = makeItem({ status: 'queued' });
      const claims = [makeClaim({ id: 'c1', guestId: 'guest-2' })];
      const result = canClaimMic(session, item, claims, 'guest-1');
      expect(result.ok).toBe(true);
    });

    it('only counts claims on THIS item toward the mic count', () => {
      const session = makeSession({ karaokeMode: 'optional', karaokeMicCount: 1 });
      const item = makeItem({ id: 'item-1', status: 'queued' });
      const claims = [makeClaim({ id: 'c1', queueItemId: 'item-other', guestId: 'guest-2' })];
      const result = canClaimMic(session, item, claims, 'guest-1');
      expect(result.ok).toBe(true);
    });
  });

  describe('already_claimed', () => {
    it('rejects when the guest already holds a claim on this item', () => {
      const session = makeSession({ karaokeMode: 'optional', karaokeMicCount: 2 });
      const item = makeItem({ status: 'queued' });
      const claims = [makeClaim({ guestId: 'guest-1' })];
      const result = canClaimMic(session, item, claims, 'guest-1');
      expect(result).toEqual({ ok: false, reason: 'already_claimed' });
    });

    it('reports already_claimed (not mics_full) when the sole claimant re-claims a full song', () => {
      const session = makeSession({ karaokeMode: 'optional', karaokeMicCount: 1 });
      const item = makeItem({ status: 'queued' });
      const claims = [makeClaim({ guestId: 'guest-1' })];
      const result = canClaimMic(session, item, claims, 'guest-1');
      expect(result).toEqual({ ok: false, reason: 'already_claimed' });
    });

    it('a claim by the same guest on ANOTHER item does not block this one', () => {
      const session = makeSession({ karaokeMode: 'optional', karaokeMicCount: 1 });
      const item = makeItem({ id: 'item-1', status: 'queued' });
      const claims = [makeClaim({ queueItemId: 'item-other', guestId: 'guest-1' })];
      const result = canClaimMic(session, item, claims, 'guest-1');
      expect(result.ok).toBe(true);
    });
  });

  describe('happy path', () => {
    it("allows in 'optional' mode with no existing claims", () => {
      const session = makeSession({ karaokeMode: 'optional' });
      const item = makeItem({ status: 'approved' });
      expect(canClaimMic(session, item, [], 'guest-1')).toEqual({ ok: true });
    });

    it("allows in 'required' mode too", () => {
      const session = makeSession({ karaokeMode: 'required' });
      const item = makeItem({ status: 'pending' });
      expect(canClaimMic(session, item, [], 'guest-1')).toEqual({ ok: true });
    });

    it('allows a NON-requester guest to claim (duets are open to any guest)', () => {
      const session = makeSession({ karaokeMode: 'optional', karaokeMicCount: 2 });
      const item = makeItem({ guestId: 'guest-1', status: 'queued' });
      const claims = [makeClaim({ guestId: 'guest-1' })];
      const result = canClaimMic(session, item, claims, 'guest-2');
      expect(result).toEqual({ ok: true });
    });
  });
});
