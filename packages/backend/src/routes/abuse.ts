/**
 * `/api/v1/sessions/:id/abuse/{summary,block-guest,unblock-guest}` routes.
 *
 * All host-only — `requireClaim('queue:moderate')`.
 */

import { Hono } from 'hono';
import * as v from 'valibot';
import type { AuthContext } from '@opendj/auth';
import {
  AbuseModerationService,
  AbuseModerationServiceError,
} from '../abuse/AbuseModerationService.js';
import type { AuthService } from '../auth/AuthService.js';
import { requireClaim, type AuthVariables } from '../auth/middleware.js';

export interface AbuseRouteDeps {
  authService: AuthService;
  abuseModeration: AbuseModerationService;
}

const BlockBody = v.object({
  subjectHash: v.pipe(v.string(), v.nonEmpty()),
  reason: v.optional(v.pipe(v.string(), v.maxLength(500))),
  expiresAtEpochMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
});

const UnblockBody = v.object({
  subjectHash: v.pipe(v.string(), v.nonEmpty()),
});

export function abuseRoutes(deps: AbuseRouteDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();

  app.get('/summary', requireClaim(deps.authService, 'queue:moderate'), async (c) => {
    const sessionId = c.req.param('id') ?? '';
    const summary = await deps.abuseModeration.summary({ sessionId });
    return c.json(summary);
  });

  app.post('/block-guest', requireClaim(deps.authService, 'queue:moderate'), async (c) => {
    const auth = c.get('auth') as AuthContext;
    if (!auth.userId || !auth.currentAccountId) return c.json({ error: 'no_active_account' }, 400);
    const sessionId = c.req.param('id') ?? '';
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_body' }, 400);
    }
    const parsed = v.safeParse(BlockBody, body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_body' }, 400);
    }
    const subject = await deps.abuseModeration.blockGuest({
      sessionId,
      accountId: auth.currentAccountId,
      subjectHash: parsed.output.subjectHash,
      byUserId: auth.userId,
      ...(parsed.output.reason !== undefined && { reason: parsed.output.reason }),
      ...(parsed.output.expiresAtEpochMs !== undefined && {
        expiresAt: new Date(parsed.output.expiresAtEpochMs),
      }),
    });
    return c.json({ subject });
  });

  app.post('/unblock-guest', requireClaim(deps.authService, 'queue:moderate'), async (c) => {
    const auth = c.get('auth') as AuthContext;
    if (!auth.userId || !auth.currentAccountId) return c.json({ error: 'no_active_account' }, 400);
    const sessionId = c.req.param('id') ?? '';
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_body' }, 400);
    }
    const parsed = v.safeParse(UnblockBody, body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_body' }, 400);
    }
    try {
      await deps.abuseModeration.unblockGuest({
        sessionId,
        accountId: auth.currentAccountId,
        subjectHash: parsed.output.subjectHash,
        byUserId: auth.userId,
      });
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof AbuseModerationServiceError && err.code === 'session_mismatch') {
        return c.json({ error: err.code }, 400);
      }
      throw err;
    }
  });

  return app;
}
