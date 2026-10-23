/**
 * NowPlayingPoller — queue reconciliation against a truncated provider queue.
 *
 * Live incident (~100 simulated guests): Spotify's GET /me/player/queue only
 * returns about the next 20 upcoming tracks. Reconciliation treated "not in
 * the visible queue" as "already played", so requests sitting deeper in the
 * queue were marked `played` while still waiting in Spotify — bypassing the
 * per-guest cap and mislabelling the track in the host UI. These tests pin
 * that an item is only marked played on evidence it is gone.
 */

import {
  defineCapabilities,
  PROVIDER_FEATURES,
  type IStreamingProvider,
  type NowPlayingTrack,
  type Track,
} from '@opendj/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderRegistry } from '../../src/providers/streaming/providerRegistry.js';
import { StreamingRouter } from '../../src/providers/streaming/StreamingRouter.js';
import { NowPlayingPoller } from '../../src/realtime/NowPlayingPoller.js';
import { RoomRegistryImpl } from '../../src/realtime/RoomRegistryImpl.js';
import {
  InMemoryProviderConnectionRepository,
  InMemoryQueueItemRepository,
  InMemorySessionRepository,
} from '../../src/repositories/in-memory/index.js';

const NOW = new Date('2026-10-23T20:00:00Z').getTime();
const ACCOUNT_ID = '33333333-3333-3333-3333-333333333333';
const REQ_URI = 'spotify:track:req';

function playing(uri: string): NowPlayingTrack {
  return {
    uri,
    name: uri,
    artist: 'A',
    albumArt: null,
    durationMs: 240_000,
    progressMs: 30_000,
    isPlaying: true,
    zoneId: 'default',
  };
}

function queued(uri: string): Track {
  return { uri, name: uri, artist: 'A', albumArt: null, durationMs: 200_000 };
}

/** `n` filler tracks that never match a guest request. */
function filler(n: number): Track[] {
  return Array.from({ length: n }, (_, i) => queued(`spotify:track:filler-${i}`));
}

function makeProvider() {
  let nowPlaying: NowPlayingTrack | null = null;
  let queue: Track[] = [];
  const pushed: string[] = [];
  const feature = (id: string) => ({
    id,
    supported: true,
    access: 'host' as const,
    reliability: 'native' as const,
  });
  const provider = {
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
        [PROVIDER_FEATURES.NowPlayingRead]: feature(PROVIDER_FEATURES.NowPlayingRead),
        [PROVIDER_FEATURES.QueueRead]: feature(PROVIDER_FEATURES.QueueRead),
        [PROVIDER_FEATURES.QueueTrack]: feature(PROVIDER_FEATURES.QueueTrack),
      }),
    async getNowPlaying() {
      return nowPlaying;
    },
    async getQueue() {
      return queue;
    },
    async queueTrack(input: Track) {
      pushed.push(input.uri);
    },
  } as unknown as IStreamingProvider;
  return {
    provider,
    pushed,
    setNowPlaying: (t: NowPlayingTrack | null) => {
      nowPlaying = t;
    },
    setQueue: (q: Track[]) => {
      queue = q;
    },
  };
}

async function setup() {
  const sessions = new InMemorySessionRepository();
  const providerConnections = new InMemoryProviderConnectionRepository();
  const session = await sessions.create({ accountId: ACCOUNT_ID, name: 'Party', qrSlug: 'party' });
  await providerConnections.upsert({
    accountId: ACCOUNT_ID,
    providerId: 'spotify',
    accessToken: 'tok',
  });
  const stub = makeProvider();
  const streamingRouter = new StreamingRouter({
    providerConnections,
    registry: { spotify: () => stub.provider } as ProviderRegistry,
    context: { fetch: globalThis.fetch },
  });
  const roomManager = new RoomRegistryImpl();
  const room = roomManager.ensureRoom(session.id);
  await room.connect({
    clientId: 'c-1',
    kind: 'guest',
    sessionId: session.id,
    connectedAtEpochMs: NOW,
  });
  // The poller only reschedules while the room has a subscriber.
  room.subscribe('c-1', () => {});
  const queueItems = new InMemoryQueueItemRepository();
  const poller = new NowPlayingPoller(
    { sessions, providerConnections, streamingRouter, roomManager, queueItems },
    { logger: { warn: vi.fn() } },
  );
  const request = (uri = REQ_URI) =>
    queueItems.create({
      sessionId: session.id,
      guestId: 'guest-1',
      trackUri: uri,
      trackName: 'Req',
      artistName: 'A',
      status: 'approved',
    });
  const statusOf = async (id: string) => (await queueItems.findById(id))?.status;
  return { poller, sessionId: session.id, stub, queueItems, request, statusOf };
}

