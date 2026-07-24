/**
 * `/api/v1/sessions/*` routes.
 *
 * Session create / read / update / end. Read is public so guests can hydrate
 * the request page from `qrSlug`. Mutations require the matching account-
 * scoped claim.
 */

import { Hono } from 'hono';
import * as v from 'valibot';
import type { AuthContext } from '@opendj/auth';
import type { AuthService } from '../auth/AuthService.js';
import { requireAuth, requireClaim, type AuthVariables } from '../auth/middleware.js';
import type { RealtimeRoomRegistry } from '../queue/QueueService.js';
import { SessionService, SessionServiceError } from '../session/SessionService.js';
import { toQueueItemSummary } from '@opendj/realtime';
import type { GuestSlotRepository, QueueItemRepository } from '../repositories/types.js';
import type { SessionAuditService } from '../session/SessionAuditService.js';

export interface SessionRouteDeps {
  authService: AuthService;
  sessionService: SessionService;
  /** Optional — when supplied, exposes the public TV snapshot endpoint. */
  rooms?: RealtimeRoomRegistry;
  queueItems?: QueueItemRepository;
  guestSlots?: GuestSlotRepository;
  audit?: SessionAuditService;
}

const VoteSkipMode = v.union([
  v.literal('fixed'),
  v.literal('percentage'),
  v.literal('host_approval'),
]);

const CreateBody = v.object({
  name: v.pipe(v.string(), v.nonEmpty()),
  qrSlug: v.optional(v.pipe(v.string(), v.nonEmpty())),
  guestCapOverride: v.optional(v.union([v.pipe(v.number(), v.integer(), v.minValue(1)), v.null()])),
  songsPerGuestCap: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  maxConsecutivePerGuest: v.optional(
    v.union([v.pipe(v.number(), v.integer(), v.minValue(1)), v.null()]),
  ),
  allowDuplicates: v.optional(v.boolean()),
  moderationEnabled: v.optional(v.boolean()),
  voteSkipMode: v.optional(VoteSkipMode),
  voteSkipThreshold: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
});

const UpdateBody = v.object({
  name: v.optional(v.pipe(v.string(), v.nonEmpty())),
  guestCapOverride: v.optional(v.union([v.pipe(v.number(), v.integer(), v.minValue(1)), v.null()])),
  songsPerGuestCap: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  maxConsecutivePerGuest: v.optional(
    v.union([v.pipe(v.number(), v.integer(), v.minValue(1)), v.null()]),
  ),
  allowDuplicates: v.optional(v.boolean()),
  moderationEnabled: v.optional(v.boolean()),
  voteSkipMode: v.optional(VoteSkipMode),
  voteSkipThreshold: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
});

function mapErrorToStatus(code: string): { status: number; payload: { error: string } } {
  switch (code) {
    case 'session_not_found':
      return { status: 404, payload: { error: code } };
    case 'qr_slug_taken':
    case 'session_ended':
      return { status: 409, payload: { error: code } };
    case 'account_mismatch':
      return { status: 403, payload: { error: code } };
    default:
      return { status: 400, payload: { error: code } };
  }
}

