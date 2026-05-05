/**
 * `/api/v1/sessions/:id/queue/*` routes.
 *
 * Auth model:
 * - Guest actions (request, remove own, cast skip vote) authenticate by
 *   slot token (Authorization: Bearer <slotToken>)
 * - Host moderation (approve/reject) requires `queue:moderate` claim
 *
 * See docs/agent-brief.md §"API Routes" → Queue.
 */

import { Hono } from 'hono';
import * as v from 'valibot';
import type { AuthService } from '../auth/AuthService.js';
import { requireClaim, type AuthVariables } from '../auth/middleware.js';
import { QueueService, QueueServiceError } from '../queue/QueueService.js';
import { toQueueItemSummary } from '@opendj/realtime';

export interface QueueRouteDeps {
  authService: AuthService;
  queueService: QueueService;
}

const TrackBody = v.object({
  uri: v.pipe(v.string(), v.nonEmpty()),
  name: v.pipe(v.string(), v.nonEmpty()),
  artist: v.pipe(v.string(), v.nonEmpty()),
  albumArt: v.union([v.pipe(v.string(), v.url()), v.null()]),
  durationMs: v.pipe(v.number(), v.integer(), v.minValue(0)),
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
      return { status: 404, payload: { error: code } };
    case 'slot_session_mismatch':
    case 'item_session_mismatch':
    case 'guest_not_found':
    case 'session_ended':
    case 'guest_session_mismatch':
    case 'cap_reached':
    case 'item_playing':
    case 'already_voted':
    case 'duplicate_request':
    case 'no_room':
    case 'no_track_playing':
    case 'track_not_in_queue':
      return { status: 400, payload: { error: code } };
    case 'not_owner':
      return { status: 403, payload: { error: code } };
    default:
      return { status: 400, payload: { error: code } };
  }
}

