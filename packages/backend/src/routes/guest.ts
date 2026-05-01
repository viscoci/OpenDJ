/**
 * `/api/v1/guest/{identity,heartbeat,slot}` routes.
 *
 * Anonymous guest identity flow — no auth cookie required. Authentication is
 * by slot token (sent as `Authorization: Bearer <slotToken>`).
 *
 * See docs/agent-brief.md §"Guest Identity & Slot System".
 */

import { Hono } from 'hono';
import * as v from 'valibot';
import {
  GuestIdentityService,
  SessionEndedError,
  SessionNotFoundError,
} from '../guest/GuestIdentityService.js';

export interface GuestRouteDeps {
  guestIdentity: GuestIdentityService;
}

const IdentityBody = v.object({
  fingerprintHash: v.pipe(v.string(), v.nonEmpty()),
  eventSlug: v.pipe(v.string(), v.nonEmpty()),
});

function bearerFromAuthHeader(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m ? m[1]!.trim() : null;
}

export function guestRoutes(deps: GuestRouteDeps): Hono {
  const app = new Hono();

  /** POST /identity — issue or refresh a guest slot. */
  app.post('/identity', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_body' }, 400);
    }
    const parsed = v.safeParse(IdentityBody, body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_body', issues: parsed.issues.map((i) => i.message) }, 400);
    }
    try {
      const result = await deps.guestIdentity.issueIdentity(parsed.output);
      return c.json(result);
    } catch (err) {
      if (err instanceof SessionNotFoundError) {
        return c.json({ error: 'session_not_found', qrSlug: err.qrSlug }, 404);
      }
      if (err instanceof SessionEndedError) {
        return c.json({ error: 'session_ended', qrSlug: err.qrSlug }, 410);
      }
      throw err;
    }
  });

  /** POST /heartbeat — refresh slot's last_heartbeat. */
  app.post('/heartbeat', async (c) => {
    const token = bearerFromAuthHeader(c.req.header('authorization'));
    if (!token) return c.json({ error: 'missing_slot_token' }, 401);
    try {
      const slot = await deps.guestIdentity.heartbeat(token);
      return c.json({
        status: slot.status,
        ...(slot.queuePosition !== null && { queuePosition: slot.queuePosition }),
      });
    } catch {
      return c.json({ error: 'unknown_slot_token' }, 401);
    }
  });

  /** GET /slot — read current slot state. */
  app.get('/slot', async (c) => {
    const token = bearerFromAuthHeader(c.req.header('authorization'));
    if (!token) return c.json({ error: 'missing_slot_token' }, 401);
    const slot = await deps.guestIdentity.getSlot(token);
    if (!slot) return c.json({ error: 'unknown_slot_token' }, 401);
    return c.json({
      status: slot.status,
      ...(slot.queuePosition !== null && { queuePosition: slot.queuePosition }),
      sessionId: slot.sessionId,
    });
  });

  return app;
}
