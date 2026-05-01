import { beforeEach, describe, expect, it } from 'vitest';
import {
  AccountNotFoundError,
  ClaimsService,
  NotAccountMemberError,
} from '../../src/auth/ClaimsService.js';
import {
  InMemoryAccountRepository,
  InMemoryMembershipRepository,
} from '../../src/repositories/in-memory/index.js';
import type { AccountRecord, MembershipRecord } from '../../src/repositories/types.js';

const account: AccountRecord = {
  id: 'acc-1',
  displayName: 'Test Account',
  slug: 'test',
  plan: 'free',
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

function activeMembership(overrides: Partial<MembershipRecord> = {}): MembershipRecord {
  return {
    accountId: 'acc-1',
    userId: 'user-1',
    status: 'active',
    role: 'host',
    claims: ['account:read', 'session:create'],
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('ClaimsService', () => {
  let memberships: InMemoryMembershipRepository;
  let accounts: InMemoryAccountRepository;
  let service: ClaimsService;

  beforeEach(() => {
    memberships = new InMemoryMembershipRepository();
    accounts = new InMemoryAccountRepository();
    accounts.seed(account);
    service = new ClaimsService({ memberships, accounts });
  });

  describe('refreshClaims', () => {
    it('returns the membership claim list', async () => {
      memberships.seed(activeMembership());
      const claims = await service.refreshClaims('user-1', 'acc-1');
      expect(claims).toEqual(['account:read', 'session:create']);
    });

    it('returns a copy (not the live array)', async () => {
      memberships.seed(activeMembership());
      const claims = await service.refreshClaims('user-1', 'acc-1');
      claims.push('admin:global');
      const fresh = await service.refreshClaims('user-1', 'acc-1');
      expect(fresh).toEqual(['account:read', 'session:create']);
    });

    it('returns empty list when user is not a member', async () => {
      expect(await service.refreshClaims('user-1', 'acc-1')).toEqual([]);
    });

    it('returns empty list for invited (not yet active) memberships', async () => {
      memberships.seed(activeMembership({ status: 'invited' }));
      expect(await service.refreshClaims('user-1', 'acc-1')).toEqual([]);
    });

    it('returns empty list for disabled memberships', async () => {
      memberships.seed(activeMembership({ status: 'disabled' }));
      expect(await service.refreshClaims('user-1', 'acc-1')).toEqual([]);
    });
  });

  describe('assertMembership', () => {
    it('returns the membership when active', async () => {
      memberships.seed(activeMembership());
      const m = await service.assertMembership('user-1', 'acc-1');
      expect(m.role).toBe('host');
    });

    it('throws NotAccountMemberError when no membership exists', async () => {
      await expect(service.assertMembership('user-1', 'acc-1')).rejects.toBeInstanceOf(
        NotAccountMemberError,
      );
    });

    it('throws when membership is invited', async () => {
      memberships.seed(activeMembership({ status: 'invited' }));
      await expect(service.assertMembership('user-1', 'acc-1')).rejects.toBeInstanceOf(
        NotAccountMemberError,
      );
    });
  });

  describe('assertClaimOnAccount', () => {
    it('passes when claim present', async () => {
      memberships.seed(activeMembership());
      await expect(
        service.assertClaimOnAccount('user-1', 'acc-1', 'session:create'),
      ).resolves.toBeUndefined();
    });

    it('throws MissingClaimError when claim absent', async () => {
      memberships.seed(activeMembership());
      await expect(
        service.assertClaimOnAccount('user-1', 'acc-1', 'billing:manage'),
      ).rejects.toMatchObject({ name: 'MissingClaimError' });
    });

    it('throws when user is not a member at all', async () => {
      await expect(
        service.assertClaimOnAccount('user-1', 'acc-1', 'session:create'),
      ).rejects.toMatchObject({ name: 'MissingClaimError' });
    });
  });

  describe('getAccountsForUser', () => {
    it('returns one entry per active membership joined with the account row', async () => {
      memberships.seed(activeMembership());
      memberships.seed(
        activeMembership({
          accountId: 'acc-2',
          role: 'member',
          claims: ['account:read'],
        }),
      );
      accounts.seed({ ...account, id: 'acc-2', slug: 'two', displayName: 'Second' });

      const list = await service.getAccountsForUser('user-1');
      const ids = list.map((a) => a.accountId).sort();
      expect(ids).toEqual(['acc-1', 'acc-2']);
      const acc2 = list.find((a) => a.accountId === 'acc-2');
      expect(acc2).toMatchObject({
        accountSlug: 'two',
        accountDisplayName: 'Second',
        role: 'member',
        claims: ['account:read'],
      });
    });

    it('omits inactive memberships', async () => {
      memberships.seed(activeMembership());
      memberships.seed(
        activeMembership({
          accountId: 'acc-2',
          status: 'disabled',
        }),
      );
      accounts.seed({ ...account, id: 'acc-2', slug: 'two' });

      const list = await service.getAccountsForUser('user-1');
      expect(list.map((a) => a.accountId)).toEqual(['acc-1']);
    });

    it('omits memberships pointing at deleted accounts', async () => {
      memberships.seed(
        activeMembership({
          accountId: 'acc-deleted',
        }),
      );
      const list = await service.getAccountsForUser('user-1');
      expect(list).toEqual([]);
    });

    it('returns empty list for a user with no memberships', async () => {
      expect(await service.getAccountsForUser('user-1')).toEqual([]);
    });

    it('returns claim copies, not live arrays', async () => {
      memberships.seed(activeMembership());
      const list = await service.getAccountsForUser('user-1');
      list[0]!.claims.push('admin:global');
      const fresh = await service.getAccountsForUser('user-1');
      expect(fresh[0]!.claims).toEqual(['account:read', 'session:create']);
    });
  });

  describe('error classes', () => {
    it('AccountNotFoundError carries accountId (reserved for future routes that 404 on missing account)', () => {
      const err = new AccountNotFoundError('acc-x');
      expect(err.name).toBe('AccountNotFoundError');
      expect(err.accountId).toBe('acc-x');
    });

    it('NotAccountMemberError carries accountId + userId', () => {
      const err = new NotAccountMemberError('acc-x', 'u-x');
      expect(err.name).toBe('NotAccountMemberError');
      expect(err.accountId).toBe('acc-x');
      expect(err.userId).toBe('u-x');
    });
  });
});
