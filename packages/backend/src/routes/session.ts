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
import { SessionService, SessionServiceError } from '../session/SessionService.js';

export interface SessionRouteDeps {
  authService: AuthService;
  sessionService: SessionService;
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
  moderationEnabled: v.optional(v.boolean()),
  voteSkipMode: v.optional(VoteSkipMode),
  voteSkipThreshold: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
});

const UpdateBody = v.object({
  name: v.optional(v.pipe(v.string(), v.nonEmpty())),
  guestCapOverride: v.optional(v.union([v.pipe(v.number(), v.integer(), v.minValue(1)), v.null()])),
  songsPerGuestCap: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
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
      return c.json({ session: ended });
    } catch (err) {
      if (err instanceof SessionServiceError) {
        const { status, payload } = mapErrorToStatus(err.code);
        return c.json(payload, status as 400 | 403 | 404 | 409);
      }
      throw err;
    }
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
