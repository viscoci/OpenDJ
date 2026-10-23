/**
 * QueueService — add-time track resolution. A request whose uri is not
 * native to the session's provider (e.g. `opendj:isrc:` from an external
 * search source) is resolved to a native uri before any check, insert, or
 * provider push.
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
import type { TrackResolveRequest } from '../../src/track-resolution/TrackResolver.js';

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

async function setup(
  opts: {
    moderationEnabled?: boolean;
    resolve?: (req: TrackResolveRequest) => Promise<{ uri: string; resolverId: string } | null>;
  } = {},
) {
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

  const resolveSpy = vi.fn(opts.resolve ?? (async () => null));
  const trackCatalog = { recordRequested: vi.fn<(accountId: string, track: Track) => void>() };
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
    trackCatalog,
    trackResolver: { resolve: resolveSpy },
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
  const requestUri = (uri: string) =>
    service.requestTrack(
      { sessionId: SESSION_ID, slotToken: 'slot-1', track: { ...TRACK, uri } },
      NOW,
    );
  return {
    service,
    queueItems,
    queueTrack,
    events,
    request,
    requestUri,
    trackCatalog,
    resolveSpy,
    guestSlots,
  };
}

async function rejection(promise: Promise<unknown>): Promise<QueueServiceError> {
  const err = await promise.catch((e: unknown) => e);
  if (!(err instanceof QueueServiceError))
    throw new Error(`expected QueueServiceError, got ${err}`);
  return err;
}

const ISRC_URI = 'opendj:isrc:GBDUW0000053';
const resolvesTo = (uri: string) => async () => ({ uri, resolverId: 'test' });

describe('QueueService.requestTrack — track resolution', () => {
  it('never resolves a uri native to the provider', async () => {
    const { request, resolveSpy, queueTrack } = await setup();

    const created = await request();

    expect(created.trackUri).toBe('spotify:track:abc');
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(queueTrack).toHaveBeenCalledTimes(1);
  });

  it('resolves a foreign uri before the push and stores the native uri', async () => {
    const { requestUri, resolveSpy, queueTrack, queueItems, trackCatalog, events } = await setup({
      resolve: resolvesTo('spotify:track:native'),
    });

    const created = await requestUri(ISRC_URI);

    expect(resolveSpy).toHaveBeenCalledWith({
      accountId: ACCOUNT_ID,
      providerId: 'spotify',
      isrc: 'GBDUW0000053',
    });
    expect(created.trackUri).toBe('spotify:track:native');
    expect((await queueItems.findAllForSession(SESSION_ID))[0]?.trackUri).toBe(
      'spotify:track:native',
    );
    expect(queueTrack).toHaveBeenCalledWith(
      expect.objectContaining({ uri: 'spotify:track:native' }),
    );
    expect(trackCatalog.recordRequested).toHaveBeenCalledWith(
      ACCOUNT_ID,
      expect.objectContaining({ uri: 'spotify:track:native', isrc: 'GBDUW0000053' }),
    );
    const requested = events.find((e) => e.type === 'queue.item_requested');
    expect(JSON.stringify(requested)).toContain('spotify:track:native');
  });

  it('resolves held (moderated) requests too', async () => {
    const { requestUri, queueTrack } = await setup({
      moderationEnabled: true,
      resolve: resolvesTo('spotify:track:native'),
    });

    const created = await requestUri(ISRC_URI);

    expect(created.status).toBe('pending');
    expect(created.trackUri).toBe('spotify:track:native');
    expect(queueTrack).not.toHaveBeenCalled();
  });

  it('rejects an unresolvable track with track_unresolvable and consumes no slot', async () => {
    const { requestUri, queueItems, queueTrack, trackCatalog } = await setup();

    const err = await rejection(requestUri(ISRC_URI));

    expect(err.code).toBe('track_unresolvable');
    expect(await queueItems.findAllForSession(SESSION_ID)).toEqual([]);
    expect(queueTrack).not.toHaveBeenCalled();
    expect(trackCatalog.recordRequested).not.toHaveBeenCalled();
  });

  it('rejects a foreign uri that carries no ISRC without asking the resolvers', async () => {
    const { requestUri, resolveSpy } = await setup({ resolve: resolvesTo('spotify:track:x') });

    const err = await rejection(requestUri('apple-music:track:123'));

    expect(err.code).toBe('track_unresolvable');
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it('runs the duplicate check against the resolved uri', async () => {
    const { requestUri, queueItems } = await setup({
      resolve: resolvesTo('spotify:track:abc'),
    });
    await requestUri('spotify:track:abc');

    const err = await rejection(requestUri(ISRC_URI));

    expect(err.code).toBe('duplicate_request');
    expect(await queueItems.findAllForSession(SESSION_ID)).toHaveLength(1);
  });

  it('refuses a guest at their cap before spending a resolution', async () => {
    const { requestUri, resolveSpy } = await setup({
      resolve: resolvesTo('spotify:track:n0'),
    });
    await requestUri('spotify:track:1');
    await requestUri('spotify:track:2');
    await requestUri('spotify:track:3');

    const err = await rejection(requestUri(ISRC_URI));

    expect(err.code).toBe('cap_reached');
    expect(resolveSpy).not.toHaveBeenCalled();
  });
});
