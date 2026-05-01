import { describe, expect, it } from 'vitest';
import {
  canDisableBranding,
  canStartSession,
  canUseAnalytics,
  canUseCustomDomain,
  canUseZones,
} from '../../src/plan/featureGates.js';
import { isPaidOrOss, type Plan } from '../../src/types/account.js';
import { makeAccount } from '../helpers/fixtures.js';

const PLANS: ReadonlyArray<Plan> = ['free', 'paid_monthly', 'paid_event', 'oss'];

describe('isPaidOrOss', () => {
  it('is false only for free', () => {
    expect(isPaidOrOss('free')).toBe(false);
    expect(isPaidOrOss('paid_monthly')).toBe(true);
    expect(isPaidOrOss('paid_event')).toBe(true);
    expect(isPaidOrOss('oss')).toBe(true);
  });
});

describe('canStartSession', () => {
  it('is true on every current plan', () => {
    for (const plan of PLANS) {
      expect(canStartSession(makeAccount({ plan }))).toBe(true);
    }
  });
});

describe('paid/OSS-only feature gates', () => {
  const gates = [
    { name: 'canUseCustomDomain', fn: canUseCustomDomain },
    { name: 'canDisableBranding', fn: canDisableBranding },
    { name: 'canUseZones', fn: canUseZones },
    { name: 'canUseAnalytics', fn: canUseAnalytics },
  ] as const;

  for (const { name, fn } of gates) {
    describe(name, () => {
      it('is false for free', () => {
        expect(fn(makeAccount({ plan: 'free' }))).toBe(false);
      });

      for (const plan of ['paid_monthly', 'paid_event', 'oss'] as const) {
        it(`is true for ${plan}`, () => {
          expect(fn(makeAccount({ plan }))).toBe(true);
        });
      }
    });
  }
});
