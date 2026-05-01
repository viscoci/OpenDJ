import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { GuestIdentityService } from '../../src/guest/GuestIdentityService.js';
import {
  InMemoryAccountRepository,
  InMemoryFingerprintPriorityRepository,
  InMemoryGuestRepository,
  InMemoryGuestSlotRepository,
  InMemorySessionRepository,
} from '../../src/repositories/in-memory/index.js';
import { guestRoutes } from '../../src/routes/guest.js';

const SESSION_ID = '11111111-1111-1111-1111-111111111111';
const ACCOUNT_ID = '22222222-2222-2222-2222-222222222222';
const NOW = Date.now();

function setup() {
  const clock = { now: () => new Date(NOW) };
  const sessions = new InMemorySessionRepository();
  const accounts = new InMemoryAccountRepository();
  const guests = new InMemoryGuestRepository(clock);
  const guestSlots = new InMemoryGuestSlotRepository(clock);
  const fingerprintPriority = new InMemoryFingerprintPriorityRepository(clock);

  accounts.seed({
    id: ACCOUNT_ID,
    displayName: 'A',
    slug: 'a',
    plan: 'oss',
    createdAt: new Date(NOW),
  });
  sessions.seed({
    id: SESSION_ID,
    accountId: ACCOUNT_ID,
    name: 'Test',
    qrSlug: 'test-event',
    guestCapOverride: null,
    songsPerGuestCap: 3,
    moderationEnabled: false,
    voteSkipMode: 'fixed',
    voteSkipThreshold: 5,
    startedAt: new Date(NOW),
    endedAt: null,
  });

  const guestIdentity = new GuestIdentityService({
    sessions,
    accounts,
    guests,
    guestSlots,
    fingerprintPriority,
  });

  const app = new Hono();
  app.route('/', guestRoutes({ guestIdentity }));
  return { app, sessions };
}

describe('POST /identity', () => {
  it('returns 400 on invalid body', async () => {
    const { app } = setup();
    const res = await app.request('/identity', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 on non-JSON body', async () => {
    const { app } = setup();
    const res = await app.request('/identity', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown event slug', async () => {
    const { app } = setup();
    const res = await app.request('/identity', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ eventSlug: 'nope', fingerprintHash: 'fp' }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 410 when session has ended', async () => {
    const { app, sessions } = setup();
    const row = await sessions.findByQrSlug('test-event');
    if (row) (row as { endedAt: Date | null }).endedAt = new Date(NOW - 1);
    const res = await app.request('/identity', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ eventSlug: 'test-event', fingerprintHash: 'fp' }),
    });
    expect(res.status).toBe(410);
  });

  it('issues a slot token + active status on happy path', async () => {
    const { app } = setup();
    const res = await app.request('/identity', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ eventSlug: 'test-event', fingerprintHash: 'fp-1' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { slotToken: string; status: string };
    expect(body.slotToken).toMatch(/^[0-9a-f]{64}$/);
    expect(body.status).toBe('active');
  });
});

describe('POST /heartbeat', () => {
  it('returns 401 without bearer token', async () => {
    const { app } = setup();
    const res = await app.request('/heartbeat', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('returns 401 for unknown slot token', async () => {
    const { app } = setup();
    const res = await app.request('/heartbeat', {
      method: 'POST',
      headers: { authorization: 'Bearer does-not-exist' },
    });
    expect(res.status).toBe(401);
  });

  it('returns 200 + slot status for a known slot', async () => {
    const { app } = setup();
    const issued = await app.request('/identity', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ eventSlug: 'test-event', fingerprintHash: 'fp-1' }),
    });
    const issuedBody = (await issued.json()) as { slotToken: string };
    const res = await app.request('/heartbeat', {
      method: 'POST',
      headers: { authorization: `Bearer ${issuedBody.slotToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('active');
  });
});

describe('GET /slot', () => {
  it('returns 401 without bearer token', async () => {
    const { app } = setup();
    const res = await app.request('/slot');
    expect(res.status).toBe(401);
  });

  it('returns 401 for unknown slot token', async () => {
    const { app } = setup();
    const res = await app.request('/slot', {
      headers: { authorization: 'Bearer does-not-exist' },
    });
    expect(res.status).toBe(401);
  });

  it('returns slot status + sessionId', async () => {
    const { app } = setup();
    const issued = await app.request('/identity', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ eventSlug: 'test-event', fingerprintHash: 'fp-1' }),
    });
    const issuedBody = (await issued.json()) as { slotToken: string };
    const res = await app.request('/slot', {
      headers: { authorization: `Bearer ${issuedBody.slotToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; sessionId: string };
    expect(body.status).toBe('active');
    expect(body.sessionId).toBe(SESSION_ID);
  });
});
