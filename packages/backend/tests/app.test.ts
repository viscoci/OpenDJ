import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { AppDeps } from '../src/deps.js';
import type { Config } from '../src/config.js';

function fakeDeps(): AppDeps {
  const config: Config = {
    databaseUrl: 'postgres://localhost/test',
    baseUrl: 'http://localhost:8888',
    maxSongsPerGuest: 3,
    maxGuestsPerSession: null,
    moderationEnabledDefault: false,
  };
  // Database client isn't touched by the health route; cast through unknown
  // so we don't pull in a real client just to satisfy the type.
  return { config, db: {} as AppDeps['db'] };
}

describe('createApp', () => {
  it('mounts routes under /api/v1', async () => {
    const app = createApp({ deps: fakeDeps() });
    const response = await app.request('/api/v1/health');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; service: string };
    expect(body).toEqual({ ok: true, service: 'opendj-backend' });
  });

  it('returns 404 for unknown /api/v1 routes', async () => {
    const app = createApp({ deps: fakeDeps() });
    const response = await app.request('/api/v1/does-not-exist');
    expect(response.status).toBe(404);
  });

  it('does NOT expose health at root (versioned API only)', async () => {
    const app = createApp({ deps: fakeDeps() });
    const response = await app.request('/health');
    expect(response.status).toBe(404);
  });
});
