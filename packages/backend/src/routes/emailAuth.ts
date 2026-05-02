/**
 * `/api/v1/auth/email/{register,login}` routes.
 *
 * Verification + password reset endpoints (`/email/verify`,
 * `/password/reset/{start,finish}`) follow once an email-sending adapter
 * lands. The schema is ready for them — just no transport yet.
 */

import { Hono } from 'hono';
import * as v from 'valibot';
import type { AuthVariables } from '../auth/middleware.js';
import { EmailPasswordError, type EmailPasswordService } from '../auth/EmailPasswordService.js';
import { buildSessionCookie } from '../auth/cookies.js';

export interface EmailAuthRouteDeps {
  emailPassword: EmailPasswordService;
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

  return app;
}
