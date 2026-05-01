/**
 * Hono middleware for auth + claim gating.
 *
 * - `optionalAuth(authService)`: sets `c.var.auth` to the AuthContext when a
 *   valid session cookie is present, or `null` otherwise. Always continues.
 * - `requireAuth(authService)`: 401 when no AuthContext.
 * - `requireClaim(authService, claim)`: 401 unauth, 403 missing claim.
 * - `requireAnyClaim(authService, claims)`: same logic, satisfied by any one.
 *
 * Routes read the AuthContext via `c.get('auth')`. The middlewares set it on
 * the Hono context as a `Variables` entry — register the typed context once
 * at app construction and the entire route tree gets typed access.
 */

import type { AuthContext } from '@opendj/auth';
import { hasAnyClaim, hasClaim } from '@opendj/auth';
import type { Claim } from '@opendj/auth';
import type { Context, MiddlewareHandler } from 'hono';
import { AuthService, parseSessionCookie } from './AuthService.js';

export interface AuthVariables {
  auth: AuthContext | null;
}

function readCookie(c: Context): string | null {
  return parseSessionCookie(c.req.header('cookie'));
}

export function optionalAuth(authService: AuthService): MiddlewareHandler<{
  Variables: AuthVariables;
}> {
  return async (c, next) => {
    const token = readCookie(c);
    if (token) {
      const context = await authService.resolveAuthContext(token, Date.now());
      c.set('auth', context);
    } else {
      c.set('auth', null);
    }
    await next();
  };
}

export function requireAuth(authService: AuthService): MiddlewareHandler<{
  Variables: AuthVariables;
}> {
  return async (c, next) => {
    const token = readCookie(c);
    if (!token) {
      return c.json({ error: 'unauthenticated' }, 401);
    }
    const context = await authService.resolveAuthContext(token, Date.now());
    if (!context) {
      return c.json({ error: 'unauthenticated' }, 401);
    }
    c.set('auth', context);
    await next();
    return undefined;
  };
}

export function requireClaim(
  authService: AuthService,
  claim: Claim,
): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const token = readCookie(c);
    if (!token) return c.json({ error: 'unauthenticated' }, 401);
    const context = await authService.resolveAuthContext(token, Date.now());
    if (!context) return c.json({ error: 'unauthenticated' }, 401);
    if (!hasClaim(context, claim)) {
      return c.json({ error: 'forbidden', missingClaim: claim }, 403);
    }
    c.set('auth', context);
    await next();
    return undefined;
  };
}

export function requireAnyClaim(
  authService: AuthService,
  claims: ReadonlyArray<Claim>,
): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const token = readCookie(c);
    if (!token) return c.json({ error: 'unauthenticated' }, 401);
    const context = await authService.resolveAuthContext(token, Date.now());
    if (!context) return c.json({ error: 'unauthenticated' }, 401);
    if (!hasAnyClaim(context, claims)) {
      return c.json({ error: 'forbidden', missingAnyClaim: [...claims] }, 403);
    }
    c.set('auth', context);
    await next();
    return undefined;
  };
}
