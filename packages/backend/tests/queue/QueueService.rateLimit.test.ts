/**
 * QueueService — behavior while the host's streaming provider is rate
 * limiting the account.
 *
 * Live incident: pushToProviderQueue swallowed Spotify 429s, so guests got
 * a "queued" confirmation for songs that never reached Spotify. Requests
 * that can't reach the provider must now fail loudly and not burn the
 * guest's per-guest cap.
 */

import {
  defineCapabilities,
  PROVIDER_FEATURES,
  type IStreamingProvider,
  type QueueResult,
  type Track,
} from '@opendj/core';
import { NodeSessionRoom, type SessionEvent } from '@opendj/realtime';
import { describe, expect, it, vi } from 'vitest';
import { ProviderCooldowns } from '../../src/providers/streaming/ProviderCooldowns.js';
import type { ProviderRegistry } from '../../src/providers/streaming/providerRegistry.js';
import { StreamingRouter } from '../../src/providers/streaming/StreamingRouter.js';
import { QueueService, QueueServiceError } from '../../src/queue/QueueService.js';
import {
  InMemoryGuestRepository,
  InMemoryGuestSlotRepository,
  InMemoryKaraokeClaimRepository,
  InMemoryProviderConnectionRepository,
  InMemoryQueueItemRepository,
  InMemoryQueueSkipVoteRepository,
  InMemorySessionRepository,
} from '../../src/repositories/in-memory/index.js';

const SESSION_ID = '11111111-1111-1111-1111-111111111111';
const ACCOUNT_ID = '22222222-2222-2222-2222-222222222222';
const NOW = new Date('2026-09-26T23:00:00Z').getTime();

const TRACK: Track = {
  uri: 'spotify:track:abc',
  name: 'Velvet Leash',
  artist: 'A',
  albumArt: null,
  durationMs: 200_000,
};

async function setup(opts: { moderationEnabled?: boolean } = {}) {
  const clock = { now: () => new Date(NOW) };
  const sessions = new InMemorySessionRepository();
  const guests = new InMemoryGuestRepository(clock);
  const guestSlots = new InMemoryGuestSlotRepository(clock);
  const queueItems = new InMemoryQueueItemRepository(clock);
  const providerConnections = new InMemoryProviderConnectionRepository();
  sessions.seed({
    id: SESSION_ID,
    accountId: ACCOUNT_ID,
    name: 'Party',
    qrSlug: 'party',
    guestCapOverride: null,
    songsPerGuestCap: 3,
    maxConsecutivePerGuest: null,
    moderationEnabled: opts.moderationEnabled ?? false,
    voteSkipMode: 'fixed',
    voteSkipThreshold: 5,
    karaokeMode: 'off',
    karaokeMicCount: 1,
    karaokePauseMode: 'manual',
    karaokePauseTimeoutSec: 30,
    startedAt: new Date(NOW),
    endedAt: null,
  });
  await providerConnections.upsert({
    accountId: ACCOUNT_ID,
    providerId: 'spotify',
    accessToken: 'tok',
  });

  const queueTrack = vi.fn<(track: Track) => Promise<QueueResult>>(async () => ({
    queued: true,
  }));
  const provider: IStreamingProvider & { queueTrack: typeof queueTrack } = {
    providerId: 'spotify',
    displayName: 'Spotify',
    async connect() {},
    async disconnect() {},
    isConnected: () => true,
    async refreshCredentials() {
      return {};
    },
    getCapabilities: () =>
      defineCapabilities('spotify', {
        [PROVIDER_FEATURES.QueueTrack]: {
          id: PROVIDER_FEATURES.QueueTrack,
          supported: true,
          access: 'host',
          reliability: 'native',
        },
      }),
    queueTrack,
  };
  const cooldowns = new ProviderCooldowns();
  const streamingRouter = new StreamingRouter({
    providerConnections,
    registry: { spotify: () => provider } as ProviderRegistry,
    context: { fetch: globalThis.fetch },
    cooldowns,
  });

  const room = new NodeSessionRoom({ sessionId: SESSION_ID, nowEpochMs: () => NOW });
  const events: SessionEvent[] = [];
  await room.connect({
    clientId: 'c1',
    kind: 'host',
    sessionId: SESSION_ID,
    connectedAtEpochMs: NOW,
  });
  room.subscribe('c1', (e) => events.push(e as SessionEvent));

  const service = new QueueService({
    sessions,
    guests,
    guestSlots,
    queueItems,
    queueSkipVotes: new InMemoryQueueSkipVoteRepository(queueItems, clock),
    karaokeClaims: new InMemoryKaraokeClaimRepository(clock),
    rooms: { forSession: (id) => (id === SESSION_ID ? room : null) },
    streamingRouter,
    providerConnections,
  });

  await guests.create({ sessionId: SESSION_ID, fingerprint: 'fp-1', userId: null });
  await guestSlots.create({
    sessionId: SESSION_ID,
    fingerprintHash: 'fp-1',
    slotToken: 'slot-1',
    status: 'active',
  });

  const request = () =>
    service.requestTrack({ sessionId: SESSION_ID, slotToken: 'slot-1', track: TRACK }, NOW);
  return { service, queueItems, cooldowns, queueTrack, events, request };
}

