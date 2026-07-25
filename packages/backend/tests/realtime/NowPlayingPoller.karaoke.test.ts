/**
 * NowPlayingPoller — karaoke spotlight + pause/resume integration.
 *
 * Reuses the fake provider / repos / room-manager harness shape from
 * NowPlayingPoller.lyrics.test.ts, extended with pause/resume-capable
 * provider stubs and a REAL KaraokeService sharing the in-memory repos, so
 * these tests exercise the full poller → service → room event path:
 *
 * - track change onto a claimed queue item → `karaoke.spotlight`
 * - `auto` pause mode → provider.pause called + `karaoke.paused`
 * - deadline passed → provider.resume called + `karaoke.resumed`
 * - provider reports playing while karaoke-paused (host resumed from the
 *   existing playback controls) → pause cleared + `karaoke.resumed`
 */

import {
  defineCapabilities,
  PROVIDER_FEATURES,
  type IStreamingProvider,
  type NowPlayingTrack,
} from '@opendj/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KaraokeService } from '../../src/karaoke/KaraokeService.js';
import { NowPlayingPoller } from '../../src/realtime/NowPlayingPoller.js';
import { StreamingRouter } from '../../src/providers/streaming/StreamingRouter.js';
import { RoomRegistryImpl } from '../../src/realtime/RoomRegistryImpl.js';
import {
  InMemoryGuestRepository,
  InMemoryGuestSlotRepository,
  InMemoryKaraokeClaimRepository,
  InMemoryProviderConnectionRepository,
  InMemoryQueueItemRepository,
  InMemorySessionRepository,
} from '../../src/repositories/in-memory/index.js';
import type { ProviderRegistry } from '../../src/providers/streaming/providerRegistry.js';

const NOW = new Date('2026-05-04T17:00:00Z').getTime();
const ACCOUNT_ID = '22222222-2222-2222-2222-222222222222';

function track(uri: string, progressMs = 10_000, isPlaying = true): NowPlayingTrack {
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
  pauseCalls(): number;
  resumeCalls(): number;
}

/**
 * Now-playing + pause/resume capable provider. `pause()`/`resume()` flip
 * the stub's own isPlaying so subsequent ticks observe the effect, like
 * the real Spotify Connect state would.
 */
function makeStubProvider(): { provider: IStreamingProvider; control: StubControl } {
  let current: NowPlayingTrack | null = null;
  let pauseCalls = 0;
  let resumeCalls = 0;
  const feature = (id: string) =>
    ({ id, supported: true, access: 'host', reliability: 'native' }) as const;
  const provider: IStreamingProvider & {
    getNowPlaying: () => Promise<NowPlayingTrack | null>;
    pause: () => Promise<void>;
    resume: () => Promise<void>;
  } = {
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
        [PROVIDER_FEATURES.NowPlayingRead]: feature(PROVIDER_FEATURES.NowPlayingRead),
        [PROVIDER_FEATURES.Pause]: feature(PROVIDER_FEATURES.Pause),
        [PROVIDER_FEATURES.Resume]: feature(PROVIDER_FEATURES.Resume),
      });
    },
    async getNowPlaying() {
      return current;
    },
    async pause() {
      pauseCalls += 1;
      if (current) current = { ...current, isPlaying: false };
    },
    async resume() {
      resumeCalls += 1;
      if (current) current = { ...current, isPlaying: true };
    },
  };
  return {
    provider,
    control: {
      setNowPlaying: (t) => {
        current = t;
      },
      pauseCalls: () => pauseCalls,
      resumeCalls: () => resumeCalls,
    },
  };
}

