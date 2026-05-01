import { describe, expect, it } from 'vitest';
import {
  appearsSuccessful,
  isDecisionOfAction,
  isPersisted,
  isUserVisibleRejection,
  mergeDecisions,
  strictestDecision,
  type AbuseDecision,
} from '../src/types/decision.js';

const allow: AbuseDecision = { action: 'allow' };
const shadow: AbuseDecision = { action: 'shadow_limit', reason: 'flagged for review' };
const throttle: AbuseDecision = {
  action: 'throttle',
  retryAfterMs: 5000,
  reason: 'too many requests',
};
const review: AbuseDecision = {
  action: 'require_host_review',
  reason: 'borderline content',
};
const block: AbuseDecision = { action: 'block', reason: 'banned subject' };

describe('isUserVisibleRejection', () => {
  it('is true for throttle / require_host_review / block', () => {
    expect(isUserVisibleRejection(throttle)).toBe(true);
    expect(isUserVisibleRejection(review)).toBe(true);
    expect(isUserVisibleRejection(block)).toBe(true);
  });

  it('is false for allow / shadow_limit', () => {
    expect(isUserVisibleRejection(allow)).toBe(false);
    expect(isUserVisibleRejection(shadow)).toBe(false);
  });
});

describe('isPersisted', () => {
  it('is true only for allow', () => {
    expect(isPersisted(allow)).toBe(true);
    for (const d of [shadow, throttle, review, block]) {
      expect(isPersisted(d)).toBe(false);
    }
  });
});

describe('appearsSuccessful', () => {
  it('is true for allow + shadow_limit', () => {
    expect(appearsSuccessful(allow)).toBe(true);
    expect(appearsSuccessful(shadow)).toBe(true);
  });

  it('is false for throttle / review / block', () => {
    for (const d of [throttle, review, block]) {
      expect(appearsSuccessful(d)).toBe(false);
    }
  });
});

describe('mergeDecisions', () => {
  it('block always wins', () => {
    expect(mergeDecisions(allow, block)).toBe(block);
    expect(mergeDecisions(block, allow)).toBe(block);
    expect(mergeDecisions(throttle, block)).toBe(block);
  });

  it('orders allow < shadow < throttle < review < block', () => {
    expect(mergeDecisions(allow, shadow)).toBe(shadow);
    expect(mergeDecisions(shadow, throttle)).toBe(throttle);
    expect(mergeDecisions(throttle, review)).toBe(review);
    expect(mergeDecisions(review, block)).toBe(block);
  });

  it('is symmetric in severity but biases left on ties', () => {
    const otherShadow: AbuseDecision = { action: 'shadow_limit', reason: 'other' };
    expect(mergeDecisions(shadow, otherShadow)).toBe(shadow);
  });
});

describe('strictestDecision', () => {
  it('returns allow for empty input', () => {
    expect(strictestDecision([])).toEqual({ action: 'allow' });
  });

  it('folds an array to its strictest member', () => {
    expect(strictestDecision([allow, throttle, shadow])).toBe(throttle);
    expect(strictestDecision([review, allow, block, throttle])).toBe(block);
  });
});

describe('isDecisionOfAction', () => {
  it('narrows by discriminant', () => {
    if (isDecisionOfAction(throttle, 'throttle')) {
      expect(throttle.retryAfterMs).toBe(5000);
    } else {
      expect.fail('narrowing failed');
    }
  });

  it('returns false on mismatch', () => {
    expect(isDecisionOfAction(allow, 'throttle')).toBe(false);
  });
});