describe('NowPlayingPoller — reconcile against a truncated provider queue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('leaves an old request approved when the visible queue is full (it may be beyond the window)', async () => {
    const { poller, sessionId, stub, request, statusOf } = await setup();
    stub.setNowPlaying(playing('spotify:track:current'));
    stub.setQueue(filler(20));
    const item = await request();

    poller.start(sessionId);
    await vi.advanceTimersByTimeAsync(70_000);

    expect(await statusOf(item.id)).toBe('approved');
    poller.stopAll();
  });

  it('marks an old request played when it is missing from a short (complete) visible queue', async () => {
    const { poller, sessionId, stub, request, statusOf } = await setup();
    stub.setNowPlaying(playing('spotify:track:current'));
    stub.setQueue(filler(5));
    const item = await request();

    poller.start(sessionId);
    await vi.advanceTimersByTimeAsync(70_000);

    expect(await statusOf(item.id)).toBe('played');
    poller.stopAll();
  });

  it('marks a request played once it was seen playing and is no longer current, even with a full queue', async () => {
    const { poller, sessionId, stub, request, statusOf } = await setup();
    stub.setNowPlaying(playing('spotify:track:current'));
    stub.setQueue([queued(REQ_URI), ...filler(19)]);
    const item = await request();

    poller.start(sessionId);
    await vi.advanceTimersByTimeAsync(35_000);
    stub.setNowPlaying(playing(REQ_URI));
    stub.setQueue(filler(20));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await statusOf(item.id)).toBe('playing');

    stub.setNowPlaying(playing('spotify:track:after'));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await statusOf(item.id)).toBe('played');
    poller.stopAll();
  });

  it('does not retry-push a young request missing from a full visible queue', async () => {
    const { poller, sessionId, stub, request } = await setup();
    stub.setNowPlaying(playing('spotify:track:current'));
    stub.setQueue(filler(20));
    await request();

    poller.start(sessionId);
    await vi.advanceTimersByTimeAsync(25_000);

    expect(stub.pushed).toEqual([]);
    poller.stopAll();
  });

  it('retry-pushes a young request missing from a short visible queue', async () => {
    const { poller, sessionId, stub, request } = await setup();
    stub.setNowPlaying(playing('spotify:track:current'));
    stub.setQueue(filler(5));
    await request();

    poller.start(sessionId);
    await vi.advanceTimersByTimeAsync(25_000);

    expect(stub.pushed).toContain(REQ_URI);
    poller.stopAll();
  });

  it('handles duplicate requests of the same URI: full queue keeps both, short queue plays both', async () => {
    const full = await setup();
    full.stub.setNowPlaying(playing('spotify:track:current'));
    full.stub.setQueue(filler(20));
    const a = await full.request();
    const b = await full.request();
    full.poller.start(full.sessionId);
    await vi.advanceTimersByTimeAsync(70_000);
    expect(await full.statusOf(a.id)).toBe('approved');
    expect(await full.statusOf(b.id)).toBe('approved');
    expect(full.stub.pushed).toEqual([]);
    full.poller.stopAll();

    const short = await setup();
    short.stub.setNowPlaying(playing('spotify:track:current'));
    short.stub.setQueue(filler(3));
    const c = await short.request();
    const d = await short.request();
    short.poller.start(short.sessionId);
    await vi.advanceTimersByTimeAsync(70_000);
    expect(await short.statusOf(c.id)).toBe('played');
    expect(await short.statusOf(d.id)).toBe('played');
    short.poller.stopAll();
  });

  it('keeps a duplicate approved request approved while its earlier twin is visible in the queue', async () => {
    const { poller, sessionId, stub, request, statusOf } = await setup();
    stub.setNowPlaying(playing('spotify:track:current'));
    stub.setQueue([queued(REQ_URI), ...filler(4)]);
    const a = await request();
    const b = await request();

    poller.start(sessionId);
    await vi.advanceTimersByTimeAsync(70_000);

    expect(await statusOf(a.id)).toBe('approved');
    expect(await statusOf(b.id)).toBe('approved');
    poller.stopAll();
  });
});