async function setup(
  opts: {
    karaokePauseMode?: 'off' | 'manual' | 'auto';
    karaokePauseTimeoutSec?: number;
  } = {},
) {
  const clock = { now: () => new Date(NOW) };
  const sessions = new InMemorySessionRepository();
  const guests = new InMemoryGuestRepository(clock);
  const guestSlots = new InMemoryGuestSlotRepository(clock);
  const queueItems = new InMemoryQueueItemRepository(clock);
  const karaokeClaims = new InMemoryKaraokeClaimRepository(clock);
  const providerConnections = new InMemoryProviderConnectionRepository({
    now: () => new Date(NOW),
  });
  await sessions.create({
    accountId: ACCOUNT_ID,
    name: 'Karaoke Night',
    qrSlug: 'karaoke',
  });
  const sessionRow = (await sessions.findByQrSlug('karaoke'))!;
  await providerConnections.upsert({
    accountId: ACCOUNT_ID,
    providerId: 'spotify',
    accessToken: 'fake-access-token',
  });
  Object.assign(sessionRow, {
    accountId: ACCOUNT_ID,
    karaokeMode: 'optional',
    karaokePauseMode: opts.karaokePauseMode ?? 'manual',
    karaokePauseTimeoutSec: opts.karaokePauseTimeoutSec ?? 30,
  });

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
  const room = roomManager.ensureRoom(sessionRow.id);
  const publishedEvents: unknown[] = [];
  await room.connect({
    clientId: 'c-1',
    kind: 'guest',
    sessionId: sessionRow.id,
    connectedAtEpochMs: NOW,
  });
  room.subscribe('c-1', (evt) => publishedEvents.push(evt));

  const karaokeService = new KaraokeService({
    sessions,
    guests,
    guestSlots,
    queueItems,
    karaokeClaims,
    rooms: roomManager,
    streamingRouter,
    providerConnections,
  });

  const logger = { warn: vi.fn() };
  const poller = new NowPlayingPoller(
    {
      sessions,
      providerConnections,
      streamingRouter,
      roomManager,
      karaoke: karaokeService,
    },
    { intervalMs: 5000, idleGraceMs: 30_000, driftThresholdMs: 4000, logger },
  );

  const guest = await guests.create({ sessionId: sessionRow.id, fingerprint: 'fp-1' });

  async function addClaimedItem(trackUri: string, displayName = 'Ana') {
    const item = await queueItems.create({
      sessionId: sessionRow.id,
      guestId: guest.id,
      trackUri,
      trackName: 'Hello',
      artistName: 'World',
      status: 'queued',
    });
    await karaokeClaims.create({
      sessionId: sessionRow.id,
      queueItemId: item.id,
      guestId: guest.id,
      displayName,
    });
    return item;
  }

  function eventsOfType(type: string) {
    return publishedEvents.filter((e) => (e as { type: string }).type === type);
  }

  return {
    poller,
    room,
    sessionId: sessionRow.id,
    guest,
    queueItems,
    karaokeClaims,
    karaokeService,
    control,
    publishedEvents,
    eventsOfType,
    addClaimedItem,
    logger,
  };
}

