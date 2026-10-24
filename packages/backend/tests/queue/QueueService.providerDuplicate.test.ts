/**
 * QueueService — duplicate check against the host's provider queue.
 *
 * With duplicates off, a request is also refused when its (resolved,
 * native) uri is already in the provider's upcoming queue or is the track
 * playing right now — e.g. a host added it in Spotify directly, or its
 * earlier OpenDJ request was retired early. The check reads the snapshot the
 * NowPlayingPoller already keeps; it never calls the provider. Unknown state
 * lets the request through.
 */

import {
  defineCapabilities,
  PROVIDER_FEATURES,
  type IStreamingProvider,
  type QueueResult,
  type Track,
} from '@opendj/core';
import { NodeSessionRoom } from '@opendj/realtime';
import { describe, expect, it, vi } from 'vitest';
import { ProviderCooldowns } from '../../src/providers/streaming/ProviderCooldowns.js';
import type { ProviderRegistry } from '../../src/providers/streaming/providerRegistry.js';
import { StreamingRouter } from '../../src/providers/streaming/StreamingRouter.js';
import {
  QueueService,
  QueueServiceError,
  roomProviderQueueView,
  type ProviderQueueView,
} from '../../src/queue/QueueService.js';
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
const NOW = new Date('2026-10-23T23:00:00Z').getTime();

const TRACK: Track = {
  uri: 'spotify:track:dontstop',
  name: "Don't Stop Believin'",
  artist: 'Journey',
  albumArt: null,
  durationMs: 250_000,
};

