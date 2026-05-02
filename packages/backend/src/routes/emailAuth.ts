/**
 * `/api/v1/auth/email/*` routes — register, login, verify, request-reset, reset.
 *
 * Email verification + password reset use opaque one-time tokens emailed to
 * the user; the backend stores only the SHA-256 of each token. Verification
 * + reset endpoints accept the raw token from the link.
 */

import type { AuthContext } from '@opendj/auth';
import { Hono } from 'hono';
import * as v from 'valibot';
import type { AuthService } from '../auth/AuthService.js';
import { requireAuth, type AuthVariables } from '../auth/middleware.js';
import { EmailPasswordError, type EmailPasswordService } from '../auth/EmailPasswordService.js';
import { buildSessionCookie } from '../auth/cookies.js';
import {
  EmailVerificationError,
  type EmailVerificationService,
} from '../email/EmailVerificationService.js';
import { PasswordResetError, type PasswordResetService } from '../email/PasswordResetService.js';
import type { UserRepository } from '../repositories/types.js';

export interface EmailAuthRouteDeps {
  emailPassword: EmailPasswordService;
  /** When supplied, mounts verification + reset routes. Optional for back-compat. */
  emailVerification?: EmailVerificationService;
  passwordReset?: PasswordResetService;
  authService?: AuthService;
  users?: UserRepository;
}

const RegisterBody = v.object({
  email: v.pipe(v.string(), v.email()),
  password: v.pipe(v.string(), v.minLength(8), v.maxLength(200)),
  displayName: v.optional(v.pipe(v.string(), v.maxLength(120))),
});

const LoginBody = v.object({
  email: v.pipe(v.string(), v.email()),
  password: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
});

function statusForCode(code: string): number {
  switch (code) {
    case 'email_taken':
      return 409;
    case 'invalid_credentials':
      return 401;
    case 'account_locked':
      return 423;
    default:
      return 400;
  }
}

export function emailAuthRoutes(deps: EmailAuthRouteDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();

  app.post('/register', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_body' }, 400);
    }
    const parsed = v.safeParse(RegisterBody, body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_body', issues: parsed.issues.map((i) => i.message) }, 400);
    }
    try {
      const result = await deps.emailPassword.register({
        email: parsed.output.email,
        password: parsed.output.password,
        ...(parsed.output.displayName !== undefined && {
          displayName: parsed.output.displayName,
        }),
      });
      c.header(
        'Set-Cookie',
        buildSessionCookie({
          value: result.session.token,
          expiresAt: result.session.expiresAt,
        }),
      );
      return c.json({ userId: result.userId, expiresAt: result.session.expiresAt }, 201);
    } catch (err) {
      if (err instanceof EmailPasswordError) {
        return c.json({ error: err.code }, statusForCode(err.code) as 400 | 401 | 409 | 423);
      }
      throw err;
    }
  });

  app.post('/login', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_body' }, 400);
    }
    const parsed = v.safeParse(LoginBody, body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_body' }, 400);
    }
    try {
      const session = await deps.emailPassword.login({
        email: parsed.output.email,
        password: parsed.output.password,
      });
      c.header(
        'Set-Cookie',
        buildSessionCookie({ value: session.token, expiresAt: session.expiresAt }),
      );
      return c.json({ expiresAt: session.expiresAt });
    } catch (err) {
      if (err instanceof EmailPasswordError) {
        return c.json({ error: err.code }, statusForCode(err.code) as 400 | 401 | 409 | 423);
      }
      throw err;
    }
  });

  // ─── Email verification ──────────────────────────────────────────────────

  if (deps.emailVerification && deps.authService && deps.users) {
    const verification = deps.emailVerification;
    const authService = deps.authService;
    const users = deps.users;

    /**
     * POST /request-verification — send a verification email to the
     * authenticated user's primary email. No body needed.
     */
    app.post('/request-verification', requireAuth(authService), async (c) => {
      const auth = c.get('auth') as AuthContext;
      if (!auth.userId) return c.json({ error: 'unauthenticated' }, 401);
      const user = await users.findById(auth.userId);
      if (!user || !user.primaryEmail) {
        return c.json({ error: 'no_primary_email' }, 400);
      }
      if (user.emailVerified) return c.json({ ok: true, alreadyVerified: true });
      try {
        await verification.requestVerification({ userId: user.id, email: user.primaryEmail });
      } catch (err) {
        if (err instanceof EmailVerificationError) {
          return c.json({ error: err.code }, 400);
        }
        throw err;
      }
      return c.json({ ok: true });
    });

    /**
     * GET /verify?token=… — public, follows the email link. On success the
     * user's `email_verified` is set; we 302 to /host/dashboard so the link
     * doesn't leave the user staring at a JSON blob.
     */
    const VerifyQuery = v.object({
      token: v.pipe(v.string(), v.nonEmpty()),
    });
    app.get('/verify', async (c) => {
      const parsed = v.safeParse(VerifyQuery, { token: c.req.query('token') });
      if (!parsed.success) {
        return c.json({ error: 'invalid_token' }, 400);
      }
      try {
        const result = await verification.verifyToken(parsed.output.token);
        return c.json({ ok: true, email: result.email });
      } catch (err) {
        if (err instanceof EmailVerificationError) {
          return c.json({ error: err.code }, 400);
        }
        throw err;
      }
    });
  }

  // ─── Password reset ──────────────────────────────────────────────────────

  if (deps.passwordReset) {
    const passwordReset = deps.passwordReset;

    /**
     * POST /request-reset — public. Accepts `{ email }`. Always returns 200
     * to avoid leaking whether the email exists.
     */
    const RequestResetBody = v.object({
      email: v.pipe(v.string(), v.email()),
    });
    app.post('/request-reset', async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'invalid_body' }, 400);
      }
      const parsed = v.safeParse(RequestResetBody, body);
      if (!parsed.success) {
        return c.json({ error: 'invalid_body' }, 400);
      }
      await passwordReset.requestReset({ email: parsed.output.email });
      return c.json({ ok: true });
    });

    /**
     * POST /reset — public. Body: `{ token, newPassword }`. On success the
     * user's password is swapped; the next /auth/email/login uses the new
     * password.
     */
    const ResetBody = v.object({
      token: v.pipe(v.string(), v.nonEmpty()),
      newPassword: v.pipe(v.string(), v.minLength(8), v.maxLength(200)),
    });
    app.post('/reset', async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'invalid_body' }, 400);
      }
      const parsed = v.safeParse(ResetBody, body);
      if (!parsed.success) {
        return c.json({ error: 'invalid_body' }, 400);
      }
      try {
        const result = await passwordReset.completeReset({
          token: parsed.output.token,
          newPassword: parsed.output.newPassword,
        });
        return c.json({ ok: true, userId: result.userId });
      } catch (err) {
        if (err instanceof PasswordResetError) {
          return c.json({ error: err.code }, err.code === 'invalid_password' ? 400 : 400);
        }
        throw err;
      }
    });
  }

  return app;
}