describe('NowPlayingPoller karaoke wiring', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('track change onto a claimed item broadcasts karaoke.spotlight once', async () => {
    const s = await setup();
    const item = await s.addClaimedItem('spotify:track:aaa');
    s.control.setNowPlaying(track('spotify:track:aaa'));

    s.poller.start(s.sessionId);
    await vi.advanceTimersByTimeAsync(0);
    // Two more ticks with the same track — no re-broadcast.
    await vi.advanceTimersByTimeAsync(10_000);

    expect(s.eventsOfType('karaoke.spotlight')).toEqual([
      {
        type: 'karaoke.spotlight',
        itemId: item.id,
        claims: [{ guestId: s.guest.id, displayName: 'Ana' }],
      },
    ]);
    // Manual mode: no auto-pause.
    expect(s.control.pauseCalls()).toBe(0);
    expect((await s.room.getSnapshot()).karaoke).toEqual({
      spotlightItemId: item.id,
      paused: false,
      pausedUntilEpochMs: null,
    });

    s.poller.stopAll();
  });

  it('an unclaimed track never enters the spotlight (no broadcast at all)', async () => {
    const s = await setup();
    // Queue item exists for the URI but carries no claims.
    await s.queueItems.create({
      sessionId: s.sessionId,
      guestId: s.guest.id,
      trackUri: 'spotify:track:aaa',
      trackName: 'Hello',
      artistName: 'World',
      status: 'queued',
    });
    s.control.setNowPlaying(track('spotify:track:aaa'));

    s.poller.start(s.sessionId);
    await vi.advanceTimersByTimeAsync(0);

    expect(s.eventsOfType('karaoke.spotlight')).toEqual([]);
    s.poller.stopAll();
  });

  it('moving to an unclaimed track clears the spotlight with itemId null', async () => {
    const s = await setup();
    const item = await s.addClaimedItem('spotify:track:aaa');
    s.control.setNowPlaying(track('spotify:track:aaa'));
    s.poller.start(s.sessionId);
    await vi.advanceTimersByTimeAsync(0);

    s.control.setNowPlaying(track('spotify:track:bbb'));
    await vi.advanceTimersByTimeAsync(5000);

    expect(s.eventsOfType('karaoke.spotlight')).toEqual([
      expect.objectContaining({ itemId: item.id }),
      { type: 'karaoke.spotlight', itemId: null, claims: [] },
    ]);
    s.poller.stopAll();
  });

  it('auto pause mode: spotlight start pauses the provider and broadcasts karaoke.paused', async () => {
    const s = await setup({ karaokePauseMode: 'auto', karaokePauseTimeoutSec: 30 });
    const item = await s.addClaimedItem('spotify:track:aaa');
    s.control.setNowPlaying(track('spotify:track:aaa'));

    s.poller.start(s.sessionId);
    await vi.advanceTimersByTimeAsync(0);

    expect(s.control.pauseCalls()).toBe(1);
    expect(s.eventsOfType('karaoke.paused')).toEqual([
      { type: 'karaoke.paused', itemId: item.id, untilEpochMs: NOW + 30_000 },
    ]);
    expect((await s.room.getSnapshot()).karaoke).toEqual({
      spotlightItemId: item.id,
      paused: true,
      pausedUntilEpochMs: NOW + 30_000,
    });

    // Next tick: provider now reports paused — the pause must survive.
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.eventsOfType('karaoke.resumed')).toEqual([]);

    s.poller.stopAll();
  });

  it('auto-resumes via the provider once the deadline passes', async () => {
    const s = await setup({ karaokePauseMode: 'auto', karaokePauseTimeoutSec: 30 });
    const item = await s.addClaimedItem('spotify:track:aaa');
    s.control.setNowPlaying(track('spotify:track:aaa'));
    s.poller.start(s.sessionId);
    await vi.advanceTimersByTimeAsync(0); // paused with deadline NOW + 30s

    // Ticks up to the deadline keep the pause; the first tick past it resumes.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(s.control.resumeCalls()).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);

    expect(s.control.resumeCalls()).toBe(1);
    expect(s.eventsOfType('karaoke.resumed')).toEqual([
      { type: 'karaoke.resumed', itemId: item.id },
    ]);
    expect((await s.room.getSnapshot()).karaoke).toEqual({
      spotlightItemId: item.id,
      paused: false,
      pausedUntilEpochMs: null,
    });
    // Later ticks don't re-resume.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.control.resumeCalls()).toBe(1);

    s.poller.stopAll();
  });

  it('clears the pause without calling resume when the provider reports playing (host resumed)', async () => {
    const s = await setup({ karaokePauseMode: 'auto', karaokePauseTimeoutSec: 30 });
    const item = await s.addClaimedItem('spotify:track:aaa');
    s.control.setNowPlaying(track('spotify:track:aaa'));
    s.poller.start(s.sessionId);
    await vi.advanceTimersByTimeAsync(0); // auto-paused

    // Host hits play from the existing playback controls / Spotify app.
    s.control.setNowPlaying(track('spotify:track:aaa', 12_000, true));
    await vi.advanceTimersByTimeAsync(5000);

    expect(s.eventsOfType('karaoke.resumed')).toEqual([
      { type: 'karaoke.resumed', itemId: item.id },
    ]);
    expect(s.control.resumeCalls()).toBe(0);
    expect((await s.room.getSnapshot()).karaoke.paused).toBe(false);

    s.poller.stopAll();
  });

  it('playback stop clears the spotlight and re-derives it when the track comes back', async () => {
    const s = await setup();
    const item = await s.addClaimedItem('spotify:track:aaa');
    s.control.setNowPlaying(track('spotify:track:aaa'));
    s.poller.start(s.sessionId);
    await vi.advanceTimersByTimeAsync(0);

    s.control.setNowPlaying(null); // device stopped
    await vi.advanceTimersByTimeAsync(5000);
    s.control.setNowPlaying(track('spotify:track:aaa'));
    await vi.advanceTimersByTimeAsync(5000);

    expect(s.eventsOfType('karaoke.spotlight')).toEqual([
      expect.objectContaining({ itemId: item.id }),
      expect.objectContaining({ itemId: null }),
      expect.objectContaining({ itemId: item.id }),
    ]);
    s.poller.stopAll();
  });
});
