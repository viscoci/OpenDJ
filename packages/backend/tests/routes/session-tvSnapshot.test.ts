/**
 * GET /sessions/by-slug/:slug/tv-snapshot — public, no-auth, returns the
 * room's hot state for the casting page. Falls back to repo-backed reads
 * when the room hasn't materialized yet.
 */

import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { NodeSessionRoom } from '@opendj/realtime';
import type { AuthVariables } from '../../src/auth/middleware.js';
import { AuthService } from '../../src/auth/AuthService.js';
import { ClaimsService } from '../../src/auth/ClaimsService.js';
import {
  InMemoryAccountRepository,
  InMemoryAuthSessionRepository,
  InMemoryGuestRepository,
  InMemoryGuestSlotRepository,
  InMemoryMembershipRepository,
  InMemoryQueueItemRepository,
  InMemorySessionRepository,
} from '../../src/repositories/in-memory/index.js';
import { sessionRoutes } from '../../src/routes/session.js';
import { SessionService } from '../../src/session/SessionService.js';
import type { RealtimeRoomRegistry } from '../../src/queue/QueueService.js';
import type { NowPlayingTrack } from '@opendj/core';

const NOW = new Date('2026-05-04T12:00:00Z').getTime();
const ACCOUNT_ID = '11111111-1111-1111-1111-111111111111';

function buildTestApp() {
  const accounts = new InMemoryAccountRepository();
  const memberships = new InMemoryMembershipRepository();
  const authSessions = new InMemoryAuthSessionRepository();
  const sessions = new InMemorySessionRepository();
  const guests = new InMemoryGuestRepository();
  const guestSlots = new InMemoryGuestSlotRepository();
  const queueItems = new InMemoryQueueItemRepository();
  const claims = new ClaimsService({ memberships, accounts });
  const authService = new AuthService({ authSessions, claims });
  const sessionService = new SessionService({ sessions });

  accounts.seed({
    id: ACCOUNT_ID,
    displayName: 'Acc',
    slug: 'acc',
    plan: 'free',
    createdAt: new Date(NOW),
  });

  const rooms = new Map<string, NodeSessionRoom>();
  const roomsRegistry: RealtimeRoomRegistry = {
    forSession: (id) => rooms.get(id) ?? null,
  };

  const app = new Hono<{ Variables: AuthVariables }>();
  app.route(
    '/sessions',
    sessionRoutes({
      authService,
      sessionService,
      rooms: roomsRegistry,
      queueItems,
      guestSlots,
    }),
  );

  return { app, sessions, queueItems, guestSlots, rooms };
}

describe('GET /sessions/by-slug/:slug/tv-snapshot', () => {
  it('404 when slug unknown', async () => {
    const { app } = buildTestApp();
    const res = await app.request('/sessions/by-slug/does-not-exist/tv-snapshot');
    expect(res.status).toBe(404);
  });

  it('200 with fallback empty fields when room is not materialized', async () => {
    const { app, sessions } = buildTestApp();
    await sessions.create({ accountId: ACCOUNT_ID, name: 'Demo', qrSlug: 'demo' });
    const res = await app.request('/sessions/by-slug/demo/tv-snapshot');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      session: { qrSlug: string };
      nowPlaying: unknown;
      recentlyPlayed: unknown[];
      queue: unknown[];
      activeGuestCount: number;
    };
    expect(body.session.qrSlug).toBe('demo');
    expect(body.nowPlaying).toBeNull();
    expect(body.recentlyPlayed).toEqual([]);
    expect(body.queue).toEqual([]);
    expect(body.activeGuestCount).toBe(0);
  });

  it('200 with room snapshot when the room is live', async () => {
    const { app, sessions, rooms } = buildTestApp();
    const created = await sessions.create({ accountId: ACCOUNT_ID, name: 'D', qrSlug: 'live' });
    const room = new NodeSessionRoom({ sessionId: created.id, nowEpochMs: () => NOW });
    rooms.set(created.id, room);
    const playing: NowPlayingTrack = {
      uri: 'spotify:track:abc',
      name: 'Hello',
      artist: 'World',
      albumArt: null,
      durationMs: 180_000,
      progressMs: 30_000,
      isPlaying: true,
      zoneId: 'default',
    };
    await room.publish({ type: 'now_playing.updated', track: playing });

    const res = await app.request('/sessions/by-slug/live/tv-snapshot');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      nowPlaying: NowPlayingTrack | null;
      recentlyPlayed: NowPlayingTrack[];
    };
    expect(body.nowPlaying?.uri).toBe('spotify:track:abc');
    expect(body.recentlyPlayed).toEqual([]);
  });

  it('falls back to queue repo read when the room is empty but queue exists', async () => {
    const { app, sessions, queueItems, guests } = buildTestApp() as ReturnType<
      typeof buildTestApp
    > & { guests?: InMemoryGuestRepository };
    void guests;
    const created = await sessions.create({ accountId: ACCOUNT_ID, name: 'D', qrSlug: 'q' });
    // Insert a guest + a queued item directly.
    const guestRepo = new InMemoryGuestRepository();
    const guestRow = await guestRepo.create({
      sessionId: created.id,
      fingerprint: 'fp',
      userId: null,
    });
    await queueItems.create({
      sessionId: created.id,
      guestId: guestRow.id,
      trackUri: 'spotify:track:queued',
      trackName: 'Queued Track',
      artistName: 'A',
      status: 'approved',
    });
    const res = await app.request('/sessions/by-slug/q/tv-snapshot');
    const body = (await res.json()) as { queue: Array<{ trackUri: string }> };
    expect(body.queue).toHaveLength(1);
    expect(body.queue[0]?.trackUri).toBe('spotify:track:queued');
  });
});
