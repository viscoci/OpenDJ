/**
 * ClaimsService — read-only view of account membership and claims.
 *
 * Mutations to memberships (add/remove member, change role, change claims)
 * happen via dedicated `/api/v1/accounts/:id/members` route handlers; this
 * service is the read path used by middleware on every authenticated request.
 *
 * See docs/agent-brief.md §"Claims model".
 */

import type { Claim } from '@opendj/auth';
import { MissingClaimError } from '@opendj/auth';
import type {
  AccountRepository,
  MembershipRecord,
  MembershipRepository,
} from '../repositories/types.js';

export class AccountNotFoundError extends Error {
  readonly accountId: string;
  constructor(accountId: string) {
    super(`Account "${accountId}" not found.`);
    this.name = 'AccountNotFoundError';
    this.accountId = accountId;
  }
}

export class NotAccountMemberError extends Error {
  readonly accountId: string;
  readonly userId: string;
  constructor(accountId: string, userId: string) {
    super(`User "${userId}" is not an active member of account "${accountId}".`);
    this.name = 'NotAccountMemberError';
    this.accountId = accountId;
    this.userId = userId;
  }
}

export interface ClaimsServiceDeps {
  memberships: MembershipRepository;
  accounts: AccountRepository;
}

export interface AccountAccess {
  accountId: string;
  accountSlug: string;
  accountDisplayName: string;
  role: MembershipRecord['role'];
  claims: Claim[];
}

export class ClaimsService {
  constructor(private readonly deps: ClaimsServiceDeps) {}

  /**
   * Load the active claim list for `userId` against `accountId`. Returns an
   * empty array if no membership exists or the membership is not active —
   * the caller decides whether to 401 or 403 based on context.
   */
  async refreshClaims(userId: string, accountId: string): Promise<Claim[]> {
    const membership = await this.deps.memberships.find(accountId, userId);
    if (!membership || membership.status !== 'active') return [];
    return [...membership.claims];
  }

  /**
   * Throw `NotAccountMemberError` if the user is not an active member.
   * Use this BEFORE checking specific claims so the error message is precise
   * (member-with-missing-claim vs not-a-member).
   */
  async assertMembership(userId: string, accountId: string): Promise<MembershipRecord> {
    const membership = await this.deps.memberships.find(accountId, userId);
    if (!membership || membership.status !== 'active') {
      throw new NotAccountMemberError(accountId, userId);
    }
    return membership;
  }

  /** Throws if the user lacks the claim on the given account. */
  async assertClaimOnAccount(userId: string, accountId: string, claim: Claim): Promise<void> {
    const claims = await this.refreshClaims(userId, accountId);
    if (!claims.includes(claim)) {
      throw new MissingClaimError(claim, {
        userId,
        currentAccountId: accountId,
        claims,
        authKind: 'host',
      });
    }
  }

  /**
   * Return every account this user has an active membership in, with their
   * role + claims joined. Used by `/api/v1/accounts` and `/api/v1/auth/me`.
   *
   * Filters out inactive memberships (invited / disabled) so the user-visible
   * account list reflects what they can actually act on.
   */
  async getAccountsForUser(userId: string): Promise<AccountAccess[]> {
    const memberships = await this.deps.memberships.findAllForUser(userId);
    const result: AccountAccess[] = [];
    for (const m of memberships) {
      if (m.status !== 'active') continue;
      const account = await this.deps.accounts.findById(m.accountId);
      if (!account) continue;
      result.push({
        accountId: account.id,
        accountSlug: account.slug,
        accountDisplayName: account.displayName,
        role: m.role,
        claims: [...m.claims],
      });
    }
    return result;
  }
}