async function rejection(promise: Promise<unknown>): Promise<QueueServiceError> {
  const err = await promise.catch((e: unknown) => e);
  if (!(err instanceof QueueServiceError))
    throw new Error(`expected QueueServiceError, got ${err}`);
  return err;
}

describe('QueueService.requestTrack — provider rate limited', () => {
  it('refuses an auto-approved request while the account is cooling down', async () => {
    const { cooldowns, queueItems, queueTrack, request } = await setup();
    cooldowns.record(ACCOUNT_ID, 'spotify', 900);

    const err = await rejection(request());

    expect(err.code).toBe('provider_rate_limited');
    expect(err.retryAfterSec).toBeGreaterThan(0);
    expect(await queueItems.findAllForSession(SESSION_ID)).toEqual([]);
    expect(queueTrack).not.toHaveBeenCalled();
  });

  it('rolls the item back when the push itself hits a fresh 429', async () => {
    const { queueItems, queueTrack, events, request } = await setup();
    queueTrack.mockRejectedValueOnce(
      Object.assign(new Error('Spotify Web API returned 429'), {
        status: 429,
        retryAfterSec: 56029,
      }),
    );

    const err = await rejection(request());

    expect(err.code).toBe('provider_rate_limited');
    expect(err.retryAfterSec).toBe(56029);
    expect(await queueItems.findAllForSession(SESSION_ID)).toEqual([]);
    expect(events.map((e) => e.type)).toContain('queue.item_removed');
  });

  it('still accepts a request when the push fails for another reason', async () => {
    // e.g. NO_ACTIVE_DEVICE — the poller's retry pump re-pushes once the
    // host starts playback, so the item stays.
    const { queueItems, queueTrack, request } = await setup();
    queueTrack.mockRejectedValueOnce(new Error('Spotify has no active device.'));

    await request();

    expect(await queueItems.findAllForSession(SESSION_ID)).toHaveLength(1);
  });

  it('accepts requests into moderation while cooling down (nothing is pushed yet)', async () => {
    const { cooldowns, queueItems, request } = await setup({ moderationEnabled: true });
    cooldowns.record(ACCOUNT_ID, 'spotify', 900);

    const created = await request();

    expect(created.status).toBe('pending');
    expect(await queueItems.findAllForSession(SESSION_ID)).toHaveLength(1);
  });
});

describe('QueueService.moderate — provider rate limited', () => {
  it('refuses a host approval while cooling down and leaves the item pending', async () => {
    const { service, cooldowns, queueItems, queueTrack, request } = await setup({
      moderationEnabled: true,
    });
    const created = await request();
    cooldowns.record(ACCOUNT_ID, 'spotify', 900);

    const err = await rejection(
      service.moderate({ itemId: created.id, decision: 'approved', sessionId: SESSION_ID }, NOW),
    );

    expect(err.code).toBe('provider_rate_limited');
    expect((await queueItems.findById(created.id))?.status).toBe('pending');
    expect(queueTrack).not.toHaveBeenCalled();
  });
});
