/**
 * `/api/v1/sessions/:id/karaoke/*` routes — mic claims.
 *
 * Auth model (same as the queue routes):
 * - Guest actions (claim, remove own claim) authenticate by slot token
 *   (`Authorization: Bearer <slotToken>`)
 * - Host claim removal requires the `queue:moderate` claim (cookie session)
 *   and names the target guest via the `guestId` query param.
 */

import { Hono } from 'hono';
import * as v from 'valibot';
import type { AuthContext } from '@opendj/auth';
import type { AuthService } from '../auth/AuthService.js';
import { requireClaim, type AuthVariables } from '../auth/middleware.js';
import { KaraokeService, KaraokeServiceError } from '../karaoke/KaraokeService.js';

export interface KaraokeRouteDeps {
  authService: AuthService;
  karaokeService: KaraokeService;
}

const ClaimBody = v.object({
  queueItemId: v.pipe(v.string(), v.nonEmpty()),
  displayName: v.string(),
});

function bearerFromAuthHeader(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m ? m[1]!.trim() : null;
}

function mapErrorToStatus(code: string): { status: number; payload: { error: string } } {
  switch (code) {
    case 'unknown_slot_token':
    case 'slot_not_active':
      return { status: 401, payload: { error: code } };
    case 'session_not_found':
    case 'item_not_found':
    case 'claim_not_found':
      return { status: 404, payload: { error: code } };
    case 'not_claim_owner':
      return { status: 403, payload: { error: code } };
    case 'slot_session_mismatch':
    case 'item_session_mismatch':
    case 'guest_not_found':
    case 'karaoke_off':
    case 'item_not_claimable':
    case 'mics_full':
    case 'already_claimed':
    case 'invalid_display_name':
    case 'item_not_waiting':
      return { status: 400, payload: { error: code } };
    default:
      return { status: 400, payload: { error: code } };
  }
}

export function karaokeRoutes(deps: KaraokeRouteDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();

  /** POST /karaoke/claims — guest claims a mic on a queue item. */
  app.post('/claims', async (c) => {
    const sessionId = c.req.param('id') ?? '';
    const slotToken = bearerFromAuthHeader(c.req.header('authorization'));
    if (!slotToken) return c.json({ error: 'missing_slot_token' }, 401);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_body' }, 400);
    }
    const parsed = v.safeParse(ClaimBody, body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_body', issues: parsed.issues.map((i) => i.message) }, 400);
    }
    try {
      const claim = await deps.karaokeService.claim({
        sessionId,
        slotToken,
        queueItemId: parsed.output.queueItemId,
        displayName: parsed.output.displayName,
      });
      return c.json(
        {
          claim: {
            queueItemId: claim.queueItemId,
            guestId: claim.guestId,
            displayName: claim.displayName,
          },
        },
        201,
      );
    } catch (err) {
      if (err instanceof KaraokeServiceError) {
        const { status, payload } = mapErrorToStatus(err.code);
        return c.json(payload, status as 400 | 401 | 403 | 404);
      }
      throw err;
    }
  });

  /**
   * DELETE /karaoke/claims/:itemId — remove a mic claim.
   *
   * With a slot token: the guest removes their OWN claim (only while the
   * item is still waiting). Without one, the request falls through to the
   * host path: `queue:moderate` cookie auth + `?guestId=` naming whose
   * claim to drop — the host override works even mid-song.
   */
  app.delete(
    '/claims/:itemId',
    async (c, next) => {
      const sessionId = c.req.param('id') ?? '';
      const itemId = c.req.param('itemId') ?? '';
      const slotToken = bearerFromAuthHeader(c.req.header('authorization'));
      if (!slotToken) {
        // No slot token — fall through to the host-authenticated branch.
        await next();
        return;
      }
      try {
        await deps.karaokeService.removeClaim({ sessionId, slotToken, queueItemId: itemId });
        return c.json({ ok: true });
      } catch (err) {
        if (err instanceof KaraokeServiceError) {
          const { status, payload } = mapErrorToStatus(err.code);
          return c.json(payload, status as 400 | 401 | 403 | 404);
        }
        throw err;
      }
    },
    requireClaim(deps.authService, 'queue:moderate'),
    async (c) => {
      const sessionId = c.req.param('id') ?? '';
      const itemId = c.req.param('itemId') ?? '';
      const guestId = c.req.query('guestId');
      if (!guestId) return c.json({ error: 'missing_guest_id' }, 400);
      try {
        const auth = c.get('auth') as AuthContext;
        await deps.karaokeService.hostRemoveClaim({
          sessionId,
          queueItemId: itemId,
          guestId,
          ...(auth.userId && { actor: { userId: auth.userId } }),
        });
        return c.json({ ok: true });
      } catch (err) {
        if (err instanceof KaraokeServiceError) {
          const { status, payload } = mapErrorToStatus(err.code);
          return c.json(payload, status as 400 | 401 | 403 | 404);
        }
        throw err;
      }
    },
  );

  return app;
}
