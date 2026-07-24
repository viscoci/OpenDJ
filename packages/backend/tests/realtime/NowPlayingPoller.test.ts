/**
 * NowPlayingPoller — per-session ticker that publishes `now_playing.updated`
 * to the realtime room only on a meaningful diff. Tests cover the lifecycle
 * (start/stop/idle-grace), the diff predicate, and the error paths the
 * poller has to handle gracefully (401 → stop, 429 → backoff, transient
 * → continue).
 */

import {
  defineCapabilities,
  PROVIDER_FEATURES,
  type IStreamingProvider,
  type NowPlayingTrack,
} from '@opendj/core';
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
  opts: { intervalMs?: number; idleGraceMs?: number; driftThresholdMs?: number } = {},
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
  const sentEvents: unknown[] = [];
  await room.connect({
    clientId: 'c-1',
    kind: 'guest',
    sessionId: sessionRow.id,
    connectedAtEpochMs: NOW,
  });
  room.subscribe('c-1', (evt) => sentEvents.push(evt));

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
    sentEvents,
    logger,
  };
}

describe('NowPlayingPoller — diff predicate', () => {
  it('does not publish when both prev and next are null', async () => {
    const { poller } = await setup();
    expect(poller.shouldPublish(null, null)).toBe(false);
  });

  it('publishes when going from null to a track', async () => {
    const { poller } = await setup();
    expect(poller.shouldPublish(null, track('spotify:track:a'))).toBe(true);
  });

  it('publishes when going from a track to null', async () => {
    const { poller } = await setup();
    expect(poller.shouldPublish(track('spotify:track:a'), null)).toBe(true);
  });

  it('publishes when the track URI changes', async () => {
    const { poller } = await setup();
    expect(poller.shouldPublish(track('spotify:track:a'), track('spotify:track:b'))).toBe(true);
  });

  it('publishes when isPlaying flips', async () => {
    const { poller } = await setup();
    const prev = track('spotify:track:a', 30_000, true);
    const next = track('spotify:track:a', 30_500, false);
    expect(poller.shouldPublish(prev, next)).toBe(true);
  });

  it('does not publish when only progressMs drifts within threshold', async () => {
    const { poller } = await setup({ driftThresholdMs: 4000 });
    const prev = track('spotify:track:a', 30_000, true);
    const next = track('spotify:track:a', 33_000, true);
    expect(poller.shouldPublish(prev, next)).toBe(false);
  });

  it('publishes when progressMs drift exceeds threshold', async () => {
    const { poller } = await setup({ driftThresholdMs: 4000 });
    const prev = track('spotify:track:a', 30_000, true);
    const next = track('spotify:track:a', 36_000, true);
    expect(poller.shouldPublish(prev, next)).toBe(true);
  });
});

