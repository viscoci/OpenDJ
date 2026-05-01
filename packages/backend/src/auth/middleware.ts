/**
 * Hono middleware for auth + claim gating.
 *
 * - `optionalAuth(authService)`: sets `c.var.auth` to the AuthContext when a
 *   valid session cookie is present, or `null` otherwise. Always continues.
 * - `requireAuth(authService)`: 401 when no AuthContext.
 * - `requireClaim(authService, claim)`: 401 unauth, 403 missing claim.
 * - `requireAnyClaim(authService, claims)`: same logic, satisfied by any one.
 *
 * Routes read the AuthContext via `c.get('auth')` and the underlying session
 * id via `c.get('authSessionId')`. The middlewares set both on the Hono
 * context — register the typed context once at app construction and the
 * entire route tree gets typed access.
 */

import type { AuthContext, Claim } from '@opendj/auth';
import { hasAnyClaim, hasClaim } from '@opendj/auth';
import type { Context, MiddlewareHandler } from 'hono';
import { AuthService, parseSessionCookie } from './AuthService.js';

export interface AuthVariables {
  auth: AuthContext | null;
  /**
   * Active `auth_sessions.id` for the current request. Set by every middleware
   * that resolves a non-null AuthContext. Routes that mutate the session
   * (logout, switch-account) read it via `c.get('authSessionId')`.
   */
  authSessionId: string | undefined;
}

function readCookie(c: Context): string | null {
  return parseSessionCookie(c.req.header('cookie'));
}

async function resolve(
  authService: AuthService,
  c: Context,
): Promise<{ context: AuthContext | null; sessionId: string | undefined }> {
  const token = readCookie(c);
  if (!token) return { context: null, sessionId: undefined };
  const resolved = await authService.resolveAuthContext(token, Date.now());
  if (!resolved) return { context: null, sessionId: undefined };
  return { context: resolved.context, sessionId: resolved.sessionId };
}

export function optionalAuth(
  authService: AuthService,
): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const { context, sessionId } = await resolve(authService, c);
    c.set('auth', context);
    c.set('authSessionId', sessionId);
    await next();
  };
}

export function requireAuth(
  authService: AuthService,
): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const { context, sessionId } = await resolve(authService, c);
    if (!context) return c.json({ error: 'unauthenticated' }, 401);
    c.set('auth', context);
    c.set('authSessionId', sessionId);
    await next();
    return undefined;
  };
}

export function requireClaim(
  authService: AuthService,
  claim: Claim,
): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const { context, sessionId } = await resolve(authService, c);
    if (!context) return c.json({ error: 'unauthenticated' }, 401);
    if (!hasClaim(context, claim)) {
      return c.json({ error: 'forbidden', missingClaim: claim }, 403);
    }
    c.set('auth', context);
    c.set('authSessionId', sessionId);
    await next();
    return undefined;
  };
}

export function requireAnyClaim(
  authService: AuthService,
  claims: ReadonlyArray<Claim>,
): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const { context, sessionId } = await resolve(authService, c);
    if (!context) return c.json({ error: 'unauthenticated' }, 401);
    if (!hasAnyClaim(context, claims)) {
      return c.json({ error: 'forbidden', missingAnyClaim: [...claims] }, 403);
    }
    c.set('auth', context);
    c.set('authSessionId', sessionId);
    await next();
    return undefined;
  };
}
