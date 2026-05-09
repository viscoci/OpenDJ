/**
 * AuthService — session lifecycle and auth-context resolution.
 *
 * Browser clients see only an opaque `__Host-opendj_session` cookie. Every
 * authenticated request hashes the cookie value and looks up the matching
 * `auth_sessions` row.
 *
 * The current-account context comes from `auth_sessions.current_account_id`
 * (set on login and on `POST /api/v1/auth/switch-account`). The `claims`
 * field on the resolved AuthContext is the snapshot persisted at the time of
 * the last login / claim refresh — call `refreshClaimsSnapshot` after
 * membership changes so the next request sees the new claims.
 *
 * See docs/agent-brief.md §"Authentication, accounts, and claims".
 */

import type { AuthContext, AuthKind, Claim } from '@opendj/auth';
import { generateSessionToken, hashSessionToken } from '@opendj/auth';

// Re-export AuthContext so consumers don't need a separate @opendj/auth import.
export type { AuthContext };
import type { AuthSessionRepository } from '../repositories/types.js';
import type { ClaimsService } from './ClaimsService.js';

export const SESSION_COOKIE_NAME = '__Host-opendj_session';
export const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Bump `lastSeenAt` at most once per this interval to avoid hot writes. */
export const TOUCH_DEBOUNCE_MS = 5 * 60 * 1000;

export interface AuthServiceDeps {
  authSessions: AuthSessionRepository;
  claims: ClaimsService;
  sessionTtlMs?: number;
  /**
   * Wall-clock function. Defaults to `Date.now`. Tests inject a fixed
   * clock so issued sessions and the middleware that validates them
   * agree on "now" — avoids the failure mode where a fixture pinned to
   * a hardcoded date silently expires once real time crosses the TTL.
   */
  clock?: () => number;
}

export interface IssuedSession {
  /** Opaque token to send to the client (Set-Cookie value). Returned ONCE. */
  token: string;
  sessionId: string;
  expiresAt: Date;
}

/**
 * Resolved authentication state for a request — the public AuthContext plus
 * the underlying `auth_sessions.id` so route handlers can mutate the session
 * (logout, switch-account) without re-hashing the cookie.
 */
export interface ResolvedSession {
  context: AuthContext;
  sessionId: string;
}

export interface IssueSessionInput {
  userId: string;
  /** When set, ClaimsService is consulted to populate the claims snapshot. */
  currentAccountId?: string | null;
  ipHash?: string | null;
  userAgentHash?: string | null;
  nowEpochMs?: number;
  /** Override default TTL on a per-session basis (e.g. shorter sessions for elevated actions). */
  ttlMs?: number;
  /** Override the host claim list (e.g. service tokens that pre-compute claims). */
  claimsSnapshot?: Claim[];
}

export class AuthService {
  private readonly sessionTtlMs: number;
  private readonly clock: () => number;

  constructor(private readonly deps: AuthServiceDeps) {
    this.sessionTtlMs = deps.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.clock = deps.clock ?? Date.now;
  }

  /** Wall-clock epoch ms via the configured clock. */
  now(): number {
    return this.clock();
  }

  async issueSession(input: IssueSessionInput): Promise<IssuedSession> {
    const now = input.nowEpochMs ?? this.now();
    const ttl = input.ttlMs ?? this.sessionTtlMs;
    const token = generateSessionToken();
    const sessionHash = await hashSessionToken(token);

    const accountId = input.currentAccountId ?? null;
    const claimsSnapshot =
      input.claimsSnapshot ??
      (accountId !== null ? await this.deps.claims.refreshClaims(input.userId, accountId) : []);

    const created = await this.deps.authSessions.create({
      userId: input.userId,
      currentAccountId: accountId,
      sessionHash,
      claimsSnapshot,
      ipHash: input.ipHash ?? null,
      userAgentHash: input.userAgentHash ?? null,
      expiresAt: new Date(now + ttl),
    });

    return {
      token,
      sessionId: created.id,
      expiresAt: created.expiresAt,
    };
  }

  /**
   * Resolve a token into an AuthContext + sessionId, or `null` if the session
   * is missing, expired, or revoked. Bumps `lastSeenAt` at most once per
   * `TOUCH_DEBOUNCE_MS`.
   *
   * Middleware uses the sessionId for /logout and /switch-account; pure read
   * paths can ignore it.
   */
  async resolveAuthContext(token: string, nowEpochMs: number): Promise<ResolvedSession | null> {
    const sessionHash = await hashSessionToken(token);
    const session = await this.deps.authSessions.findActiveByHash(sessionHash, nowEpochMs);
    if (!session) return null;

    if (nowEpochMs - session.lastSeenAt.getTime() >= TOUCH_DEBOUNCE_MS) {
      await this.deps.authSessions.touch(session.id, nowEpochMs);
    }

    const authKind: AuthKind =
      session.currentAccountId !== null && session.claimsSnapshot.length > 0
        ? 'host'
        : 'logged_in_guest';

    return {
      context: {
        userId: session.userId,
        currentAccountId: session.currentAccountId,
        claims: [...session.claimsSnapshot],
        authKind,
      },
      sessionId: session.id,
    };
  }

  async revokeSession(sessionId: string, nowEpochMs?: number): Promise<void> {
    await this.deps.authSessions.revoke(sessionId, nowEpochMs ?? this.now());
  }

  /**
   * Re-read claims for `(userId, accountId)` and persist on the session row.
   * Call after add/remove member, role change, or account switch.
   */
  async refreshClaimsSnapshot(
    sessionId: string,
    userId: string,
    accountId: string,
  ): Promise<Claim[]> {
    const claims = await this.deps.claims.refreshClaims(userId, accountId);
    await this.deps.authSessions.updateClaimsSnapshot(sessionId, claims);
    return claims;
  }

  /**
   * Switch the active account on the session. Validates that the user is an
   * active member of `accountId` first — `assertMembership` throws
   * `NotAccountMemberError` otherwise.
   *
   * Returns the freshly-loaded claim list. Callers (route handlers) typically
   * include this in the response payload alongside the new currentAccountId.
   */
  async switchAccount(sessionId: string, userId: string, accountId: string): Promise<Claim[]> {
    await this.deps.claims.assertMembership(userId, accountId);
    const claims = await this.deps.claims.refreshClaims(userId, accountId);
    await this.deps.authSessions.updateCurrentAccount(sessionId, accountId);
    await this.deps.authSessions.updateClaimsSnapshot(sessionId, claims);
    return claims;
  }
}

/**
 * Extract the OpenDJ session token from a `Cookie` header value, or null if
 * absent. Tolerates leading whitespace and the `__Host-` Secure prefix.
 */
export function parseSessionCookie(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  for (const segment of cookieHeader.split(';')) {
    const eq = segment.indexOf('=');
    if (eq < 0) continue;
    const name = segment.slice(0, eq).trim();
    if (name !== SESSION_COOKIE_NAME) continue;
    const value = segment.slice(eq + 1).trim();
    if (value.length === 0) return null;
    return value;
  }
  return null;
}
