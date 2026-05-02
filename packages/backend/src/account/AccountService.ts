/**
 * AccountService — account creation + membership bootstrap.
 *
 * Owns the "give a brand-new user something they can do" path. Without an
 * account membership the user can't create sessions, connect providers, or
 * moderate queues — none of the route guards would let them through.
 *
 * Slug derivation: lowercased ASCII; non-alphanumeric → `-`; consecutive
 * dashes collapsed; trimmed. If the candidate collides we append `-2`,
 * `-3`, ... until we find a free slot. (Cheap and bounded for the OSS
 * deploy; hosted will switch to a UUID-prefix scheme.)
 *
 * The bootstrap path is idempotent — if the user already has any active
 * membership we return that account instead of creating a duplicate. This
 * matters for OAuth providers where the same user logs in via two different
 * providers and both paths call `bootstrapPersonalAccount`.
 */

import { claimsForRole, type Claim } from '@opendj/auth';
import type {
  AccountRecord,
  AccountRepository,
  MembershipRecord,
  MembershipRepository,
} from '../repositories/types.js';

export interface AccountServiceDeps {
  accounts: AccountRepository;
  memberships: MembershipRepository;
}

export interface BootstrapResult {
  account: AccountRecord;
  membership: MembershipRecord;
  /** True when this call created the account; false when an existing one was reused. */
  created: boolean;
}

const MAX_SLUG_ATTEMPTS = 50;

export class AccountService {
  constructor(private readonly deps: AccountServiceDeps) {}

  /**
   * Ensure the user has at least one active account membership.
   *
   * If they already do, return the most recently created one. Otherwise
   * create a personal account named after their display name (or email)
   * and seed an `owner` membership.
   */
  async bootstrapPersonalAccount(input: {
    userId: string;
    displayNameHint: string;
  }): Promise<BootstrapResult> {
    const existing = await this.deps.memberships.findAllForUser(input.userId);
    const active = existing.filter((m) => m.status === 'active');
    if (active.length > 0) {
      // Pick the oldest by createdAt — stable choice across calls.
      active.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      const m = active[0]!;
      const account = await this.deps.accounts.findById(m.accountId);
      if (account) {
        return { account, membership: m, created: false };
      }
      // Membership references a missing account — fall through and create.
    }
    const slug = await this.uniqueSlug(input.displayNameHint);
    const account = await this.deps.accounts.create({
      displayName: input.displayNameHint || slug,
      slug,
    });
    const membership = await this.deps.memberships.upsert({
      accountId: account.id,
      userId: input.userId,
      role: 'owner',
      claims: claimsForRole('owner') as Claim[],
    });
    return { account, membership, created: true };
  }

  private async uniqueSlug(hint: string): Promise<string> {
    const base = slugify(hint) || 'account';
    if (!(await this.deps.accounts.findBySlug(base))) return base;
    for (let i = 2; i < MAX_SLUG_ATTEMPTS; i += 1) {
      const candidate = `${base}-${i}`;
      if (!(await this.deps.accounts.findBySlug(candidate))) return candidate;
    }
    // Last-resort: random suffix. Bounded retry below shouldn't realistically fire.
    return `${base}-${crypto.randomUUID().slice(0, 8)}`;
  }
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}
