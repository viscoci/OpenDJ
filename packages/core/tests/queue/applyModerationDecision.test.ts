import { describe, expect, it } from 'vitest';
import { applyModerationDecision } from '../../src/queue/applyModerationDecision.js';
import { makeItem } from '../helpers/fixtures.js';

describe('applyModerationDecision', () => {
  const now = new Date('2026-04-30T12:00:00Z');

  it('approves a pending item, sets decidedAt', () => {
    const item = makeItem({ status: 'pending' });
    const decided = applyModerationDecision(item, 'approved', now);
    expect(decided.status).toBe('approved');
    expect(decided.decidedAt).toBe(now);
  });

  it('rejects a pending item, sets decidedAt', () => {
    const item = makeItem({ status: 'pending' });
    const decided = applyModerationDecision(item, 'rejected', now);
    expect(decided.status).toBe('rejected');
    expect(decided.decidedAt).toBe(now);
  });

  it('does not mutate the input item', () => {
    const item = makeItem({ status: 'pending', decidedAt: null });
    applyModerationDecision(item, 'approved', now);
    expect(item.status).toBe('pending');
    expect(item.decidedAt).toBeNull();
  });

  it('allows reversing a previous decision (rejected → approved)', () => {
    const earlier = new Date('2026-04-30T10:00:00Z');
    const item = makeItem({ status: 'rejected', decidedAt: earlier });
    const decided = applyModerationDecision(item, 'approved', now);
    expect(decided.status).toBe('approved');
    expect(decided.decidedAt).toBe(now);
  });

  it('preserves all other fields', () => {
    const item = makeItem({
      id: 'item-7',
      trackUri: 'spotify:track:abc',
      skipVotes: 4,
      status: 'pending',
    });
    const decided = applyModerationDecision(item, 'approved', now);
    expect(decided.id).toBe('item-7');
    expect(decided.trackUri).toBe('spotify:track:abc');
    expect(decided.skipVotes).toBe(4);
  });
});
