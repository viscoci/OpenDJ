/**
 * `/api/v1/lyrics/lookup` + `/api/v1/sessions/:id/lyrics/{current,feedback}` routes.
 *
 * Lookup is public — no auth required (lyrics enrich the experience and
 * shouldn't gate the request page). Feedback is open to any guest of the
 * session via slot token; logged-in guests + hosts get richer attribution.
 */

import { Hono } from 'hono';
import * as v from 'valibot';
import type { LyricsFeedbackKind } from '@opendj/lyrics';
import type { AuthVariables } from '../auth/middleware.js';
import { LyricsLookupService } from '../lyrics/LyricsLookupService.js';
import type { GuestSlotRepository, GuestRepository } from '../repositories/types.js';

export interface LyricsRouteDeps {
  lyricsLookup: LyricsLookupService;
  guestSlots: GuestSlotRepository;
  guests: GuestRepository;
}

const LookupQuery = v.object({
  trackName: v.pipe(v.string(), v.nonEmpty()),
  artistName: v.pipe(v.string(), v.nonEmpty()),
  albumName: v.optional(v.pipe(v.string(), v.nonEmpty())),
  durationMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  providerTrackUri: v.optional(v.pipe(v.string(), v.nonEmpty())),
});

const FEEDBACK_KINDS = new Set<LyricsFeedbackKind>([
  'wrong_song',
  'bad_timing',
  'wrong_line',
  'missing_lyrics',
  'offensive_or_bad_content',
  'other',
]);

const FeedbackBody = v.object({
  kind: v.pipe(
    v.string(),
    v.check((s): s is LyricsFeedbackKind => FEEDBACK_KINDS.has(s as LyricsFeedbackKind)),
  ),
  lyricsDocumentId: v.optional(v.pipe(v.string(), v.nonEmpty())),
  trackUri: v.optional(v.pipe(v.string(), v.nonEmpty())),
  lineId: v.optional(v.pipe(v.string(), v.nonEmpty())),
  comment: v.optional(v.pipe(v.string(), v.maxLength(2000))),
});

function bearerFromAuthHeader(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m ? m[1]!.trim() : null;
}

export function lyricsRoutes(deps: LyricsRouteDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();

  /**
   * GET /lookup — public lyrics lookup. Always returns 200; the body's
   * `match` is null when lyrics are unavailable (silent failure per brief).
   */
  app.get('/lookup', async (c) => {
    const raw: Record<string, unknown> = {
      trackName: c.req.query('trackName'),
      artistName: c.req.query('artistName'),
    };
    const albumName = c.req.query('albumName');
    if (albumName) raw['albumName'] = albumName;
    const durationParam = c.req.query('durationMs');
    if (durationParam) {
      const parsed = Number.parseInt(durationParam, 10);
      if (Number.isFinite(parsed)) raw['durationMs'] = parsed;
    }
    const providerTrackUri = c.req.query('providerTrackUri');
    if (providerTrackUri) raw['providerTrackUri'] = providerTrackUri;

    const parsed = v.safeParse(LookupQuery, raw);
    if (!parsed.success) {
      return c.json({ error: 'invalid_query', issues: parsed.issues.map((i) => i.message) }, 400);
    }
    const document = await deps.lyricsLookup.lookup({
      trackName: parsed.output.trackName,
      artistName: parsed.output.artistName,
      ...(parsed.output.albumName !== undefined && { albumName: parsed.output.albumName }),
      ...(parsed.output.durationMs !== undefined && { durationMs: parsed.output.durationMs }),
      ...(parsed.output.providerTrackUri !== undefined && {
        providerTrackUri: parsed.output.providerTrackUri,
      }),
    });
    return c.json({ match: document });
  });

  return app;
}

/**
 * Session-scoped lyrics routes mounted at `/api/v1/sessions/:id/lyrics/*`.
 * Split out so the public `/lookup` doesn't need session repos.
 */
export function sessionLyricsRoutes(deps: LyricsRouteDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();

  /** GET /current — returns the current track's cached lyrics, if any. */
  app.get('/current', async (c) => {
    // The "current track" is whatever the realtime room reports as `nowPlaying`.
    // Until the WS slice wires room introspection, this route is intentionally
    // a thin pass-through to /lookup using ?trackName + ?artistName query params.
    const trackName = c.req.query('trackName');
    const artistName = c.req.query('artistName');
    if (!trackName || !artistName) {
      return c.json({ error: 'missing_track_metadata' }, 400);
    }
    const document = await deps.lyricsLookup.lookup({ trackName, artistName });
    return c.json({ match: document });
  });

  /** POST /feedback — record a lyrics report. */
  app.post('/feedback', async (c) => {
    const slotToken = bearerFromAuthHeader(c.req.header('authorization'));
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_body' }, 400);
    }
    const parsed = v.safeParse(FeedbackBody, body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_body', issues: parsed.issues.map((i) => i.message) }, 400);
    }
    const sessionId = c.req.param('id') ?? '';
    let guestId: string | null = null;
    if (slotToken) {
      const slot = await deps.guestSlots.findBySlotToken(slotToken);
      if (slot && slot.sessionId === sessionId) {
        const guest = await deps.guests.findBySessionAndFingerprint(
          sessionId,
          slot.fingerprintHash,
        );
        guestId = guest?.id ?? null;
      }
    }
    const created = await deps.lyricsLookup.recordFeedback({
      sessionId,
      kind: parsed.output.kind as LyricsFeedbackKind,
      ...(guestId !== null && { guestId }),
      ...(parsed.output.lyricsDocumentId !== undefined && {
        lyricsDocumentId: parsed.output.lyricsDocumentId,
      }),
      ...(parsed.output.trackUri !== undefined && { trackUri: parsed.output.trackUri }),
      ...(parsed.output.lineId !== undefined && { lineId: parsed.output.lineId }),
      ...(parsed.output.comment !== undefined && { comment: parsed.output.comment }),
    });
    return c.json({ id: created.id, kind: created.kind });
  });

  return app;
}
