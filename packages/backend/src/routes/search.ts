/**
 * `/api/v1/sessions/:id/search` — track search proxied through the session's
 * connected streaming provider.
 *
 * Public (no auth required) — guests need to search to make requests. The
 * route resolves the session, looks up the account's connected provider,
 * type-guards for `ISupportsSearch`, and forwards the query.
 *
 * Errors:
 * - 404 `session_not_found` / `session_ended`
 * - 503 `no_provider_connected` — account has no streaming provider linked yet
 * - 501 `search_not_supported` — provider connected, but doesn't implement search
 *   (e.g. AppleMusic stub) — type guard prevents the call from happening
 * - 502 `provider_error` — search failed at the provider edge
 */

import { Hono } from 'hono';
import * as v from 'valibot';
import { InvalidProviderCredentialsError, supportsSearch, type Track } from '@opendj/core';
import {
  ProviderConnectionNotFoundError,
  StreamingRouter,
  UnknownProviderError,
} from '../providers/streaming/StreamingRouter.js';
import type { ProviderConnectionRepository, SessionRepository } from '../repositories/types.js';

export interface SearchRouteDeps {
  sessions: SessionRepository;
  providerConnections: ProviderConnectionRepository;
  streamingRouter: StreamingRouter;
}

const QuerySchema = v.object({
  q: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(50))),
});

export interface SearchResultDto {
  trackUri: string;
  trackName: string;
  artistName: string;
  albumArtUrl: string | null;
  durationMs: number | null;
}

function toDto(track: Track): SearchResultDto {
  return {
    trackUri: track.uri,
    trackName: track.name,
    artistName: track.artist,
    albumArtUrl: track.albumArt,
    durationMs: track.durationMs,
  };
}

export function searchRoutes(deps: SearchRouteDeps): Hono {
  const app = new Hono();

  app.get('/', async (c) => {
    const sessionId = c.req.param('id') ?? '';
    const session = await deps.sessions.findById(sessionId);
    if (!session) return c.json({ error: 'session_not_found' }, 404);
    if (session.endedAt) return c.json({ error: 'session_ended' }, 404);

    const limitRaw = c.req.query('limit');
    const parsed = v.safeParse(QuerySchema, {
      q: c.req.query('q') ?? '',
      ...(limitRaw !== undefined && { limit: Number.parseInt(limitRaw, 10) }),
    });
    if (!parsed.success) {
      return c.json({ error: 'invalid_query', issues: parsed.issues.map((i) => i.message) }, 400);
    }

    // Pick any connection on the account — first match wins. A future
    // multi-provider preference order lives here.
    const connections = await deps.providerConnections.findAllForAccount(session.accountId);
    const connection = connections[0];
    if (!connection) return c.json({ error: 'no_provider_connected' }, 503);

    let provider;
    try {
      provider = await deps.streamingRouter.getProvider(session.accountId, connection.providerId);
    } catch (err) {
      if (err instanceof UnknownProviderError) {
        return c.json({ error: 'unknown_provider', providerId: connection.providerId }, 502);
      }
      if (err instanceof ProviderConnectionNotFoundError) {
        return c.json({ error: 'no_provider_connected' }, 503);
      }
      if (err instanceof InvalidProviderCredentialsError) {
        return c.json({ error: 'provider_credentials_invalid' }, 502);
      }
      throw err;
    }

    if (!supportsSearch(provider)) {
      return c.json({ error: 'search_not_supported', providerId: connection.providerId }, 501);
    }

    try {
      const tracks = await provider.search(parsed.output.q, parsed.output.limit ?? 20);
      return c.json({
        results: tracks.map(toDto),
        providerId: connection.providerId,
      });
    } catch (err) {
      return c.json(
        {
          error: 'provider_error',
          providerId: connection.providerId,
          message: (err as Error).message,
        },
        502,
      );
    }
  });

  return app;
}
