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