/**
 * UUID v4-ish shape — tightened to keep route handlers from passing
 * malformed strings to Postgres (which throws 500 instead of returning a
 * clean 404). The session ID column is `uuid`, so anything that isn't shaped
 * like a UUID definitely isn't a session.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function sessionRoutes(deps: SessionRouteDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();

  /** POST / — create a session in the caller's currentAccount. */
  app.post('/', requireClaim(deps.authService, 'session:create'), async (c) => {
    const auth = c.get('auth') as AuthContext;
    if (!auth.currentAccountId) return c.json({ error: 'no_active_account' }, 400);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_body' }, 400);
    }
    const parsed = v.safeParse(CreateBody, body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_body', issues: parsed.issues.map((i) => i.message) }, 400);
    }
    try {
      const session = await deps.sessionService.create({
        accountId: auth.currentAccountId,
        ...parsed.output,
      });
      void deps.audit?.record({
        sessionId: session.id,
        actorKind: 'host',
        actorId: auth.userId ?? null,
        actorLabel: 'Host',
        action: 'session.created',
        details: { name: session.name, qrSlug: session.qrSlug },
      });
      return c.json({ session }, 201);
    } catch (err) {
      if (err instanceof SessionServiceError) {
        const { status, payload } = mapErrorToStatus(err.code);
        return c.json(payload, status as 400 | 403 | 404 | 409);
      }
      throw err;
    }
  });

  /** GET /by-slug/:slug — public read for hydration from a QR-code slug. */
  app.get('/by-slug/:slug', async (c) => {
    const slug = c.req.param('slug') ?? '';
    try {
      const session = await deps.sessionService.getBySlug(slug);
      return c.json({ session });
    } catch (err) {
      if (err instanceof SessionServiceError) {
        const { status, payload } = mapErrorToStatus(err.code);
        return c.json(payload, status as 400 | 403 | 404 | 409);
      }
      throw err;
    }
  });

  /**
   * GET /by-slug/:slug/tv-snapshot — public, no auth.
   *
   * Used by the TV page (cast to a room screen). Returns enough state for an
   * initial fullscreen render without going through the WS handshake. The
   * realtime snapshot (when a room is live) is the source of truth for
   * `nowPlaying` + `recentlyPlayed`; falling back to empty values when the
   * room hasn't materialized (no guests connected yet).
   */
  app.get('/by-slug/:slug/tv-snapshot', async (c) => {
    const slug = c.req.param('slug') ?? '';
    let session;
    try {
      session = await deps.sessionService.getBySlug(slug);
    } catch (err) {
      if (err instanceof SessionServiceError) {
        const { status, payload } = mapErrorToStatus(err.code);
        return c.json(payload, status as 400 | 403 | 404 | 409);
      }
      throw err;
    }

    const room = deps.rooms?.forSession(session.id) ?? null;
    const snapshot = room ? await room.getSnapshot() : null;

    let queueSummaries: ReturnType<typeof toQueueItemSummary>[];
    if (snapshot && snapshot.queue.length > 0) {
      queueSummaries = [...snapshot.queue];
    } else if (deps.queueItems) {
      const items = await deps.queueItems.findAllForSession(session.id);
      queueSummaries = items
        .filter((i) => i.status === 'approved' || i.status === 'queued' || i.status === 'playing')
        .map(toQueueItemSummary);
    } else {
      queueSummaries = [];
    }

    let activeGuestCount = snapshot?.activeGuestCount ?? 0;
    if (deps.guestSlots && activeGuestCount === 0) {
      activeGuestCount = await deps.guestSlots.countByStatus(session.id, 'active');
    }

    return c.json({
      session,
      nowPlaying: snapshot?.nowPlaying ?? null,
      recentlyPlayed: snapshot?.recentlyPlayed ?? [],
      queue: queueSummaries,
      activeGuestCount,
    });
  });

  /** GET /:id — public read for hydration. */
  app.get('/:id', async (c) => {
    const id = c.req.param('id') ?? '';
    if (!UUID_RE.test(id)) return c.json({ error: 'session_not_found' }, 404);
    try {
      const session = await deps.sessionService.getById(id);
      return c.json({ session });
    } catch (err) {
      if (err instanceof SessionServiceError) {
        const { status, payload } = mapErrorToStatus(err.code);
        return c.json(payload, status as 400 | 403 | 404 | 409);
      }
      throw err;
    }
  });

  /** PATCH /:id — host updates settings. */
  app.patch('/:id', requireClaim(deps.authService, 'session:update'), async (c) => {
    const auth = c.get('auth') as AuthContext;
    if (!auth.currentAccountId) return c.json({ error: 'no_active_account' }, 400);
    const id = c.req.param('id') ?? '';
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_body' }, 400);
    }
    const parsed = v.safeParse(UpdateBody, body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_body' }, 400);
    }
    try {
      const session = await deps.sessionService.update({
        id,
        accountId: auth.currentAccountId,
        ...parsed.output,
      });
      void deps.audit?.record({
        sessionId: id,
        actorKind: 'host',
        actorId: auth.userId ?? null,
        actorLabel: 'Host',
        action: 'session.settings_updated',
        details: { changes: parsed.output },
      });
      return c.json({ session });
    } catch (err) {
      if (err instanceof SessionServiceError) {
        const { status, payload } = mapErrorToStatus(err.code);
        return c.json(payload, status as 400 | 403 | 404 | 409);
      }
      throw err;
    }
  });

  /** DELETE /:id — host ends the session. */
  app.delete('/:id', requireClaim(deps.authService, 'session:end'), async (c) => {
    const auth = c.get('auth') as AuthContext;
    if (!auth.currentAccountId) return c.json({ error: 'no_active_account' }, 400);
    const id = c.req.param('id') ?? '';
    try {
      const ended = await deps.sessionService.end(id, auth.currentAccountId);
      void deps.audit?.record({
        sessionId: id,
        actorKind: 'host',
        actorId: auth.userId ?? null,
        actorLabel: 'Host',
        action: 'session.ended',
      });
      return c.json({ session: ended });
    } catch (err) {
      if (err instanceof SessionServiceError) {
        const { status, payload } = mapErrorToStatus(err.code);
        return c.json(payload, status as 400 | 403 | 404 | 409);
      }
      throw err;
    }
  });

  /**
   * GET /:id/audit-log — host-facing audit log of every interesting
   * mutation against the session. Cookie session + `session:read`
   * claim. Newest-first; supports `?limit=` (max 500) and
   * `?before=<isoTimestamp>` for pagination.
   */
  app.get('/:id/audit-log', requireClaim(deps.authService, 'session:read'), async (c) => {
    const auth = c.get('auth') as AuthContext;
    if (!auth.currentAccountId) return c.json({ error: 'no_active_account' }, 400);
    const id = c.req.param('id') ?? '';
    if (!UUID_RE.test(id)) return c.json({ error: 'session_not_found' }, 404);
    if (!deps.audit) return c.json({ error: 'audit_log_not_configured' }, 501);
    // Verify caller owns this session.
    try {
      const session = await deps.sessionService.getById(id);
      if (session.accountId !== auth.currentAccountId) {
        return c.json({ error: 'account_mismatch' }, 403);
      }
    } catch (err) {
      if (err instanceof SessionServiceError) {
        const { status, payload } = mapErrorToStatus(err.code);
        return c.json(payload, status as 400 | 403 | 404 | 409);
      }
      throw err;
    }
    const limitParam = c.req.query('limit');
    const beforeParam = c.req.query('before');
    const limit = limitParam ? Math.min(500, Math.max(1, Number(limitParam))) : 200;
    const before = beforeParam ? new Date(beforeParam) : undefined;
    const events = await deps.audit.list(
      id,
      before && Number.isFinite(before.getTime()) ? { limit, before } : { limit },
    );
    return c.json({
      events: events.map((e) => ({
        id: e.id,
        sessionId: e.sessionId,
        actorKind: e.actorKind,
        actorId: e.actorId,
        actorLabel: e.actorLabel,
        action: e.action,
        details: e.details,
        createdAtEpochMs: e.createdAt.getTime(),
      })),
    });
  });

  /** GET / — list current account's sessions (host dashboard). */
  app.get('/', requireAuth(deps.authService), async (c) => {
    const auth = c.get('auth') as AuthContext;
    if (!auth.currentAccountId) return c.json({ error: 'no_active_account' }, 400);
    const sessions = await deps.sessionService.listForAccount(auth.currentAccountId);
    return c.json({ sessions });
  });

  return app;
}
