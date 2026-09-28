/**
 * NowPlayingPoller — Spotify call budget + rate-limit status.
 *
 * Live incident: at a 2.5s cadence with a queue read on every tick the
 * poller alone spent ~2,900 Spotify calls/hour per session and exhausted
 * the app's quota (QUOTA_EXCEEDED, Retry-After ~15.5h) mid-party, while
 * guests saw no sign anything was wrong. These tests pin the reduced call
 * budget and the `provider.status_updated` signalling.
 */

import {
  defineCapabilities,
  PROVIDER_FEATURES,
  type IStreamingProvider,
  type NowPlayingTrack,
  type Track,
} from '@opendj/core';
import type { SessionEvent } from '@opendj/realtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderRateLimitedError } from '../../src/providers/streaming/ProviderCooldowns.js';
import type { ProviderRegistry } from '../../src/providers/streaming/providerRegistry.js';
import { StreamingRouter } from '../../src/providers/streaming/StreamingRouter.js';
import { NowPlayingPoller } from '../../src/realtime/NowPlayingPoller.js';
import { RoomRegistryImpl } from '../../src/realtime/RoomRegistryImpl.js';
import {
  InMemoryProviderConnectionRepository,
  InMemoryQueueItemRepository,
  InMemorySessionRepository,
} from '../../src/repositories/in-memory/index.js';

const NOW = new Date('2026-09-26T23:00:00Z').getTime();
const ACCOUNT_ID = '22222222-2222-2222-2222-222222222222';

function track(uri: string, isPlaying = true): NowPlayingTrack {
  return {
    uri,
    name: uri,
    artist: 'A',
    albumArt: null,
    durationMs: 240_000,
    progressMs: 30_000,
    isPlaying,
    zoneId: 'default',
  };
}

function makeProvider() {
  let nowPlaying: NowPlayingTrack | null = null;
  let queue: Track[] = [];
  let error: Error | null = null;
  const calls = { nowPlaying: 0, queue: 0 };
  const feature = (id: string) => ({
    id,
    supported: true,
    access: 'host' as const,
    reliability: 'native' as const,
  });
  const provider: IStreamingProvider & {
    getNowPlaying(): Promise<NowPlayingTrack | null>;
    getQueue(): Promise<Track[]>;
  } = {
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
      }),
    async getNowPlaying() {
      calls.nowPlaying += 1;
      if (error) throw error;
      return nowPlaying;
    },
    async getQueue() {
      calls.queue += 1;
      if (error) throw error;
      return queue;
    },
  };
  return {
    provider,
    calls,
    setNowPlaying: (t: NowPlayingTrack | null) => {
      nowPlaying = t;
    },
    setQueue: (q: Track[]) => {
      queue = q;
    },
    setError: (e: Error | null) => {
      error = e;
    },
  };
}

async function setup(opts: { withQueueItems?: boolean } = {}) {
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
  const events: SessionEvent[] = [];
  room.subscribe('c-1', (evt) => events.push(evt as SessionEvent));
  const queueItems = opts.withQueueItems ? new InMemoryQueueItemRepository() : undefined;

  // No intervalMs override: these tests pin the production defaults.
  const poller = new NowPlayingPoller(
    {
      sessions,
      providerConnections,
      streamingRouter,
      roomManager,
      ...(queueItems && { queueItems }),
    },
    { logger: { warn: vi.fn() } },
  );
  const statusEvents = () => events.filter((e) => e.type === 'provider.status_updated');
  return { poller, sessionId: session.id, stub, room, queueItems, statusEvents };
}