export function queueRoutes(deps: QueueRouteDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();

  /** GET /api/v1/sessions/:id/queue — full queue (guest + host visible). */
  app.get('/', async (c) => {
    const sessionId = c.req.param('id') ?? '';
    const items = await deps.queueService.listForSession(sessionId);
    return c.json({ items: items.map((i) => toQueueItemSummary(i)) });
  });

  /** POST /queue — guest requests a track via slot token. */
  app.post('/', async (c) => {
    const sessionId = c.req.param('id') ?? '';
    const slotToken = bearerFromAuthHeader(c.req.header('authorization'));
    if (!slotToken) return c.json({ error: 'missing_slot_token' }, 401);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_body' }, 400);
    }
    const parsed = v.safeParse(TrackBody, body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_body', issues: parsed.issues.map((i) => i.message) }, 400);
    }
    try {
      const created = await deps.queueService.requestTrack({
        sessionId,
        slotToken,
        track: parsed.output,
      });
      return c.json({ item: toQueueItemSummary(created) }, 201);
    } catch (err) {
      if (err instanceof QueueServiceError) {
        const { status, payload } = mapErrorToStatus(err.code);
        return c.json(payload, status as 400 | 401 | 403 | 404);
      }
      throw err;
    }
  });

  /** PATCH /queue/:itemId — host moderation. */
  const ModerateBody = v.object({
    decision: v.union([v.literal('approved'), v.literal('rejected')]),
  });
  app.patch('/:itemId', requireClaim(deps.authService, 'queue:moderate'), async (c) => {
    const sessionId = c.req.param('id') ?? '';
    const itemId = c.req.param('itemId') ?? '';
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_body' }, 400);
    }
    const parsed = v.safeParse(ModerateBody, body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_body' }, 400);
    }
    try {
      const updated = await deps.queueService.moderate({
        itemId,
        sessionId,
        decision: parsed.output.decision,
      });
      return c.json({ item: toQueueItemSummary(updated) });
    } catch (err) {
      if (err instanceof QueueServiceError) {
        const { status, payload } = mapErrorToStatus(err.code);
        return c.json(payload, status as 400 | 401 | 403 | 404);
      }
      throw err;
    }
  });

  /** DELETE /queue/:itemId — guest removes their own item. */
  app.delete('/:itemId', async (c) => {
    const sessionId = c.req.param('id') ?? '';
    const itemId = c.req.param('itemId') ?? '';
    const slotToken = bearerFromAuthHeader(c.req.header('authorization'));
    if (!slotToken) return c.json({ error: 'missing_slot_token' }, 401);
    try {
      await deps.queueService.removeOwn({ itemId, sessionId, slotToken });
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof QueueServiceError) {
        const { status, payload } = mapErrorToStatus(err.code);
        return c.json(payload, status as 400 | 401 | 403 | 404);
      }
      throw err;
    }
  });

  /**
   * POST /queue/provider-vote-skip — guest votes to skip a provider-queue
   * track that has no OpenDJ counterpart. Body: { trackUri }. Returns
   * `{count, threshold, thresholdReached}` — same shape as queue-item skip
   * vote so the client UI can share rendering logic.
   */
  const ProviderVoteSkipBody = v.object({
    trackUri: v.pipe(v.string(), v.nonEmpty()),
  });
  app.post('/provider-vote-skip', async (c) => {
    const sessionId = c.req.param('id') ?? '';
    const slotToken = bearerFromAuthHeader(c.req.header('authorization'));
    if (!slotToken) return c.json({ error: 'missing_slot_token' }, 401);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_body' }, 400);
    }
    const parsed = v.safeParse(ProviderVoteSkipBody, body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_body', issues: parsed.issues.map((i) => i.message) }, 400);
    }
    try {
      const result = await deps.queueService.castProviderQueueSkipVote({
        sessionId,
        slotToken,
        trackUri: parsed.output.trackUri,
      });
      return c.json(result);
    } catch (err) {
      if (err instanceof QueueServiceError) {
        const { status, payload } = mapErrorToStatus(err.code);
        return c.json(payload, status as 400 | 401 | 403 | 404);
      }
      throw err;
    }
  });

  /**
   * POST /queue/provider-reject — host force-rejects a provider-queue track
   * that has no OpenDJ counterpart. Same downstream handling as a vote
   * threshold landing (URI added to rejected set, immediate skip if it's
   * playing). Cookie session + `queue:moderate` claim.
   */
  app.post('/provider-reject', requireClaim(deps.authService, 'queue:moderate'), async (c) => {
    const sessionId = c.req.param('id') ?? '';
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_body' }, 400);
    }
    const parsed = v.safeParse(ProviderVoteSkipBody, body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_body', issues: parsed.issues.map((i) => i.message) }, 400);
    }
    try {
      const result = await deps.queueService.hostRejectProviderTrack({
        sessionId,
        trackUri: parsed.output.trackUri,
      });
      return c.json(result);
    } catch (err) {
      if (err instanceof QueueServiceError) {
        const { status, payload } = mapErrorToStatus(err.code);
        return c.json(payload, status as 400 | 401 | 403 | 404);
      }
      throw err;
    }
  });

  /** POST /queue/:itemId/skip-vote — guest casts a vote. */
  app.post('/:itemId/skip-vote', async (c) => {
    const sessionId = c.req.param('id') ?? '';
    const itemId = c.req.param('itemId') ?? '';
    const slotToken = bearerFromAuthHeader(c.req.header('authorization'));
    if (!slotToken) return c.json({ error: 'missing_slot_token' }, 401);
    try {
      const result = await deps.queueService.castSkipVote({
        itemId,
        sessionId,
        slotToken,
      });
      return c.json(result);
    } catch (err) {
      if (err instanceof QueueServiceError) {
        const { status, payload } = mapErrorToStatus(err.code);
        return c.json(payload, status as 400 | 401 | 403 | 404);
      }
      throw err;
    }
  });

  return app;
}
