import { describe, expect, it } from 'vitest';
import { ACTIVE_QUEUE_STATUSES, isActiveQueueItem } from '../../src/types/queue.js';
import { makeItem } from '../helpers/fixtures.js';

describe('ACTIVE_QUEUE_STATUSES', () => {
  it('lists pending/approved/queued/playing as active', () => {
    expect([...ACTIVE_QUEUE_STATUSES]).toEqual(['pending', 'approved', 'queued', 'playing']);
  });
});

describe('isActiveQueueItem', () => {
  for (const status of ['pending', 'approved', 'queued', 'playing'] as const) {
    it(`is true for status="${status}"`, () => {
      expect(isActiveQueueItem(makeItem({ status }))).toBe(true);
    });
  }

  it('is false for status="rejected"', () => {
    expect(isActiveQueueItem(makeItem({ status: 'rejected' }))).toBe(false);
  });
});
