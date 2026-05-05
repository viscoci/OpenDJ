/**
 * playback routes — skip/pause/resume proxy through the connected provider.
 *
 * Covered:
 * - 401 unauth
 * - 403 missing claim
 * - 404 session not found / ended
 * - 503 no provider connected
 * - 501 capability not supported
 * - 502 provider throws
 * - 200 happy path actually invoked the provider method
 */

import {
  defineCapabilities,
  PROVIDER_FEATURES,
  type IStreamingProvider,
  type ProviderFeatureDescriptor,
} from '@opendj/core';
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { AuthService, SESSION_COOKIE_NAME } from '../../src/auth/AuthService.js';
import { ClaimsService } from '../../src/auth/ClaimsService.js';
import type { AuthVariables } from '../../src/auth/middleware.js';
import { StreamingRouter } from '../../src/providers/streaming/StreamingRouter.js';
import {
  InMemoryAccountRepository,
  InMemoryAuthSessionRepository,
  InMemoryMembershipRepository,
  InMemoryProviderConnectionRepository,
  InMemorySessionRepository,
} from '../../src/repositories/in-memory/index.js';
import type { ProviderRegistry } from '../../src/providers/streaming/providerRegistry.js';
import { playbackRoutes } from '../../src/routes/playback.js';

const NOW = new Date('2026-05-04T12:00:00Z').getTime();
const ACCOUNT_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';

interface ProviderControl {
  skip: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
}

function makeProvider(opts: {
  features?: Record<string, ProviderFeatureDescriptor>;
  shouldThrow?: { method: 'skipTrack' | 'pause' | 'resume'; err: Error } | null;
}): { provider: IStreamingProvider; control: ProviderControl } {
  const skip = vi.fn(async () => {
    if (opts.shouldThrow?.method === 'skipTrack') throw opts.shouldThrow.err;
  });
  const pause = vi.fn(async () => {
    if (opts.shouldThrow?.method === 'pause') throw opts.shouldThrow.err;
  });
  const resume = vi.fn(async () => {
    if (opts.shouldThrow?.method === 'resume') throw opts.shouldThrow.err;
  });

  const features = opts.features ?? {
    [PROVIDER_FEATURES.SkipTrack]: {
      id: PROVIDER_FEATURES.SkipTrack,
      supported: true,
      access: 'host',
      reliability: 'native',
    },
    [PROVIDER_FEATURES.Pause]: {
      id: PROVIDER_FEATURES.Pause,
      supported: true,
      access: 'host',
      reliability: 'native',
    },
    [PROVIDER_FEATURES.Resume]: {
      id: PROVIDER_FEATURES.Resume,
      supported: true,
      access: 'host',
      reliability: 'native',
    },
  };

  const provider: IStreamingProvider = {
    providerId: 'spotify',
    displayName: 'Spotify',
    async connect() {},
    async disconnect() {},
    isConnected() {
      return true;
    },
    async refreshCredentials() {
      return {};
    },
    getCapabilities() {
      return defineCapabilities('spotify', features);
    },
    skipTrack: skip,
    pause,
    resume,
  } as IStreamingProvider;

  return { provider, control: { skip, pause, resume } };
}

interface SetupOpts {
  withConnection?: boolean;
  withSession?: boolean;
  features?: Record<string, ProviderFeatureDescriptor>;
  sessionEnded?: boolean;
  shouldThrow?: { method: 'skipTrack' | 'pause' | 'resume'; err: Error };
}

async function setup(opts: SetupOpts = {}) {
  const clock = { now: () => new Date(NOW) };
  const accounts = new InMemoryAccountRepository();
  const memberships = new InMemoryMembershipRepository();
  const authSessions = new InMemoryAuthSessionRepository(clock);
  const sessions = new InMemorySessionRepository();
  const providerConnections = new InMemoryProviderConnectionRepository(clock);
  const claims = new ClaimsService({ memberships, accounts });
  const authService = new AuthService({ authSessions, claims });

  accounts.seed({
    id: ACCOUNT_ID,
    displayName: 'A',
    slug: 'a',
    plan: 'free',
    createdAt: new Date(NOW),
  });

  memberships.seed({
    accountId: ACCOUNT_ID,
    userId: USER_ID,
    status: 'active',
    role: 'host',
    claims: ['provider:control_playback'],
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
  });

  let sessionId = '00000000-0000-0000-0000-000000000000';
  if (opts.withSession !== false) {
    const created = await sessions.create({
      accountId: ACCOUNT_ID,
      name: 'Demo',
      qrSlug: 'demo',
    });
    sessionId = created.id;
    if (opts.sessionEnded) {
      await sessions.end(sessionId, new Date(NOW + 60_000));
    }
  }

  if (opts.withConnection !== false) {
    await providerConnections.upsert({
      accountId: ACCOUNT_ID,
      providerId: 'spotify',
      accessToken: 'tok',
    });
  }

  const { provider, control } = makeProvider({
    ...(opts.features !== undefined && { features: opts.features }),
    shouldThrow: opts.shouldThrow ?? null,
  });
  const registry: ProviderRegistry = {
    spotify: () => provider,
  } as ProviderRegistry;
  const streamingRouter = new StreamingRouter({
    providerConnections,
    registry,
    context: { fetch: globalThis.fetch },
  });

  const app = new Hono<{ Variables: AuthVariables }>();
  // Mount at the same shape as production (`/sessions/:id/playback`) so
  // `c.req.param('id')` resolves to the session UUID.
  app.route(
    '/sessions/:id/playback',
    playbackRoutes({
      authService,
      sessions,
      providerConnections,
      streamingRouter,
    }),
  );

  function url(action: 'skip' | 'pause' | 'resume', id = sessionId) {
    return `/sessions/${id}/playback/${action}`;
  }

  return { app, authService, sessionId, control, url };
}

