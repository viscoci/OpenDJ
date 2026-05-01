import { describe, expect, it } from 'vitest';
import {
  assertAnyClaim,
  assertClaim,
  hasAllClaims,
  hasAnyClaim,
  hasClaim,
  MissingClaimError,
  type AuthContext,
  type Claim,
} from '../src/claims.js';

function ctx(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: 'u-1',
    currentAccountId: 'acc-1',
    claims: ['account:read', 'session:create'],
    authKind: 'host',
    ...overrides,
  };
}

describe('hasClaim', () => {
  it('returns true when claim present', () => {
    expect(hasClaim(ctx(), 'session:create')).toBe(true);
  });

  it('returns false when claim absent', () => {
    expect(hasClaim(ctx(), 'billing:manage')).toBe(false);
  });

  it('returns false on empty claim list', () => {
    expect(hasClaim(ctx({ claims: [] }), 'session:create')).toBe(false);
  });
});

describe('hasAnyClaim', () => {
  it('returns true if any of the listed claims is held', () => {
    expect(hasAnyClaim(ctx(), ['billing:manage', 'session:create'])).toBe(true);
  });

  it('returns false when none held', () => {
    expect(hasAnyClaim(ctx(), ['billing:manage', 'admin:global'])).toBe(false);
  });

  it('returns false for empty list', () => {
    expect(hasAnyClaim(ctx(), [])).toBe(false);
  });
});

describe('hasAllClaims', () => {
  it('requires all', () => {
    expect(hasAllClaims(ctx(), ['account:read', 'session:create'])).toBe(true);
    expect(hasAllClaims(ctx(), ['account:read', 'billing:manage'])).toBe(false);
  });

  it('returns true for empty list (vacuous)', () => {
    expect(hasAllClaims(ctx(), [])).toBe(true);
  });
});

describe('assertClaim', () => {
  it('returns void when claim is held', () => {
    expect(() => assertClaim(ctx(), 'account:read')).not.toThrow();
  });

  it('throws MissingClaimError when claim absent', () => {
    expect(() => assertClaim(ctx(), 'billing:manage')).toThrow(MissingClaimError);
  });

  it('preserves the missing claim + context on the error', () => {
    const c = ctx();
    try {
      assertClaim(c, 'billing:manage');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(MissingClaimError);
      expect((err as MissingClaimError).claim).toBe<Claim>('billing:manage');
      expect((err as MissingClaimError).context).toBe(c);
    }
  });
});

describe('assertAnyClaim', () => {
  it('passes when at least one held', () => {
    expect(() => assertAnyClaim(ctx(), ['billing:manage', 'account:read'])).not.toThrow();
  });

  it('throws on miss', () => {
    expect(() => assertAnyClaim(ctx(), ['billing:manage', 'admin:global'])).toThrow(
      MissingClaimError,
    );
  });

  it('throws clearly on empty list', () => {
    expect(() => assertAnyClaim(ctx(), [])).toThrow(/empty claim list/);
  });
});
