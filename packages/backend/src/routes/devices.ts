/**
 * `GET /api/v1/sessions/:id/devices` — list playback devices the host's
 * connected provider sees.
 * `POST /api/v1/sessions/:id/devices/:deviceId/activate` — transfer
 * playback to a specific device.
 *
 * Both gated by `provider:control_playback`. Status codes mirror the search
 * + playback routes:
 *   401 / 403 — middleware
 *   404 session_not_found / session_ended
 *   503 no_provider_connected
 *   501 devices_not_supported
 *   502 provider_error
 */

import { Hono } from 'hono';
import {
  InvalidProviderCredentialsError,
  supportsDevices,
  type IStreamingProvider,
} from '@opendj/core';
import * as v from 'valibot';
import type { AuthService } from '../auth/AuthService.js';
import { requireClaim, type AuthVariables } from '../auth/middleware.js';
import {
  ProviderConnectionNotFoundError,
  StreamingRouter,
  UnknownProviderError,
} from '../providers/streaming/StreamingRouter.js';
import type { ProviderConnectionRepository, SessionRepository } from '../repositories/types.js';

export interface DeviceRouteDeps {
  authService: AuthService;
  sessions: SessionRepository;
  providerConnections: ProviderConnectionRepository;
  streamingRouter: StreamingRouter;
}

interface ResolvedProvider {
  provider: IStreamingProvider;
  providerId: string;
}

interface RouteFailure {
  status: 404 | 501 | 502 | 503;
  payload: { error: string; providerId?: string };
}

async function resolveProviderFor(
  deps: DeviceRouteDeps,
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

const ActivateBody = v.object({
  play: v.optional(v.boolean()),
});

export function deviceRoutes(deps: DeviceRouteDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const guard = requireClaim(deps.authService, 'provider:control_playback');

  app.get('/', guard, async (c) => {
    const sessionId = c.req.param('id') ?? '';
    const resolved = await resolveProviderFor(deps, sessionId);
    if (isFailure(resolved)) return c.json(resolved.payload, resolved.status);
    const { provider, providerId } = resolved;

    if (!supportsDevices(provider)) {
      return c.json({ error: 'devices_not_supported', providerId }, 501);
    }

    try {
      const devices = await provider.getDevices();
      return c.json({ devices, providerId });
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
  });

  app.post('/:deviceId/activate', guard, async (c) => {
    const sessionId = c.req.param('id') ?? '';
    const deviceId = c.req.param('deviceId') ?? '';
    if (!deviceId) return c.json({ error: 'invalid_device_id' }, 400);

    let body: unknown = {};
    if (c.req.header('content-type')?.includes('application/json')) {
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'invalid_body' }, 400);
      }
    }
    const parsed = v.safeParse(ActivateBody, body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_body' }, 400);
    }

    const resolved = await resolveProviderFor(deps, sessionId);
    if (isFailure(resolved)) return c.json(resolved.payload, resolved.status);
    const { provider, providerId } = resolved;

    if (!supportsDevices(provider)) {
      return c.json({ error: 'devices_not_supported', providerId }, 501);
    }

    try {
      await provider.transferPlayback(
        deviceId,
        parsed.output.play !== undefined ? { play: parsed.output.play } : {},
      );
      return c.json({ ok: true, providerId, deviceId }, 200);
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
  });

  return app;
}
