/**
 * `POST /api/v1/sessions/:id/playback/{skip,pause,resume}` — host playback
 * control routes. Each proxies to the session's connected streaming
 * provider, gated by the `provider:control_playback` claim already held by
 * `owner` / `admin` / `host` memberships.
 *
 * Status codes mirror the search route conventions so the frontend has one
 * mental model:
 * - 401 unauthenticated / 403 missing claim — handled by middleware.
 * - 404 `session_not_found` / `session_ended`.
 * - 503 `no_provider_connected` — host hasn't linked Spotify yet.
 * - 501 `playback_*_not_supported` — provider doesn't implement the action
 *   (e.g. a search-only adapter). Type-guard short-circuits before any call.
 * - 502 `provider_error` — provider call failed (network, 4xx/5xx from Spotify).
 *
 * Errors do NOT include the underlying provider message verbatim — keeps
 * Spotify HTTP details from leaking via OSS deploys.
 */

import { Hono, type Context } from 'hono';
import {
  InvalidProviderCredentialsError,
  supportsPause,
  supportsResume,
  supportsSkipTrack,
  type IStreamingProvider,
} from '@opendj/core';
import type { AuthService } from '../auth/AuthService.js';
import { requireClaim, type AuthVariables } from '../auth/middleware.js';
import {
  ProviderConnectionNotFoundError,
  StreamingRouter,
  UnknownProviderError,
} from '../providers/streaming/StreamingRouter.js';
import type { ProviderConnectionRepository, SessionRepository } from '../repositories/types.js';

export interface PlaybackRouteDeps {
  authService: AuthService;
  sessions: SessionRepository;
  providerConnections: ProviderConnectionRepository;
  streamingRouter: StreamingRouter;
}

type PlaybackAction = 'skip' | 'pause' | 'resume';

interface ResolvedProvider {
  provider: IStreamingProvider;
  providerId: string;
}

interface RouteFailure {
  status: 404 | 501 | 502 | 503;
  payload: { error: string; providerId?: string };
}

async function resolveProviderFor(
  deps: PlaybackRouteDeps,
  sessionId: string,
): Promise<ResolvedProvider | RouteFailure> {
  const session = await deps.sessions.findById(sessionId);
  if (!session) return { status: 404, payload: { error: 'session_not_found' } };
  if (session.endedAt) return { status: 404, payload: { error: 'session_ended' } };

  const connections = await deps.providerConnections.findAllForAccount(session.accountId);
  const connection = connections[0];
  if (!connection) return { status: 503, payload: { error: 'no_provider_connected' } };

  try {
    const provider = await deps.streamingRouter.getProvider(
      session.accountId,
      connection.providerId,
    );
    return { provider, providerId: connection.providerId };
  } catch (err) {
    if (err instanceof UnknownProviderError) {
      return {
        status: 502,
        payload: { error: 'unknown_provider', providerId: connection.providerId },
      };
    }
    if (err instanceof ProviderConnectionNotFoundError) {
      return { status: 503, payload: { error: 'no_provider_connected' } };
    }
    if (err instanceof InvalidProviderCredentialsError) {
      return { status: 502, payload: { error: 'provider_credentials_invalid' } };
    }
    throw err;
  }
}

function isFailure(value: ResolvedProvider | RouteFailure): value is RouteFailure {
  return 'status' in value;
}

export function playbackRoutes(deps: PlaybackRouteDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const guard = requireClaim(deps.authService, 'provider:control_playback');

  async function runAction(c: Context<{ Variables: AuthVariables }>, action: PlaybackAction) {
    const sessionId = c.req.param('id') ?? '';
    const resolved = await resolveProviderFor(deps, sessionId);
    if (isFailure(resolved)) {
      return c.json(resolved.payload, resolved.status);
    }
    const { provider, providerId } = resolved;

    try {
      if (action === 'skip') {
        if (!supportsSkipTrack(provider)) {
          return c.json({ error: 'playback_skip_not_supported', providerId }, 501);
        }
        await provider.skipTrack();
      } else if (action === 'pause') {
        if (!supportsPause(provider)) {
          return c.json({ error: 'playback_pause_not_supported', providerId }, 501);
        }
        await provider.pause();
      } else {
        if (!supportsResume(provider)) {
          return c.json({ error: 'playback_resume_not_supported', providerId }, 501);
        }
        await provider.resume();
      }
      return c.json({ ok: true }, 200);
    } catch (err) {
      return c.json(
        {
          error: 'provider_error',
          providerId,
          message: (err as Error).message,
        },
        502,
      );
    }
  }

  app.post('/skip', guard, (c) => runAction(c, 'skip'));
  app.post('/pause', guard, (c) => runAction(c, 'pause'));
  app.post('/resume', guard, (c) => runAction(c, 'resume'));

  return app;
}