async function setup(
  opts: {
    allowDuplicates?: boolean;
    moderationEnabled?: boolean;
    providerQueueView?: ProviderQueueView;
    resolveTo?: string;
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
    allowDuplicates: opts.allowDuplicates ?? false,
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
  const streamingRouter = new StreamingRouter({
    providerConnections,
    registry: { spotify: () => provider } as ProviderRegistry,
    context: { fetch: globalThis.fetch },
    cooldowns: new ProviderCooldowns(),
  });

  const service = new QueueService({
    sessions,
    guests,
    guestSlots,
    queueItems,
    queueSkipVotes: new InMemoryQueueSkipVoteRepository(queueItems, clock),
    karaokeClaims: new InMemoryKaraokeClaimRepository(clock),
    streamingRouter,
    providerConnections,
    ...(opts.providerQueueView && { providerQueueView: opts.providerQueueView }),
    ...(opts.resolveTo && {
      trackResolver: {
        resolve: async () => ({ uri: opts.resolveTo as string, resolverId: 'test' }),
      },
    }),
  });

  await guests.create({ sessionId: SESSION_ID, fingerprint: 'fp-1', userId: null });
  await guestSlots.create({
    sessionId: SESSION_ID,
    fingerprintHash: 'fp-1',
    slotToken: 'slot-1',
    status: 'active',
  });

  const requestUri = (uri: string) =>
    service.requestTrack(
      { sessionId: SESSION_ID, slotToken: 'slot-1', track: { ...TRACK, uri } },
      NOW,
    );
  return { queueItems, queueTrack, requestUri };
}

async function rejection(promise: Promise<unknown>): Promise<QueueServiceError> {
  const err = await promise.catch((e: unknown) => e);
  if (!(err instanceof QueueServiceError))
    throw new Error(`expected QueueServiceError, got ${err}`);
  return err;
}

const viewOf = (uris: string[] | null): ProviderQueueView => ({
  upcomingUris: vi.fn(async () => (uris === null ? null : new Set(uris))),
});

describe('QueueService.requestTrack — provider-queue duplicates', () => {
  it('rejects a uri already in the provider upcoming queue with duplicate_request and no push', async () => {
    const { requestUri, queueItems, queueTrack } = await setup({
      providerQueueView: viewOf(['spotify:track:other', TRACK.uri]),
    });

    const err = await rejection(requestUri(TRACK.uri));

    expect(err.code).toBe('duplicate_request');
    expect(queueTrack).not.toHaveBeenCalled();
    // Nothing inserted, so the guest's cap slot is not consumed.
    expect(await queueItems.findAllForSession(SESSION_ID)).toEqual([]);
  });

  it('rejects the currently playing track', async () => {
    const { requestUri, queueTrack } = await setup({
      providerQueueView: roomViewWith({ nowPlayingUri: TRACK.uri, queue: [] }),
    });

    const err = await rejection(requestUri(TRACK.uri));

    expect(err.code).toBe('duplicate_request');
    expect(queueTrack).not.toHaveBeenCalled();
  });

  it('rejects a moderated request too (no pending row created)', async () => {
    const { requestUri, queueItems } = await setup({
      moderationEnabled: true,
      providerQueueView: viewOf([TRACK.uri]),
    });

    const err = await rejection(requestUri(TRACK.uri));

    expect(err.code).toBe('duplicate_request');
    expect(await queueItems.findAllForSession(SESSION_ID)).toEqual([]);
  });

  it('compares the resolved native uri, not the requested one', async () => {
    const { requestUri, queueTrack } = await setup({
      resolveTo: TRACK.uri,
      providerQueueView: viewOf([TRACK.uri]),
    });

    const err = await rejection(requestUri('opendj:isrc:USSM18100116'));

    expect(err.code).toBe('duplicate_request');
    expect(queueTrack).not.toHaveBeenCalled();
  });

  it('allows the request when the provider snapshot is unknown', async () => {
    const { requestUri, queueTrack } = await setup({ providerQueueView: viewOf(null) });

    const created = await requestUri(TRACK.uri);

    expect(created.trackUri).toBe(TRACK.uri);
    expect(queueTrack).toHaveBeenCalledTimes(1);
  });

  it('allows the request when reading the snapshot fails', async () => {
    const { requestUri, queueTrack } = await setup({
      providerQueueView: {
        upcomingUris: async () => {
          throw new Error('redis down');
        },
      },
    });

    await requestUri(TRACK.uri);

    expect(queueTrack).toHaveBeenCalledTimes(1);
  });

  it('allows a uri the provider has queued when the session allows duplicates', async () => {
    const view = viewOf([TRACK.uri]);
    const { requestUri, queueTrack } = await setup({
      allowDuplicates: true,
      providerQueueView: view,
    });

    await requestUri(TRACK.uri);

    expect(queueTrack).toHaveBeenCalledTimes(1);
    expect(view.upcomingUris).not.toHaveBeenCalled();
  });

  it('allows a uri not in the provider queue', async () => {
    const { requestUri, queueTrack } = await setup({
      providerQueueView: viewOf(['spotify:track:other']),
    });

    await requestUri(TRACK.uri);

    expect(queueTrack).toHaveBeenCalledTimes(1);
  });
});

/** Build the real room-backed view over a NodeSessionRoom fed poller events. */
function roomViewWith(state: { nowPlayingUri: string | null; queue: string[] }): ProviderQueueView {
  const room = new NodeSessionRoom({ sessionId: SESSION_ID, nowEpochMs: () => NOW });
  const ready = (async () => {
    if (state.nowPlayingUri) {
      await room.publish({
        type: 'now_playing.updated',
        track: { ...TRACK, uri: state.nowPlayingUri, progressMs: 0, isPlaying: true, zoneId: 'z' },
      });
    }
    if (state.queue.length > 0) {
      await room.publish({
        type: 'provider_queue.updated',
        tracks: state.queue.map((uri) => ({ ...TRACK, uri })),
      });
    }
  })();
  const view = roomProviderQueueView({ forSession: (id) => (id === SESSION_ID ? room : null) });
  return {
    upcomingUris: async (sessionId) => {
      await ready;
      return view.upcomingUris(sessionId);
    },
  };
}

describe('roomProviderQueueView', () => {
  it('returns the provider queue plus now playing from the room snapshot', async () => {
    const view = roomViewWith({ nowPlayingUri: 'spotify:track:np', queue: ['spotify:track:q1'] });

    const uris = await view.upcomingUris(SESSION_ID);

    expect(uris && [...uris].sort()).toEqual(['spotify:track:np', 'spotify:track:q1']);
  });

  it('returns null when no room is bound to the session', async () => {
    const view = roomProviderQueueView({ forSession: () => null });

    expect(await view.upcomingUris(SESSION_ID)).toBeNull();
  });

  it('returns null when the poller has not reported anything yet', async () => {
    const view = roomViewWith({ nowPlayingUri: null, queue: [] });

    expect(await view.upcomingUris(SESSION_ID)).toBeNull();
  });
});
