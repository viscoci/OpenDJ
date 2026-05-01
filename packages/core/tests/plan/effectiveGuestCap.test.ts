import { describe, expect, it } from 'vitest';
import { effectiveGuestCap } from '../../src/plan/effectiveGuestCap.js';
import { HOSTED_FREE_TIER_GUEST_CAP } from '../../src/constants.js';
import { makeAccount, makeSession } from '../helpers/fixtures.js';

describe('effectiveGuestCap', () => {
  it('caps free-tier hosted accounts at HOSTED_FREE_TIER_GUEST_CAP', () => {
    const account = makeAccount({ plan: 'free' });
    const session = makeSession({ guestCapOverride: null });
    expect(effectiveGuestCap(account, session)).toBe(HOSTED_FREE_TIER_GUEST_CAP);
  });

  it('returns Infinity for OSS accounts', () => {
    const account = makeAccount({ plan: 'oss' });
    const session = makeSession({ guestCapOverride: null });
    expect(effectiveGuestCap(account, session)).toBe(Number.POSITIVE_INFINITY);
  });

  it('returns Infinity for paid_monthly accounts', () => {
    const account = makeAccount({ plan: 'paid_monthly' });
    const session = makeSession({ guestCapOverride: null });
    expect(effectiveGuestCap(account, session)).toBe(Number.POSITIVE_INFINITY);
  });

  it('returns Infinity for paid_event accounts', () => {
    const account = makeAccount({ plan: 'paid_event' });
    const session = makeSession({ guestCapOverride: null });
    expect(effectiveGuestCap(account, session)).toBe(Number.POSITIVE_INFINITY);
  });

  it('respects session.guestCapOverride when set, even on free plans', () => {
    const account = makeAccount({ plan: 'free' });
    const session = makeSession({ guestCapOverride: 5 });
    expect(effectiveGuestCap(account, session)).toBe(5);
  });

  it('respects guestCapOverride even on OSS', () => {
    const account = makeAccount({ plan: 'oss' });
    const session = makeSession({ guestCapOverride: 50 });
    expect(effectiveGuestCap(account, session)).toBe(50);
  });

  it('paid host can voluntarily cap a busy event below plan default', () => {
    const account = makeAccount({ plan: 'paid_monthly' });
    const session = makeSession({ guestCapOverride: 200 });
    expect(effectiveGuestCap(account, session)).toBe(200);
  });
});
