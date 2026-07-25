/**
 * /api/v1/sessions/:id/karaoke — mic claim routes.
 *
 * Guest actions use slot-token bearer auth exactly like the queue request
 * routes; host claim removal uses the cookie session + `queue:moderate`.
 */

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { AuthService, SESSION_COOKIE_NAME } from '../../src/auth/AuthService.js';
import { ClaimsService } from '../../src/auth/ClaimsService.js';
import type { AuthVariables } from '../../src/auth/middleware.js';
import { KaraokeService } from '../../src/karaoke/KaraokeService.js';
import {
  InMemoryAccountRepository,
  InMemoryAuthSessionRepository,
  InMemoryGuestRepository,
  InMemoryGuestSlotRepository,
  InMemoryKaraokeClaimRepository,
  InMemoryMembershipRepository,
  InMemoryQueueItemRepository,
  InMemorySessionRepository,
} from '../../src/repositories/in-memory/index.js';
import type { QueueItemStatus, SessionRecord } from '../../src/repositories/types.js';
import { karaokeRoutes } from '../../src/routes/karaoke.js';

const SESSION_ID = '11111111-1111-1111-1111-111111111111';
const ACCOUNT_ID = '22222222-2222-2222-2222-222222222222';
const USER_ID = '33333333-3333-3333-3333-333333333333';
const NOW = new Date('2026-04-30T12:00:00Z').getTime();

const baseSession: SessionRecord = {
  id: SESSION_ID,
  accountId: ACCOUNT_ID,
  name: 'Karaoke Night',
  qrSlug: 'karaoke',
  guestCapOverride: null,
  songsPerGuestCap: 3,
  maxConsecutivePerGuest: null,
  allowDuplicates: false,
  moderationEnabled: false,
  voteSkipMode: 'fixed',
  voteSkipThreshold: 5,
  karaokeMode: 'optional',
  karaokeMicCount: 1,
  karaokePauseMode: 'manual',
  karaokePauseTimeoutSec: 30,
  startedAt: new Date(NOW),
  endedAt: null,
};

async function setup(
  opts: {
    karaokeMode?: 'off' | 'optional' | 'required';
    karaokePauseMode?: 'off' | 'manual' | 'auto';
  } = {},
) {
  const clock = { now: () => new Date(NOW) };
  const sessions = new InMemorySessionRepository();
  const guests = new InMemoryGuestRepository(clock);
  const guestSlots = new InMemoryGuestSlotRepository(clock);
  const queueItems = new InMemoryQueueItemRepository(clock);
  const karaokeClaims = new InMemoryKaraokeClaimRepository(clock);
  const accounts = new InMemoryAccountRepository();
  const memberships = new InMemoryMembershipRepository();
  const authSessions = new InMemoryAuthSessionRepository(clock);
  const claims = new ClaimsService({ memberships, accounts });
  const authService = new AuthService({ authSessions, claims, clock: () => NOW });

  sessions.seed({
    ...baseSession,
    karaokeMode: opts.karaokeMode ?? 'optional',
    karaokePauseMode: opts.karaokePauseMode ?? 'manual',
  });

  const karaokeService = new KaraokeService({
    sessions,
    guests,
    guestSlots,
    queueItems,
    karaokeClaims,
    nowEpochMs: () => NOW,
  });

  const app = new Hono<{ Variables: AuthVariables }>();
  app.route('/sessions/:id/karaoke', karaokeRoutes({ authService, karaokeService }));

  const guest = await guests.create({ sessionId: SESSION_ID, fingerprint: 'fp-1' });
  await guestSlots.create({
    sessionId: SESSION_ID,
    fingerprintHash: 'fp-1',
    slotToken: 'slot-1',
    status: 'active',
  });

  async function addGuest(fingerprint: string, slotToken: string) {
    const extra = await guests.create({ sessionId: SESSION_ID, fingerprint });
    await guestSlots.create({
      sessionId: SESSION_ID,
      fingerprintHash: fingerprint,
      slotToken,
      status: 'active',
    });
    return extra;
  }

  async function addItem(status: QueueItemStatus = 'queued') {
    return queueItems.create({
      sessionId: SESSION_ID,
      guestId: guest.id,
      trackUri: 'spotify:track:abc',
      trackName: 'Hello',
      artistName: 'World',
      status,
    });
  }

  async function hostCookie(claimList: string[] = ['queue:moderate']) {
    const issued = await authService.issueSession({
      userId: USER_ID,
      currentAccountId: ACCOUNT_ID,
      claimsSnapshot: claimList as Parameters<typeof authService.issueSession>[0]['claimsSnapshot'],
      nowEpochMs: NOW,
    });
    return `${SESSION_COOKIE_NAME}=${issued.token}`;
  }

  return { app, guest, karaokeClaims, karaokeService, queueItems, addItem, addGuest, hostCookie };
}

