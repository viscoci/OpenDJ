/**
 * NowPlayingPoller — sync layer: `playback.clock_sampled` broadcast, plus
 * the lyrics-on-track-change wiring.
 *
 * Reuses the same fake provider / repos / room-manager harness as
 * NowPlayingPoller.test.ts (see that file for the full lifecycle suite).
 * This file covers the clock-sample publish added on top of the existing
 * `now_playing.updated` tick, and the `lyrics.loaded` publish that fires
 * a cache-fronted lyrics lookup on track change.
 */

import {
  defineCapabilities,
  PROVIDER_FEATURES,
  type IStreamingProvider,
  type NowPlayingTrack,
} from '@opendj/core';
import type { LyricsDocument } from '@opendj/lyrics';
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

interface FakeLyricsLookupCall {
  trackName: string;
  artistName: string;
  durationMs?: number | null;
  providerTrackUri?: string;
}

interface FakeLyricsLookup {
  lookup(input: FakeLyricsLookupCall): Promise<LyricsDocument | null>;
  calls: FakeLyricsLookupCall[];
  /** Resolve the pending lookup previously issued for `providerTrackUri`. */
  resolve(providerTrackUri: string, doc: LyricsDocument | null): void;
  /** Reject the pending lookup previously issued for `providerTrackUri`. */
  reject(providerTrackUri: string, err: unknown): void;
}

/**
 * Controllable fake for `NowPlayingPollerDeps.lyricsLookup`. Each call to
 * `lookup()` records the input and returns a promise that stays pending
 * until the test explicitly resolves/rejects it via the returned handle —
 * lets tests control lookup-vs-tick ordering (e.g. the stale-result test).
 */
function makeFakeLyricsLookup(): FakeLyricsLookup {
  const calls: FakeLyricsLookupCall[] = [];
  const pending = new Map<
    string,
    { resolve: (doc: LyricsDocument | null) => void; reject: (err: unknown) => void }
  >();
  return {
    calls,
    lookup(input) {
      calls.push(input);
      return new Promise<LyricsDocument | null>((resolve, reject) => {
        pending.set(input.providerTrackUri ?? '', { resolve, reject });
      });
    },
    resolve(providerTrackUri, doc) {
      pending.get(providerTrackUri)?.resolve(doc);
    },
    reject(providerTrackUri, err) {
      pending.get(providerTrackUri)?.reject(err);
    },
  };
}

const LYRICS_DOC: LyricsDocument = {
  id: 'lrclib:1',
  source: 'lrclib',
  trackName: 'A',
  artistName: 'B',
  albumName: null,
  durationMs: 200_000,
  isSynced: true,
  lines: [],
  matchConfidence: 'high',
};

async function setup(
  opts: {
    intervalMs?: number;
    idleGraceMs?: number;
    driftThresholdMs?: number;
    nowEpochMs?: () => number;
    lyricsLookup?: FakeLyricsLookup;
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
      ...(opts.lyricsLookup !== undefined && { lyricsLookup: opts.lyricsLookup }),
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

describe('NowPlayingPoller lyrics wiring', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('looks up lyrics on track change and publishes lyrics.loaded', async () => {
    const fakeLyrics = makeFakeLyricsLookup();
    const { poller, sessionId, control, publishedEvents } = await setup({
      lyricsLookup: fakeLyrics,
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

    // The lookup was fired but not yet resolved — resolve it and flush.
    fakeLyrics.resolve('spotify:track:aaa', LYRICS_DOC);
    await vi.advanceTimersByTimeAsync(0);

    expect(fakeLyrics.calls).toEqual([
      {
        trackName: 'A',
        artistName: 'B',
        durationMs: 200_000,
        providerTrackUri: 'spotify:track:aaa',
      },
    ]);
    const loaded = publishedEvents.filter((e) => (e as { type: string }).type === 'lyrics.loaded');
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({ trackUri: 'spotify:track:aaa' });
    expect((loaded[0] as { lyrics: unknown }).lyrics).not.toBeNull();

    poller.stopAll();
  });

  it('does not re-lookup for the same track on subsequent ticks', async () => {
    const fakeLyrics = makeFakeLyricsLookup();
    const { poller, sessionId, control, publishedEvents } = await setup({
      intervalMs: 5000,
      lyricsLookup: fakeLyrics,
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
    fakeLyrics.resolve('spotify:track:aaa', LYRICS_DOC);
    await vi.advanceTimersByTimeAsync(0);

    // Second tick, same track (progress drifted forward) — no new lookup.
    control.setNowPlaying({
      uri: 'spotify:track:aaa',
      name: 'A',
      artist: 'B',
      albumArt: null,
      durationMs: 200_000,
      progressMs: 15_000,
      isPlaying: true,
      zoneId: 'default',
    });
    await vi.advanceTimersByTimeAsync(5000);

    expect(fakeLyrics.calls).toHaveLength(1);
    const loaded = publishedEvents.filter((e) => (e as { type: string }).type === 'lyrics.loaded');
    expect(loaded).toHaveLength(1);

    poller.stopAll();
  });

  it('publishes lyrics.loaded with null lyrics when lookup rejects', async () => {
    const fakeLyrics = makeFakeLyricsLookup();
    const { poller, sessionId, control, publishedEvents } = await setup({
      lyricsLookup: fakeLyrics,
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

    expect(() => fakeLyrics.reject('spotify:track:aaa', new Error('lookup boom'))).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);

    const loaded = publishedEvents.filter((e) => (e as { type: string }).type === 'lyrics.loaded');
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({ trackUri: 'spotify:track:aaa', lyrics: null });

    poller.stopAll();
  });

  it('suppresses a stale lookup result after the track changed again', async () => {
    const fakeLyrics = makeFakeLyricsLookup();
    const { poller, sessionId, control, publishedEvents } = await setup({
      intervalMs: 5000,
      lyricsLookup: fakeLyrics,
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

    // Track moves on to bbb on the next tick, before aaa's lookup resolves.
    control.setNowPlaying({
      uri: 'spotify:track:bbb',
      name: 'C',
      artist: 'D',
      albumArt: null,
      durationMs: 180_000,
      progressMs: 0,
      isPlaying: true,
      zoneId: 'default',
    });
    await vi.advanceTimersByTimeAsync(5000);

    // aaa's lookup resolves late — the room's now-playing already moved to
    // bbb, so the stale result must be suppressed (no lyrics.loaded: aaa).
    fakeLyrics.resolve('spotify:track:aaa', LYRICS_DOC);
    await vi.advanceTimersByTimeAsync(0);

    let loaded = publishedEvents.filter((e) => (e as { type: string }).type === 'lyrics.loaded');
    expect(loaded).toHaveLength(0);

    // bbb's own lookup resolving does publish.
    fakeLyrics.resolve('spotify:track:bbb', LYRICS_DOC);
    await vi.advanceTimersByTimeAsync(0);

    loaded = publishedEvents.filter((e) => (e as { type: string }).type === 'lyrics.loaded');
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({ trackUri: 'spotify:track:bbb' });

    poller.stopAll();
  });
});