describe('NowPlayingPoller — call budget', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads now-playing every 5s while a track is playing', async () => {
    const { poller, sessionId, stub } = await setup();
    stub.setNowPlaying(track('spotify:track:a'));
    poller.start(sessionId);
    await vi.advanceTimersByTimeAsync(60_000);

    // t=0 plus one tick every 5s for a minute.
    expect(stub.calls.nowPlaying).toBe(13);
    poller.stopAll();
  });

  it('slows to every 15s while nothing is playing', async () => {
    const { poller, sessionId, stub } = await setup();
    stub.setNowPlaying(track('spotify:track:a', false));
    poller.start(sessionId);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(stub.calls.nowPlaying).toBe(5);
    poller.stopAll();
  });

  it('re-reads the provider queue every 30s, not every tick, while the track is unchanged', async () => {
    const { poller, sessionId, stub } = await setup();
    stub.setNowPlaying(track('spotify:track:a'));
    poller.start(sessionId);
    await vi.advanceTimersByTimeAsync(60_000);

    // t=0, t=30s, t=60s.
    expect(stub.calls.queue).toBe(3);
    poller.stopAll();
  });

  it('re-reads the provider queue as soon as the track changes', async () => {
    const { poller, sessionId, stub } = await setup();
    stub.setNowPlaying(track('spotify:track:a'));
    poller.start(sessionId);
    await vi.advanceTimersByTimeAsync(0);
    expect(stub.calls.queue).toBe(1);

    stub.setNowPlaying(track('spotify:track:b'));
    await vi.advanceTimersByTimeAsync(5000);

    expect(stub.calls.queue).toBe(2);
    poller.stopAll();
  });

  it('keeps reading the queue every tick while a fresh request is waiting to sync', async () => {
    const { poller, sessionId, stub, queueItems } = await setup({ withQueueItems: true });
    stub.setNowPlaying(track('spotify:track:a'));
    poller.start(sessionId);
    await vi.advanceTimersByTimeAsync(0);
    expect(stub.calls.queue).toBe(1);

    // A guest request lands (approved, not yet visible in the provider
    // queue). The retry pump needs a fresh queue read to decide whether
    // to re-push, so reads resume every tick inside the grace window.
    await queueItems!.create({
      sessionId,
      guestId: 'guest-1',
      trackUri: 'spotify:track:req',
      trackName: 'Req',
      artistName: 'A',
      status: 'approved',
    });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(stub.calls.queue).toBe(3);
    poller.stopAll();
  });
});

describe('NowPlayingPoller — provider status', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('publishes rate_limited when a tick is refused by the cooldown', async () => {
    const { poller, sessionId, stub, statusEvents } = await setup();
    stub.setError(new ProviderRateLimitedError('spotify', NOW + 600_000, NOW));
    poller.start(sessionId);
    await vi.advanceTimersByTimeAsync(0);

    expect(statusEvents()).toEqual([
      {
        type: 'provider.status_updated',
        status: { state: 'rate_limited', providerId: 'spotify', untilEpochMs: NOW + 600_000 },
      },
    ]);
    poller.stopAll();
  });

  it('publishes ok again on the first successful tick after the window', async () => {
    const { poller, sessionId, stub, statusEvents, room } = await setup();
    stub.setError(new ProviderRateLimitedError('spotify', NOW + 60_000, NOW));
    poller.start(sessionId);
    await vi.advanceTimersByTimeAsync(0);

    stub.setError(null);
    stub.setNowPlaying(track('spotify:track:a'));
    await vi.advanceTimersByTimeAsync(61_000);

    expect(statusEvents().at(-1)).toEqual({
      type: 'provider.status_updated',
      status: { state: 'ok' },
    });
    expect((await room.getSnapshot()).providerStatus).toEqual({ state: 'ok' });
    poller.stopAll();
  });

  it('notifyRateLimited fans the cooldown out to every polled session on that account', async () => {
    const { poller, sessionId, stub, statusEvents } = await setup();
    stub.setNowPlaying(track('spotify:track:a'));
    poller.start(sessionId);
    await vi.advanceTimersByTimeAsync(0);

    await poller.notifyRateLimited({
      accountId: ACCOUNT_ID,
      providerId: 'spotify',
      untilEpochMs: NOW + 900_000,
    });
    await poller.notifyRateLimited({
      accountId: 'someone-else',
      providerId: 'spotify',
      untilEpochMs: NOW + 900_000,
    });

    expect(statusEvents()).toEqual([
      {
        type: 'provider.status_updated',
        status: { state: 'rate_limited', providerId: 'spotify', untilEpochMs: NOW + 900_000 },
      },
    ]);
    poller.stopAll();
  });
});
