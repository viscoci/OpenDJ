import { describe, expect, it } from 'vitest';
import { canSkip } from '../../src/queue/canSkip.js';
import { makeSession } from '../helpers/fixtures.js';

describe('canSkip — fixed mode', () => {
  const session = makeSession({ voteSkipMode: 'fixed', voteSkipThreshold: 5 });

  it('is true when skipVotes >= threshold', () => {
    expect(canSkip(session, 5, 100)).toBe(true);
    expect(canSkip(session, 7, 100)).toBe(true);
  });

  it('is false when below threshold', () => {
    expect(canSkip(session, 4, 100)).toBe(false);
  });

  it('totalActiveGuests is irrelevant in fixed mode', () => {
    expect(canSkip(session, 5, 0)).toBe(true);
    expect(canSkip(session, 5, 1)).toBe(true);
  });
});

describe('canSkip — percentage mode', () => {
  const session = makeSession({ voteSkipMode: 'percentage', voteSkipThreshold: 50 });

  it('is true when % at or above threshold', () => {
    expect(canSkip(session, 5, 10)).toBe(true); // 50%
    expect(canSkip(session, 6, 10)).toBe(true); // 60%
  });

  it('is false when % below threshold', () => {
    expect(canSkip(session, 4, 10)).toBe(false); // 40%
  });

  it('returns false when no active guests (avoid divide-by-zero)', () => {
    expect(canSkip(session, 1, 0)).toBe(false);
  });

  it('returns false when totalActiveGuests is negative', () => {
    expect(canSkip(session, 1, -1)).toBe(false);
  });
});

describe('canSkip — host_approval mode', () => {
  const session = makeSession({ voteSkipMode: 'host_approval', voteSkipThreshold: 5 });

  it('is always false regardless of votes', () => {
    expect(canSkip(session, 0, 10)).toBe(false);
    expect(canSkip(session, 100, 10)).toBe(false);
  });
});

describe('canSkip — universal rules', () => {
  it('is false when skipVotes <= 0 in any mode', () => {
    for (const mode of ['fixed', 'percentage', 'host_approval'] as const) {
      const session = makeSession({ voteSkipMode: mode });
      expect(canSkip(session, 0, 10)).toBe(false);
      expect(canSkip(session, -1, 10)).toBe(false);
    }
  });
});