describe('NowPlayingPoller — lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('start kicks off an immediate tick', async () => {
    const { poller, sessionId, control, sentEvents } = await setup({ intervalMs: 5000 });
    control.setNowPlaying(track('spotify:track:a'));
    poller.start(sessionId);
    expect(poller.size()).toBe(1);
    await vi.advanceTimersByTimeAsync(0);
    // Each tick also publishes a `playback.clock_sampled` event alongside
    // `now_playing.updated` (see NowPlayingPoller.lyrics.test.ts) — filter
    // to the event this test cares about.
    const nowPlayingEvents = sentEvents.filter(
      (e) => (e as { type: string }).type === 'now_playing.updated',
    );
    expect(nowPlayingEvents).toHaveLength(1);
    expect(nowPlayingEvents[0]).toMatchObject({
      type: 'now_playing.updated',
      track: { uri: 'spotify:track:a' },
    });
  });

  it('reschedules at intervalMs after a tick', async () => {
    const { poller, sessionId, control, sentEvents } = await setup({ intervalMs: 5000 });
    // Each tick also publishes a `playback.clock_sampled` event alongside
    // `now_playing.updated` (see NowPlayingPoller.lyrics.test.ts) — filter
    // to the event this test cares about.
    const nowPlayingEvents = () =>
      sentEvents.filter((e) => (e as { type: string }).type === 'now_playing.updated');
    control.setNowPlaying(track('spotify:track:a'));
    poller.start(sessionId);
    await vi.advanceTimersByTimeAsync(0);
    expect(nowPlayingEvents()).toHaveLength(1);

    // Same track, small drift — should NOT republish.
    control.setNowPlaying(track('spotify:track:a', 32_000));
    await vi.advanceTimersByTimeAsync(5000);
    expect(nowPlayingEvents()).toHaveLength(1);

    // Track change → should publish.
    control.setNowPlaying(track('spotify:track:b'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(nowPlayingEvents()).toHaveLength(2);
    expect(nowPlayingEvents()[1]).toMatchObject({ track: { uri: 'spotify:track:b' } });
  });

  it('start is idempotent — second start while running is a no-op', async () => {
    const { poller, sessionId, control } = await setup({ intervalMs: 5000 });
    control.setNowPlaying(track('a'));
    poller.start(sessionId);
    poller.start(sessionId);
    expect(poller.size()).toBe(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(control.callCount()).toBe(1);
  });

  it('stop schedules teardown after idleGraceMs', async () => {
    const { poller, sessionId, control } = await setup({ idleGraceMs: 30_000 });
    control.setNowPlaying(track('a'));
    poller.start(sessionId);
    await vi.advanceTimersByTimeAsync(0);
    poller.stop(sessionId);
    expect(poller.size()).toBe(1);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(poller.size()).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(poller.size()).toBe(0);
  });

  it('start during the idle grace cancels the teardown', async () => {
    const { poller, sessionId, control } = await setup({ idleGraceMs: 30_000 });
    control.setNowPlaying(track('a'));
    poller.start(sessionId);
    await vi.advanceTimersByTimeAsync(0);
    poller.stop(sessionId);
    await vi.advanceTimersByTimeAsync(15_000);
    poller.start(sessionId); // cancels teardown
    await vi.advanceTimersByTimeAsync(20_000);
    expect(poller.size()).toBe(1);
  });

  it('stops when the session is ended', async () => {
    const { poller, sessions, sessionId, control } = await setup();
    control.setNowPlaying(track('a'));
    poller.start(sessionId);
    await vi.advanceTimersByTimeAsync(0);
    expect(poller.size()).toBe(1);

    await sessions.end(sessionId, new Date(NOW + 60_000));
    await vi.advanceTimersByTimeAsync(5000);
    expect(poller.size()).toBe(0);
  });

  it('stops on 401 from the provider', async () => {
    const { poller, sessionId, control, logger } = await setup();
    control.setNowPlaying(track('a'));
    poller.start(sessionId);
    await vi.advanceTimersByTimeAsync(0);
    expect(poller.size()).toBe(1);

    // Inject a 401 on next tick.
    const err = Object.assign(new Error('Spotify says nope'), { status: 401 });
    control.setError(err);
    await vi.advanceTimersByTimeAsync(5000);
    expect(poller.size()).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('401'),
      expect.objectContaining({ sessionId }),
    );
  });

  it('backs off on 429 instead of stopping', async () => {
    const { poller, sessionId, control, logger } = await setup({ intervalMs: 5000 });
    control.setNowPlaying(track('a'));
    poller.start(sessionId);
    await vi.advanceTimersByTimeAsync(0);

    const err = Object.assign(new Error('rate limited'), { status: 429 });
    control.setError(err);
    await vi.advanceTimersByTimeAsync(5000);
    expect(poller.size()).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('429'),
      expect.objectContaining({ sessionId, delayMs: expect.any(Number) }),
    );

    // Recovers after error clears.
    control.setError(null);
    control.setNowPlaying(track('b'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(poller.size()).toBe(1);
  });

  it('continues at base interval on transient errors', async () => {
    const { poller, sessionId, control, logger } = await setup({ intervalMs: 5000 });
    control.setNowPlaying(track('a'));
    poller.start(sessionId);
    await vi.advanceTimersByTimeAsync(0);

    control.setError(new Error('ECONNRESET'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(poller.size()).toBe(1);

    control.setError(null);
    control.setNowPlaying(track('b'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(poller.size()).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('tick failed'),
      expect.objectContaining({ sessionId, error: 'ECONNRESET' }),
    );
  });

  it('stopAll clears every active session', async () => {
    const { poller, sessionId, control } = await setup();
    control.setNowPlaying(track('a'));
    poller.start(sessionId);
    poller.start('other-session');
    expect(poller.size()).toBe(2);
    poller.stopAll();
    expect(poller.size()).toBe(0);
  });
});