async function login(authService: AuthService, claims: string[] = ['provider:control_playback']) {
  const issued = await authService.issueSession({
    userId: USER_ID,
    currentAccountId: ACCOUNT_ID,
    claimsSnapshot: claims as Parameters<typeof authService.issueSession>[0]['claimsSnapshot'],
    nowEpochMs: NOW,
  });
  return `${SESSION_COOKIE_NAME}=${issued.token}`;
}

describe('POST /sessions/:id/playback/{skip,pause,resume}', () => {
  it.each(['skip', 'pause', 'resume'] as const)(
    'returns 401 without a session — %s',
    async (action) => {
      const { app, url } = await setup();
      const res = await app.request(url(action), { method: 'POST' });
      expect(res.status).toBe(401);
    },
  );

  it('returns 403 without provider:control_playback claim', async () => {
    const { app, authService, url } = await setup();
    const cookie = await login(authService, ['account:read']);
    const res = await app.request(url('skip'), {
      method: 'POST',
      headers: { cookie },
    });
    expect(res.status).toBe(403);
  });

  it('returns 404 session_not_found for an unknown UUID', async () => {
    const { app, authService, url } = await setup();
    const cookie = await login(authService);
    const res = await app.request(url('skip', '99999999-9999-9999-9999-999999999999'), {
      method: 'POST',
      headers: { cookie },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'session_not_found' });
  });

  it('returns 404 session_ended for a closed session', async () => {
    const { app, authService, url } = await setup({ sessionEnded: true });
    const cookie = await login(authService);
    const res = await app.request(url('skip'), {
      method: 'POST',
      headers: { cookie },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'session_ended' });
  });

  it('returns 503 no_provider_connected when no provider linked', async () => {
    const { app, authService, url } = await setup({ withConnection: false });
    const cookie = await login(authService);
    const res = await app.request(url('skip'), {
      method: 'POST',
      headers: { cookie },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'no_provider_connected' });
  });

  it('returns 501 when provider does not support skip', async () => {
    const { app, authService, url } = await setup({
      features: {
        [PROVIDER_FEATURES.Pause]: {
          id: PROVIDER_FEATURES.Pause,
          supported: true,
          access: 'host',
          reliability: 'native',
        },
        [PROVIDER_FEATURES.Resume]: {
          id: PROVIDER_FEATURES.Resume,
          supported: true,
          access: 'host',
          reliability: 'native',
        },
      },
    });
    const cookie = await login(authService);
    const res = await app.request(url('skip'), {
      method: 'POST',
      headers: { cookie },
    });
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: string; providerId?: string };
    expect(body.error).toBe('playback_skip_not_supported');
    expect(body.providerId).toBe('spotify');
  });

  it('200 + invokes provider.skipTrack on success', async () => {
    const { app, authService, control, url } = await setup();
    const cookie = await login(authService);
    const res = await app.request(url('skip'), {
      method: 'POST',
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(control.skip).toHaveBeenCalledTimes(1);
    expect(control.pause).not.toHaveBeenCalled();
    expect(control.resume).not.toHaveBeenCalled();
  });

  it('200 + invokes provider.pause on /pause', async () => {
    const { app, authService, control, url } = await setup();
    const cookie = await login(authService);
    const res = await app.request(url('pause'), {
      method: 'POST',
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    expect(control.pause).toHaveBeenCalledTimes(1);
  });

  it('200 + invokes provider.resume on /resume', async () => {
    const { app, authService, control, url } = await setup();
    const cookie = await login(authService);
    const res = await app.request(url('resume'), {
      method: 'POST',
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    expect(control.resume).toHaveBeenCalledTimes(1);
  });

  it('502 when provider throws', async () => {
    const { app, authService, url } = await setup({
      shouldThrow: { method: 'skipTrack', err: new Error('Spotify exploded') },
    });
    const cookie = await login(authService);
    const res = await app.request(url('skip'), {
      method: 'POST',
      headers: { cookie },
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; providerId?: string };
    expect(body.error).toBe('provider_error');
    expect(body.providerId).toBe('spotify');
  });
});
