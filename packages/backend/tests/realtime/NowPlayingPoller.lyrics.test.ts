/**
 * NowPlayingPoller — sync layer: `playback.clock_sampled` broadcast.
 *
 * Reuses the same fake provider / repos / room-manager harness as
 * NowPlayingPoller.test.ts (see that file for the full lifecycle suite).
 * This file only covers the clock-sample publish added on top of the
 * existing `now_playing.updated` tick.
 */

import {
  defineCapabilities,
  PROVIDER_FEATURES,
  type IStreamingProvider,
  type NowPlayingTrack,
} from '@opendj/core';
import type { PlaybackClockSample } from '@opendj/sync';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NowPlayingPoller } from '../../src/realtime/NowPlayingPoller.js';
import { StreamingRouter } from '../../src/providers/streaming/StreamingRouter.js';
import { RoomRegistryImpl } from '../../src/realtime/RoomRegistryImpl.js';
import {
  InMemoryProviderConnectionRepository,
  InMemorySessionRepository,
} from '../../src/repositories/in-memory/index.js';
import type { ProviderRegistry } from '../../src/providers/streaming/providerRegistry.js';

const NOW = new Date('2026-05-04T17:00:00Z').getTime();
const SESSION_ID = '11111111-1111-1111-1111-111111111111';
const ACCOUNT_ID = '22222222-2222-2222-2222-222222222222';

function track(uri: string, progressMs = 30_000, isPlaying = true): NowPlayingTrack {
  return {
    uri,
    name: uri,
    artist: 'A',
    albumArt: null,
    durationMs: 240_000,
    progressMs,
    isPlaying,
    zoneId: 'default',
  };
}

interface StubControl {
  setNowPlaying(t: NowPlayingTrack | null): void;
  setError(err: Error | null): void;
  callCount(): number;
}

function makeStubProvider(): { provider: IStreamingProvider; control: StubControl } {
  let current: NowPlayingTrack | null = null;
  let error: Error | null = null;
  let calls = 0;
  const provider: IStreamingProvider & { getNowPlaying: () => Promise<NowPlayingTrack | null> } = {
    providerId: 'spotify',
    displayName: 'Spotify',
    async connect() {},
    async disconnect() {},
    isConnected() {
      return true;
    },
    async refreshCredentials() {
      return {};
    },
    getCapabilities() {
      return defineCapabilities('spotify', {
        [PROVIDER_FEATURES.NowPlayingRead]: {
          id: PROVIDER_FEATURES.NowPlayingRead,
          supported: true,
          access: 'host',
          reliability: 'native',
        },
      });
    },
    async getNowPlaying() {
      calls += 1;
      if (error) throw error;
      return current;
    },
  };
  return {
    provider,
    control: {
      setNowPlaying: (t) => {
        current = t;
      },
      setError: (err) => {
        error = err;
      },
      callCount: () => calls,
    },
  };
}

async function setup(
  opts: {
    intervalMs?: number;
    idleGraceMs?: number;
    driftThresholdMs?: number;
    nowEpochMs?: () => number;
  } = {},
) {
  const sessions = new InMemorySessionRepository();
  const providerConnections = new InMemoryProviderConnectionRepository({
    now: () => new Date(NOW),
  });
  await sessions.create({
    accountId: ACCOUNT_ID,
    name: 'Test Session',
    qrSlug: 'test-slug',
  });
  const sessionRow = (await sessions.findByQrSlug('test-slug'))!;
  // Pre-seed a Spotify connection so the poller resolves a provider.
  await providerConnections.upsert({
    accountId: ACCOUNT_ID,
    providerId: 'spotify',
    accessToken: 'fake-access-token',
  });
  // Override accountId on the session to match.
  Object.assign(sessionRow, { accountId: ACCOUNT_ID });

  const { provider, control } = makeStubProvider();
  const registry: ProviderRegistry = {
    spotify: () => provider,
  } as ProviderRegistry;
  const streamingRouter = new StreamingRouter({
    providerConnections,
    registry,
    context: { fetch: globalThis.fetch },
  });
  const roomManager = new RoomRegistryImpl();
  // Materialize the room so subscribedCount can be checked.
  const room = roomManager.ensureRoom(sessionRow.id);
  // Connect a fake subscriber.
  const publishedEvents: unknown[] = [];
  await room.connect({
    clientId: 'c-1',
    kind: 'guest',
    sessionId: sessionRow.id,
    connectedAtEpochMs: NOW,
  });
  room.subscribe('c-1', (evt) => publishedEvents.push(evt));

  const logger = { warn: vi.fn() };
  const poller = new NowPlayingPoller(
    {
      sessions,
      providerConnections,
      streamingRouter,
      roomManager,
    },
    {
      intervalMs: opts.intervalMs ?? 5000,
      idleGraceMs: opts.idleGraceMs ?? 30_000,
      driftThresholdMs: opts.driftThresholdMs ?? 4000,
      nowEpochMs: opts.nowEpochMs,
      logger,
    },
  );

  return {
    poller,
    sessions,
    providerConnections,
    roomManager,
    room,
    sessionId: sessionRow.id,
    control,
    publishedEvents,
    logger,
  };
}

describe('NowPlayingPoller clock sampling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('publishes playback.clock_sampled with a sample built from now-playing on each tick', async () => {
    const { poller, sessionId, control, publishedEvents } = await setup({
      nowEpochMs: () => 1_000_000,
    });
    control.setNowPlaying({
      uri: 'spotify:track:aaa',
      name: 'A',
      artist: 'B',
      albumArt: null,
      durationMs: 200_000,
      progressMs: 10_000,
      isPlaying: true,
      zoneId: 'default',
    });
    poller.start(sessionId);
    await vi.advanceTimersByTimeAsync(0);

    const clockEvents = publishedEvents.filter(
      (e) => (e as { type: string }).type === 'playback.clock_sampled',
    );
    expect(clockEvents).toHaveLength(1);
    const sample = (clockEvents[0] as { sample: PlaybackClockSample }).sample;
    expect(sample.trackUri).toBe('spotify:track:aaa');
    expect(sample.progressMs).toBe(10_000);
    expect(sample.isPlaying).toBe(true);
    expect(sample.sampledAtEpochMs).toBe(1_000_000);

    poller.stopAll();
  });

  it('does not publish a clock sample when nothing is playing', async () => {
    const { poller, sessionId, control, publishedEvents } = await setup({
      nowEpochMs: () => 1_000_000,
    });
    control.setNowPlaying(null);
    poller.start(sessionId);
    await vi.advanceTimersByTimeAsync(0);

    expect(control.callCount()).toBeGreaterThan(0);
    const clockEvents = publishedEvents.filter(
      (e) => (e as { type: string }).type === 'playback.clock_sampled',
    );
    expect(clockEvents).toHaveLength(0);

    poller.stopAll();
  });
});
