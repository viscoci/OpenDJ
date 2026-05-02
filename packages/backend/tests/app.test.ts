import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import { createDeps } from '../src/deps.js';
import { createInMemoryRepositories } from '../src/repositories/in-memory/index.js';

function fakeConfig(overrides: Partial<Config> = {}): Config {
  return {
    databaseUrl: 'postgres://localhost/test',
    baseUrl: 'http://localhost:8888',
    maxSongsPerGuest: 3,
    maxGuestsPerSession: null,
    moderationEnabledDefault: false,
    ...overrides,
  };
}

function buildApp(opts: { config?: Config } = {}) {
  const deps = createDeps({
    config: opts.config ?? fakeConfig(),
    repositories: createInMemoryRepositories(),
  });
  return createApp({ deps });
}

describe('createApp — versioning + 404s', () => {
  it('mounts /api/v1/health', async () => {
    const app = buildApp();
    const response = await app.request('/api/v1/health');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; service: string };
    expect(body).toEqual({ ok: true, service: 'opendj-backend' });
  });

  it('returns 404 for unknown /api/v1 routes', async () => {
    const app = buildApp();
    const response = await app.request('/api/v1/does-not-exist');
    expect(response.status).toBe(404);
  });

  it('does NOT expose health at root (versioned API only)', async () => {
    const app = buildApp();
    const response = await app.request('/health');
    expect(response.status).toBe(404);
  });
});

describe('createApp — route mounting', () => {
  it('exposes /api/v1/auth/me (requires auth → 401 unauthenticated)', async () => {
    const app = buildApp();
    const res = await app.request('/api/v1/auth/me');
    expect(res.status).toBe(401);
  });

  it('exposes /api/v1/guest/identity (POST validation → 400 on empty body)', async () => {
    const app = buildApp();
    const res = await app.request('/api/v1/guest/identity', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(400);
  });

  it('exposes /api/v1/sessions/:id (404 for unknown)', async () => {
    const app = buildApp();
    const res = await app.request('/api/v1/sessions/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
  });

  it('exposes /api/v1/provider/connections/:provider/start (401 without auth)', async () => {
    const app = buildApp();
    const res = await app.request('/api/v1/provider/connections/spotify/start');
    expect(res.status).toBe(401);
  });
});

describe('createDeps — wiring', () => {
  it('throws when neither db nor repositories is supplied', () => {
    expect(() => createDeps({ config: fakeConfig() })).toThrow(/repositories/);
  });

  it('passes through Spotify config when present', async () => {
    const app = buildApp({
      config: fakeConfig({
        spotify: {
          clientId: 'cid',
          clientSecret: 'csec',
          redirectUri: 'http://localhost:8888/cb',
        },
      }),
    });
    // Without auth the start route still 401s; we just want to verify the route is mounted.
    const res = await app.request('/api/v1/provider/connections/spotify/start');
    expect(res.status).toBe(401);
  });
});
