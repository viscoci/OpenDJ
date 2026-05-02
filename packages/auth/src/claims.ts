/**
 * Account-scoped claims used by route middleware to authorize requests.
 *
 * All protected endpoints check claims, not route naming. A user may hold
 * different claim sets per account — `AuthContext.claims` reflects the active
 * account only.
 *
 * See docs/agent-brief.md §"Authentication, accounts, and claims" → "Claims model".
 */

export type Claim =
  | 'account:read'
  | 'account:update'
  | 'account:manage_members'
  | 'session:create'
  | 'session:read'
  | 'session:update'
  | 'session:end'
  | 'queue:moderate'
  | 'provider:connect'
  | 'provider:control_playback'
  | 'billing:manage'
  | 'admin:global';

export type AuthKind = 'anonymous_guest' | 'logged_in_guest' | 'host' | 'service';

export interface AuthContext {
  /** Null for anonymous guests. */
  userId: string | null;
  /** Active account ID. Null for anonymous guests and unscoped service tokens. */
  currentAccountId: string | null;
  /** Optional guest slot context (set during guest-flow requests). */
  guestId?: string;
  /** Optional session context (set during in-session requests). */
  sessionId?: string;
  claims: Claim[];
  authKind: AuthKind;
}

export function hasClaim(context: AuthContext, claim: Claim): boolean {
  return context.claims.includes(claim);
}

export function hasAnyClaim(context: AuthContext, claims: ReadonlyArray<Claim>): boolean {
  return claims.some((c) => context.claims.includes(c));
}

export function hasAllClaims(context: AuthContext, claims: ReadonlyArray<Claim>): boolean {
  return claims.every((c) => context.claims.includes(c));
}

export class MissingClaimError extends Error {
  readonly claim: Claim;
  readonly context: AuthContext;

  constructor(claim: Claim, context: AuthContext) {
    super(`Required claim "${claim}" not present on auth context (kind=${context.authKind}).`);
    this.name = 'MissingClaimError';
    this.claim = claim;
    this.context = context;
  }
}

/**
 * Throw MissingClaimError if `claim` is not held by the context. Use as a
 * declarative guard at the top of service methods.
 */
export function assertClaim(context: AuthContext, claim: Claim): void {
  if (!hasClaim(context, claim)) {
    throw new MissingClaimError(claim, context);
  }
}

export function assertAnyClaim(context: AuthContext, claims: ReadonlyArray<Claim>): void {
  if (!hasAnyClaim(context, claims)) {
    // Surface the first claim — the most common signal for the caller.
    const fallback = claims[0];
    if (fallback === undefined) {
      throw new Error('assertAnyClaim called with empty claim list.');
    }
    throw new MissingClaimError(fallback, context);
  }
}

/**
 * Membership role within an account. Mirrors `memberships.role` in the DB.
 *
 * - `owner` — full account control. Auto-granted to the account creator.
 * - `admin` — manage members + sessions, but cannot delete the account or
 *   change billing. (Reserved for hosted/private; OSS demo doesn't seed it.)
 * - `host` — run sessions and moderate queues. Cannot manage members.
 * - `member` — read-only. Used for invited guests-with-account.
 */
export type MembershipRole = 'owner' | 'admin' | 'host' | 'member';

const OWNER_CLAIMS: ReadonlyArray<Claim> = [
  'account:read',
  'account:update',
  'account:manage_members',
  'session:create',
  'session:read',
  'session:update',
  'session:end',
  'queue:moderate',
  'provider:connect',
  'provider:control_playback',
  'billing:manage',
];

const ADMIN_CLAIMS: ReadonlyArray<Claim> = [
  'account:read',
  'account:update',
  'account:manage_members',
  'session:create',
  'session:read',
  'session:update',
  'session:end',
  'queue:moderate',
  'provider:connect',
  'provider:control_playback',
];

const HOST_CLAIMS: ReadonlyArray<Claim> = [
  'account:read',
  'session:create',
  'session:read',
  'session:update',
  'session:end',
  'queue:moderate',
  'provider:control_playback',
];

const MEMBER_CLAIMS: ReadonlyArray<Claim> = ['account:read', 'session:read'];

/**
 * Default claim set for a membership role. Custom claim overrides on
 * individual memberships still apply — this is just the bootstrap default
 * the AccountService uses when creating new memberships.
 */
export function claimsForRole(role: MembershipRole): Claim[] {
  switch (role) {
    case 'owner':
      return [...OWNER_CLAIMS];
    case 'admin':
      return [...ADMIN_CLAIMS];
    case 'host':
      return [...HOST_CLAIMS];
    case 'member':
      return [...MEMBER_CLAIMS];
  }
}
