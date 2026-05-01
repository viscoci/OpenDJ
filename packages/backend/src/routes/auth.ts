import { Hono } from 'hono';
import * as v from 'valibot';
import type { AuthContext } from '@opendj/auth';
import { AuthService } from '../auth/AuthService.js';
import { ClaimsService, NotAccountMemberError } from '../auth/ClaimsService.js';
import { clearSessionCookie } from '../auth/cookies.js';
import { requireAuth, type AuthVariables } from '../auth/middleware.js';
import type { UserRepository } from '../repositories/types.js';

export interface AuthRouteDeps {
  authService: AuthService;
  claimsService: ClaimsService;
  users: UserRepository;
}

interface AuthSessionRow {
  id: string;
  userId: string;
  currentAccountId: string | null;
}

/**
 * `/api/v1/auth/*` route tree. Wired in `createApp` once a deps graph is
 * present; tests construct the router directly.
 *
 * Routes here:
 * - GET    /me              — current user, current account, claims, accounts list
 * - POST   /logout          — revoke active session, clear cookie
 * - POST   /switch-account  — validate membership, refresh claims, update session row
 *
 * OAuth start/callback and email/password endpoints live in subsequent slices —
 * they need the auth-provider registry which is its own piece of work.
 */
export function authRoutes(deps: AuthRouteDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();

  /** GET /me — returns the current user, current account, claims, and accounts list. */
  app.get('/me', requireAuth(deps.authService), async (c) => {
    const auth = c.get('auth') as AuthContext;
    const user = await deps.users.findById(auth.userId!);
    if (!user) {
      // Stale session pointing at a deleted user — revoke and 401.
      return c.json({ error: 'unauthenticated' }, 401);
    }
    const accounts = await deps.claimsService.getAccountsForUser(user.id);
    return c.json({
      user: {
        id: user.id,
        publicUserId: user.publicUserId,
        displayName: user.displayName,
        primaryEmail: user.primaryEmail,
        emailVerified: user.emailVerified,
        avatarUrl: user.avatarUrl,
      },
      currentAccountId: auth.currentAccountId,
      claims: auth.claims,
      accounts,
    });
  });

  /** POST /logout — revoke the active session and clear the cookie. */
  app.post('/logout', requireAuth(deps.authService), async (c) => {
    const sessionId = c.get('authSessionId') as string | undefined;
    if (sessionId) {
      await deps.authService.revokeSession(sessionId, Date.now());
    }
    c.header('Set-Cookie', clearSessionCookie());
    return c.json({ ok: true });
  });

  /** POST /switch-account — set currentAccountId + refresh claims on the session row. */
  const SwitchBody = v.object({ accountId: v.pipe(v.string(), v.uuid()) });
  app.post('/switch-account', requireAuth(deps.authService), async (c) => {
    const auth = c.get('auth') as AuthContext;
    const sessionId = c.get('authSessionId') as string | undefined;
    if (!sessionId) {
      // Defensive — middleware should have populated this when it found the session.
      return c.json({ error: 'unauthenticated' }, 401);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_body' }, 400);
    }
    const parsed = v.safeParse(SwitchBody, body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_body', issues: parsed.issues.map((i) => i.message) }, 400);
    }
    try {
      const claims = await deps.authService.switchAccount(
        sessionId,
        auth.userId!,
        parsed.output.accountId,
      );
      return c.json({ currentAccountId: parsed.output.accountId, claims });
    } catch (err) {
      if (err instanceof NotAccountMemberError) {
        return c.json({ error: 'not_account_member' }, 403);
      }
      throw err;
    }
  });

  return app;
}

/** Re-export for tests / consumers. */
export type { AuthSessionRow };
