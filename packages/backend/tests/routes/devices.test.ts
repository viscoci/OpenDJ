/**
 * device routes — list + activate, gated by provider:control_playback.
 */

import {
  defineCapabilities,
  PROVIDER_FEATURES,
  type IStreamingProvider,
  type PlaybackDevice,
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
import { deviceRoutes } from '../../src/routes/devices.js';

const NOW = new Date('2026-05-04T12:00:00Z').getTime();
const ACCOUNT_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';

interface ProviderControl {
  getDevices: ReturnType<typeof vi.fn>;
  transferPlayback: ReturnType<typeof vi.fn>;
}

function makeProvider(opts: {
  features?: Record<string, ProviderFeatureDescriptor>;
  devices?: PlaybackDevice[];
  shouldThrow?: { method: 'getDevices' | 'transferPlayback'; err: Error };
}): { provider: IStreamingProvider; control: ProviderControl } {
  const getDevices = vi.fn(async () => {
    if (opts.shouldThrow?.method === 'getDevices') throw opts.shouldThrow.err;
    return opts.devices ?? [];
  });
  const transferPlayback = vi.fn(async (_id: string, _o: { play?: boolean } = {}) => {
    if (opts.shouldThrow?.method === 'transferPlayback') throw opts.shouldThrow.err;
  });

  const features = opts.features ?? {
    [PROVIDER_FEATURES.DevicesRead]: {
      id: PROVIDER_FEATURES.DevicesRead,
      supported: true,
      access: 'host',
      reliability: 'native',
    },
    [PROVIDER_FEATURES.DeviceTransferPlayback]: {
      id: PROVIDER_FEATURES.DeviceTransferPlayback,
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
    getDevices,
    transferPlayback,
  } as IStreamingProvider;

  return { provider, control: { getDevices, transferPlayback } };
}

interface SetupOpts {
  withConnection?: boolean;
  withSession?: boolean;
  features?: Record<string, ProviderFeatureDescriptor>;
  devices?: PlaybackDevice[];
  shouldThrow?: { method: 'getDevices' | 'transferPlayback'; err: Error };
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
    ...(opts.devices !== undefined && { devices: opts.devices }),
    ...(opts.shouldThrow !== undefined && { shouldThrow: opts.shouldThrow }),
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
  app.route(
    '/sessions/:id/devices',
    deviceRoutes({
      authService,
      sessions,
      providerConnections,
      streamingRouter,
    }),
  );

  return { app, authService, sessionId, control };
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

const SAMPLE_DEVICES: PlaybackDevice[] = [
  {
    id: 'd-laptop',
    name: 'Studio MBP',
    type: 'computer',
    isActive: true,
    volumePercent: 60,
    isRestricted: false,
  },
  {
    id: 'd-speaker',
    name: 'Kitchen Sonos',
    type: 'speaker',
    isActive: false,
    volumePercent: 30,
    isRestricted: false,
  },
];

describe('GET /sessions/:id/devices', () => {
  it('401 without a session', async () => {
    const { app, sessionId } = await setup();
    const res = await app.request(`/sessions/${sessionId}/devices`);
    expect(res.status).toBe(401);
  });

  it('403 missing claim', async () => {
    const { app, authService, sessionId } = await setup();
    const cookie = await login(authService, ['account:read']);
    const res = await app.request(`/sessions/${sessionId}/devices`, { headers: { cookie } });
    expect(res.status).toBe(403);
  });

  it('503 when no provider linked', async () => {
    const { app, authService, sessionId } = await setup({ withConnection: false });
    const cookie = await login(authService);
    const res = await app.request(`/sessions/${sessionId}/devices`, { headers: { cookie } });
    expect(res.status).toBe(503);
  });

  it('501 when provider does not support devices', async () => {
    const { app, authService, sessionId } = await setup({ features: {} });
    const cookie = await login(authService);
    const res = await app.request(`/sessions/${sessionId}/devices`, { headers: { cookie } });
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: string; providerId?: string };
    expect(body.error).toBe('devices_not_supported');
  });

  it('200 returns the device list', async () => {
    const { app, authService, sessionId } = await setup({ devices: SAMPLE_DEVICES });
    const cookie = await login(authService);
    const res = await app.request(`/sessions/${sessionId}/devices`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { devices: PlaybackDevice[]; providerId: string };
    expect(body.devices).toEqual(SAMPLE_DEVICES);
    expect(body.providerId).toBe('spotify');
  });

  it('502 when provider throws', async () => {
    const { app, authService, sessionId } = await setup({
      shouldThrow: { method: 'getDevices', err: new Error('Spotify dead') },
    });
    const cookie = await login(authService);
    const res = await app.request(`/sessions/${sessionId}/devices`, { headers: { cookie } });
    expect(res.status).toBe(502);
  });
});

describe('POST /sessions/:id/devices/:deviceId/activate', () => {
  it('401 without session', async () => {
    const { app, sessionId } = await setup();
    const res = await app.request(`/sessions/${sessionId}/devices/d-1/activate`, {
      method: 'POST',
    });
    expect(res.status).toBe(401);
  });

  it('200 invokes transferPlayback with default play=false', async () => {
    const { app, authService, sessionId, control } = await setup({ devices: SAMPLE_DEVICES });
    const cookie = await login(authService);
    const res = await app.request(`/sessions/${sessionId}/devices/d-speaker/activate`, {
      method: 'POST',
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    expect(control.transferPlayback).toHaveBeenCalledWith('d-speaker', {});
  });

  it('200 forwards play=true when requested', async () => {
    const { app, authService, sessionId, control } = await setup({ devices: SAMPLE_DEVICES });
    const cookie = await login(authService);
    const res = await app.request(`/sessions/${sessionId}/devices/d-speaker/activate`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ play: true }),
    });
    expect(res.status).toBe(200);
    expect(control.transferPlayback).toHaveBeenCalledWith('d-speaker', { play: true });
  });

  it('503 when no provider', async () => {
    const { app, authService, sessionId } = await setup({ withConnection: false });
    const cookie = await login(authService);
    const res = await app.request(`/sessions/${sessionId}/devices/d-1/activate`, {
      method: 'POST',
      headers: { cookie },
    });
    expect(res.status).toBe(503);
  });

  it('502 when provider throws', async () => {
    const { app, authService, sessionId } = await setup({
      shouldThrow: { method: 'transferPlayback', err: new Error('boom') },
    });
    const cookie = await login(authService);
    const res = await app.request(`/sessions/${sessionId}/devices/d-1/activate`, {
      method: 'POST',
      headers: { cookie },
    });
    expect(res.status).toBe(502);
  });
});
