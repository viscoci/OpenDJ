/**
 * AccountService — bootstrap idempotence + slug uniqueness + owner claims.
 */

import { describe, expect, it } from 'vitest';
import { AccountService } from '../../src/account/AccountService.js';
import {
  InMemoryAccountRepository,
  InMemoryMembershipRepository,
} from '../../src/repositories/in-memory/index.js';

function setup() {
  const accounts = new InMemoryAccountRepository();
  const memberships = new InMemoryMembershipRepository();
  const service = new AccountService({ accounts, memberships });
  return { service, accounts, memberships };
}

describe('AccountService.bootstrapPersonalAccount', () => {
  it('creates an account + owner membership for a brand-new user', async () => {
    const { service, accounts, memberships } = setup();
    const result = await service.bootstrapPersonalAccount({
      userId: 'u1',
      displayNameHint: 'Alice Anderson',
    });
    expect(result.created).toBe(true);
    expect(result.account.slug).toBe('alice-anderson');
    expect(result.account.plan).toBe('oss');
    expect(result.membership.role).toBe('owner');
    expect(result.membership.claims).toEqual(
      expect.arrayContaining(['session:create', 'queue:moderate', 'provider:connect']),
    );
    expect(accounts.rows.size).toBe(1);
    expect(memberships.rows.size).toBe(1);
  });

  it('is idempotent — second call returns the existing membership/account', async () => {
    const { service, accounts, memberships } = setup();
    const first = await service.bootstrapPersonalAccount({
      userId: 'u1',
      displayNameHint: 'Alice',
    });
    const second = await service.bootstrapPersonalAccount({
      userId: 'u1',
      displayNameHint: 'Different Name',
    });
    expect(second.created).toBe(false);
    expect(second.account.id).toBe(first.account.id);
    expect(accounts.rows.size).toBe(1);
    expect(memberships.rows.size).toBe(1);
  });

  it('disambiguates colliding slugs by appending -2, -3, ...', async () => {
    const { service } = setup();
    const a = await service.bootstrapPersonalAccount({
      userId: 'u1',
      displayNameHint: 'Same Name',
    });
    const b = await service.bootstrapPersonalAccount({
      userId: 'u2',
      displayNameHint: 'Same Name',
    });
    const c = await service.bootstrapPersonalAccount({
      userId: 'u3',
      displayNameHint: 'Same Name',
    });
    expect(a.account.slug).toBe('same-name');
    expect(b.account.slug).toBe('same-name-2');
    expect(c.account.slug).toBe('same-name-3');
  });

  it('sanitizes weird display name hints down to a usable slug', async () => {
    const { service } = setup();
    const result = await service.bootstrapPersonalAccount({
      userId: 'u1',
      displayNameHint: '   ___ ✨ Bob 9000 !! ___   ',
    });
    expect(result.account.slug).toBe('bob-9000');
  });

  it('falls back to "account" slug when the hint sanitizes to empty', async () => {
    const { service } = setup();
    const result = await service.bootstrapPersonalAccount({
      userId: 'u1',
      displayNameHint: '!!!!',
    });
    expect(result.account.slug).toBe('account');
  });

  it('membership-without-account is treated as a missing membership', async () => {
    const { service, memberships } = setup();
    // Seed a dangling membership pointing at no account.
    memberships.seed({
      accountId: 'ghost-account',
      userId: 'u1',
      status: 'active',
      role: 'owner',
      claims: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const result = await service.bootstrapPersonalAccount({
      userId: 'u1',
      displayNameHint: 'recovery',
    });
    expect(result.created).toBe(true);
    expect(result.account.id).not.toBe('ghost-account');
  });
});