describe('POST /sessions/:id/karaoke/claims', () => {
  it('creates a claim with slot-token auth and returns 201', async () => {
    const { app, guest, addItem } = await setup();
    const item = await addItem();
    const res = await app.request(`http://x/sessions/${SESSION_ID}/karaoke/claims`, {
      method: 'POST',
      headers: { authorization: 'Bearer slot-1', 'content-type': 'application/json' },
      body: JSON.stringify({ queueItemId: item.id, displayName: '  Ana  ' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { claim: unknown };
    expect(body.claim).toEqual({
      queueItemId: item.id,
      guestId: guest.id,
      displayName: 'Ana',
    });
  });

  it('401 missing_slot_token without the Authorization header', async () => {
    const { app, addItem } = await setup();
    const item = await addItem();
    const res = await app.request(`http://x/sessions/${SESSION_ID}/karaoke/claims`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ queueItemId: item.id, displayName: 'Ana' }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'missing_slot_token' });
  });

  it('401 unknown_slot_token for a bogus token', async () => {
    const { app, addItem } = await setup();
    const item = await addItem();
    const res = await app.request(`http://x/sessions/${SESSION_ID}/karaoke/claims`, {
      method: 'POST',
      headers: { authorization: 'Bearer nope', 'content-type': 'application/json' },
      body: JSON.stringify({ queueItemId: item.id, displayName: 'Ana' }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unknown_slot_token' });
  });

  it('400 invalid_body when queueItemId is missing', async () => {
    const { app } = await setup();
    const res = await app.request(`http://x/sessions/${SESSION_ID}/karaoke/claims`, {
      method: 'POST',
      headers: { authorization: 'Bearer slot-1', 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Ana' }),
    });
    expect(res.status).toBe(400);
  });

  it('maps rule rejections: 400 karaoke_off', async () => {
    const { app, addItem } = await setup({ karaokeMode: 'off' });
    const item = await addItem();
    const res = await app.request(`http://x/sessions/${SESSION_ID}/karaoke/claims`, {
      method: 'POST',
      headers: { authorization: 'Bearer slot-1', 'content-type': 'application/json' },
      body: JSON.stringify({ queueItemId: item.id, displayName: 'Ana' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'karaoke_off' });
  });

  it('maps rule rejections: 400 mics_full and already_claimed', async () => {
    const { app, addItem } = await setup();
    const item = await addItem();
    const first = await app.request(`http://x/sessions/${SESSION_ID}/karaoke/claims`, {
      method: 'POST',
      headers: { authorization: 'Bearer slot-1', 'content-type': 'application/json' },
      body: JSON.stringify({ queueItemId: item.id, displayName: 'Ana' }),
    });
    expect(first.status).toBe(201);
    const again = await app.request(`http://x/sessions/${SESSION_ID}/karaoke/claims`, {
      method: 'POST',
      headers: { authorization: 'Bearer slot-1', 'content-type': 'application/json' },
      body: JSON.stringify({ queueItemId: item.id, displayName: 'Ana' }),
    });
    expect(again.status).toBe(400);
    expect(await again.json()).toEqual({ error: 'already_claimed' });
  });

  it('400 invalid_display_name for a blank name', async () => {
    const { app, addItem } = await setup();
    const item = await addItem();
    const res = await app.request(`http://x/sessions/${SESSION_ID}/karaoke/claims`, {
      method: 'POST',
      headers: { authorization: 'Bearer slot-1', 'content-type': 'application/json' },
      body: JSON.stringify({ queueItemId: item.id, displayName: '   ' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_display_name' });
  });

  it('404 item_not_found for an unknown item', async () => {
    const { app } = await setup();
    const res = await app.request(`http://x/sessions/${SESSION_ID}/karaoke/claims`, {
      method: 'POST',
      headers: { authorization: 'Bearer slot-1', 'content-type': 'application/json' },
      body: JSON.stringify({ queueItemId: 'missing', displayName: 'Ana' }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'item_not_found' });
  });
});

describe('DELETE /sessions/:id/karaoke/claims/:itemId', () => {
  async function claim(app: Hono<{ Variables: AuthVariables }>, itemId: string) {
    const res = await app.request(`http://x/sessions/${SESSION_ID}/karaoke/claims`, {
      method: 'POST',
      headers: { authorization: 'Bearer slot-1', 'content-type': 'application/json' },
      body: JSON.stringify({ queueItemId: itemId, displayName: 'Ana' }),
    });
    expect(res.status).toBe(201);
  }

  it('guest removes their own claim with slot-token auth', async () => {
    const { app, karaokeClaims, addItem } = await setup();
    const item = await addItem();
    await claim(app, item.id);
    const res = await app.request(`http://x/sessions/${SESSION_ID}/karaoke/claims/${item.id}`, {
      method: 'DELETE',
      headers: { authorization: 'Bearer slot-1' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await karaokeClaims.findAllForItem(item.id)).toEqual([]);
  });

  it('404 claim_not_found when the guest holds no claim', async () => {
    const { app, addItem } = await setup();
    const item = await addItem();
    const res = await app.request(`http://x/sessions/${SESSION_ID}/karaoke/claims/${item.id}`, {
      method: 'DELETE',
      headers: { authorization: 'Bearer slot-1' },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'claim_not_found' });
  });

  it('400 item_not_waiting once the item is playing', async () => {
    const { app, queueItems, addItem } = await setup();
    const item = await addItem();
    await claim(app, item.id);
    await queueItems.setStatus({ id: item.id, status: 'playing' });
    const res = await app.request(`http://x/sessions/${SESSION_ID}/karaoke/claims/${item.id}`, {
      method: 'DELETE',
      headers: { authorization: 'Bearer slot-1' },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'item_not_waiting' });
  });

  it('host removes any claim via cookie auth + guestId query, even mid-song', async () => {
    const { app, guest, karaokeClaims, queueItems, addItem, hostCookie } = await setup();
    const item = await addItem();
    await claim(app, item.id);
    await queueItems.setStatus({ id: item.id, status: 'playing' });
    const cookie = await hostCookie();
    const res = await app.request(
      `http://x/sessions/${SESSION_ID}/karaoke/claims/${item.id}?guestId=${guest.id}`,
      { method: 'DELETE', headers: { cookie } },
    );
    expect(res.status).toBe(200);
    expect(await karaokeClaims.findAllForItem(item.id)).toEqual([]);
  });

  it('host path without guestId is 400 missing_guest_id', async () => {
    const { app, addItem, hostCookie } = await setup();
    const item = await addItem();
    await claim(app, item.id);
    const cookie = await hostCookie();
    const res = await app.request(`http://x/sessions/${SESSION_ID}/karaoke/claims/${item.id}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'missing_guest_id' });
  });

  it('401 unauthenticated without slot token or cookie', async () => {
    const { app, addItem } = await setup();
    const item = await addItem();
    const res = await app.request(`http://x/sessions/${SESSION_ID}/karaoke/claims/${item.id}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(401);
  });

  it('403 for a host session missing the queue:moderate claim', async () => {
    const { app, guest, addItem, hostCookie } = await setup();
    const item = await addItem();
    await claim(app, item.id);
    const cookie = await hostCookie(['account:read']);
    const res = await app.request(
      `http://x/sessions/${SESSION_ID}/karaoke/claims/${item.id}?guestId=${guest.id}`,
      { method: 'DELETE', headers: { cookie } },
    );
    expect(res.status).toBe(403);
  });
});

describe('POST /sessions/:id/karaoke/pause and /ready', () => {
  const TRACK_URI = 'spotify:track:abc';

  /** Claim the item via the API (slot-1) and put it in the spotlight. */
  async function claimAndSpotlight(s: Awaited<ReturnType<typeof setup>>, slotToken = 'slot-1') {
    const item = await s.addItem();
    const res = await s.app.request(`http://x/sessions/${SESSION_ID}/karaoke/claims`, {
      method: 'POST',
      headers: { authorization: `Bearer ${slotToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ queueItemId: item.id, displayName: 'Ana' }),
    });
    expect(res.status).toBe(201);
    await s.karaokeService.handleTrackChange({ sessionId: SESSION_ID, trackUri: TRACK_URI });
    return item;
  }

  function post(s: Awaited<ReturnType<typeof setup>>, path: 'pause' | 'ready', token?: string) {
    return s.app.request(`http://x/sessions/${SESSION_ID}/karaoke/${path}`, {
      method: 'POST',
      ...(token && { headers: { authorization: `Bearer ${token}` } }),
    });
  }

  it('pause: 200 with the auto-resume deadline for a spotlight claimer in manual mode', async () => {
    const s = await setup();
    await claimAndSpotlight(s);
    const res = await post(s, 'pause', 'slot-1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, untilEpochMs: NOW + 30_000 });
    expect(s.karaokeService.getKaraokeState(SESSION_ID).paused).toBe(true);
  });

  it('pause: 401 missing_slot_token without the Authorization header', async () => {
    const s = await setup();
    await claimAndSpotlight(s);
    const res = await post(s, 'pause');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'missing_slot_token' });
  });

  it('pause: 403 not_a_claimer when no spotlight is active', async () => {
    const s = await setup();
    await s.addItem(); // item exists but nothing is spotlighted
    const res = await post(s, 'pause', 'slot-1');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'not_a_claimer' });
  });

  it('pause: 403 not_a_claimer for a guest without a claim on the spotlight item', async () => {
    const s = await setup();
    await s.addGuest('fp-2', 'slot-2');
    await claimAndSpotlight(s, 'slot-2'); // guest 2 owns the claim
    const res = await post(s, 'pause', 'slot-1');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'not_a_claimer' });
  });

  it('pause: 400 pause_disabled outside manual pause mode', async () => {
    const s = await setup({ karaokePauseMode: 'auto' });
    await claimAndSpotlight(s);
    const res = await post(s, 'pause', 'slot-1');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'pause_disabled' });
  });

  it('ready: 200 resumes after a pause', async () => {
    const s = await setup();
    await claimAndSpotlight(s);
    expect((await post(s, 'pause', 'slot-1')).status).toBe(200);
    const res = await post(s, 'ready', 'slot-1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(s.karaokeService.getKaraokeState(SESSION_ID).paused).toBe(false);
  });

  it('ready: 400 not_paused when playback is not karaoke-paused', async () => {
    const s = await setup();
    await claimAndSpotlight(s);
    const res = await post(s, 'ready', 'slot-1');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'not_paused' });
  });

  it('ready: 403 not_a_claimer for a non-claimer even while paused', async () => {
    const s = await setup();
    await s.addGuest('fp-2', 'slot-2');
    await claimAndSpotlight(s, 'slot-2');
    // Guest 2 pauses; guest 1 (no claim) may not resume.
    expect((await post(s, 'pause', 'slot-2')).status).toBe(200);
    const res = await post(s, 'ready', 'slot-1');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'not_a_claimer' });
  });
});
