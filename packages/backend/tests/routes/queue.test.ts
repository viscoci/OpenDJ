/**
 * `/sessions/:id/queue` route — error mapping for provider rate limits.
 */

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AuthService } from '../../src/auth/AuthService.js';
import { QueueServiceError, type QueueService } from '../../src/queue/QueueService.js';
import { queueRoutes } from '../../src/routes/queue.js';

function appWithFailingRequest(error: QueueServiceError) {
  const queueService = {
    async requestTrack() {
      throw error;
    },
  } as unknown as QueueService;
  const app = new Hono();
  app.route('/sessions/:id/queue', queueRoutes({ authService: {} as AuthService, queueService }));
  return app;
}

function requestTrack(app: Hono) {
  return app.request('http://x/sessions/s1/queue', {
    method: 'POST',
    headers: { authorization: 'Bearer slot-1', 'content-type': 'application/json' },
    body: JSON.stringify({
      uri: 'spotify:track:abc',
      name: 'Velvet Leash',
      artist: 'A',
      albumArt: null,
      durationMs: 200_000,
    }),
  });
}

describe('POST /sessions/:id/queue — provider rate limited', () => {
  it('returns 503 provider_rate_limited with retryAfterSec and a Retry-After header', async () => {
    const app = appWithFailingRequest(
      new QueueServiceError('provider_rate_limited', 'rate limited', { retryAfterSec: 900 }),
    );

    const res = await requestTrack(app);

    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('900');
    expect(await res.json()).toEqual({ error: 'provider_rate_limited', retryAfterSec: 900 });
  });

  it('keeps mapping other errors as before', async () => {
    const app = appWithFailingRequest(new QueueServiceError('cap_reached', 'cap'));

    const res = await requestTrack(app);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'cap_reached' });
  });
});
