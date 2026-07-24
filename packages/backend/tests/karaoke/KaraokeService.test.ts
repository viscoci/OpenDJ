import { describe, expect, it } from 'vitest';
import { NodeSessionRoom } from '@opendj/realtime';
import { defineCapabilities, PROVIDER_FEATURES, type IStreamingProvider } from '@opendj/core';
import { KaraokeService, type KaraokeRoomRegistry } from '../../src/karaoke/KaraokeService.js';
import { sanitizeKaraokeDisplayName } from '../../src/karaoke/displayName.js';
import { StreamingRouter } from '../../src/providers/streaming/StreamingRouter.js';
import type { ProviderRegistry } from '../../src/providers/streaming/providerRegistry.js';
import {
  InMemoryGuestRepository,
  InMemoryGuestSlotRepository,
  InMemoryKaraokeClaimRepository,
  InMemoryProviderConnectionRepository,
  InMemoryQueueItemRepository,
  InMemorySessionRepository,
} from '../../src/repositories/in-memory/index.js';
import type { QueueItemStatus, SessionRecord } from '../../src/repositories/types.js';

/**
 * Stub provider used only to assert pause/resume call counts (e.g. that a
 * karaoke-off clear never calls provider resume — the host controls
 * playback directly once karaoke is off).
 */
function makeStubProvider(): {
  provider: IStreamingProvider;
  pauseCalls: () => number;
  resumeCalls: () => number;
} {
  let pauseCalls = 0;
  let resumeCalls = 0;
  const feature = (id: string) =>
    ({ id, supported: true, access: 'host', reliability: 'native' }) as const;
  const provider: IStreamingProvider = {
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
        [PROVIDER_FEATURES.Pause]: feature(PROVIDER_FEATURES.Pause),
        [PROVIDER_FEATURES.Resume]: feature(PROVIDER_FEATURES.Resume),
      });
    },
    async pause() {
      pauseCalls += 1;
    },
    async resume() {
      resumeCalls += 1;
    },
  } as IStreamingProvider;
  return { provider, pauseCalls: () => pauseCalls, resumeCalls: () => resumeCalls };
}

const SESSION_ID = '11111111-1111-1111-1111-111111111111';
const NOW = new Date('2026-04-30T12:00:00Z').getTime();

const baseSession: SessionRecord = {
  id: SESSION_ID,
  accountId: '22222222-2222-2222-2222-222222222222',
  name: 'Karaoke Night',
  qrSlug: 'karaoke',
  guestCapOverride: null,
  songsPerGuestCap: 3,
  maxConsecutivePerGuest: null,
  allowDuplicates: false,
  moderationEnabled: false,
  voteSkipMode: 'fixed',
  voteSkipThreshold: 5,
  karaokeMode: 'optional',
  karaokeMicCount: 1,
  karaokePauseMode: 'manual',
  karaokePauseTimeoutSec: 30,
  startedAt: new Date(NOW),
  endedAt: null,
};

function setup(
  opts: {
    karaokeMode?: 'off' | 'optional' | 'required';
    karaokeMicCount?: number;
    karaokePauseMode?: 'off' | 'manual' | 'auto';
    karaokePauseTimeoutSec?: number;
    /** Wire a stub streaming provider so pause/resume calls are countable. */
    withProviderMock?: boolean;
  } = {},
) {
  const clock = { now: () => new Date(NOW) };
  const sessions = new InMemorySessionRepository();
  const guests = new InMemoryGuestRepository(clock);
  const guestSlots = new InMemoryGuestSlotRepository(clock);
  const queueItems = new InMemoryQueueItemRepository(clock);
  const karaokeClaims = new InMemoryKaraokeClaimRepository(clock);

  sessions.seed({
    ...baseSession,
    karaokeMode: opts.karaokeMode ?? 'optional',
    karaokeMicCount: opts.karaokeMicCount ?? 1,
    karaokePauseMode: opts.karaokePauseMode ?? 'manual',
    karaokePauseTimeoutSec: opts.karaokePauseTimeoutSec ?? 30,
  });

  const room = new NodeSessionRoom({ sessionId: SESSION_ID, nowEpochMs: () => NOW });
  const rooms: KaraokeRoomRegistry = {
    forSession: (id) => (id === SESSION_ID ? room : null),
  };

  let providerControl: { pauseCalls: () => number; resumeCalls: () => number } | undefined;
  let streamingRouter: StreamingRouter | undefined;
  let providerConnections: InMemoryProviderConnectionRepository | undefined;
  if (opts.withProviderMock) {
    providerConnections = new InMemoryProviderConnectionRepository(clock);
    // upsert has no internal `await` before the write, so this lands
    // synchronously even though setup() itself stays sync.
    void providerConnections.upsert({
      accountId: baseSession.accountId,
      providerId: 'spotify',
      accessToken: 'fake-access-token',
    });
    const stub = makeStubProvider();
    const registry: ProviderRegistry = { spotify: () => stub.provider } as ProviderRegistry;
    streamingRouter = new StreamingRouter({
      providerConnections,
      registry,
      context: { fetch: globalThis.fetch },
    });
    providerControl = { pauseCalls: stub.pauseCalls, resumeCalls: stub.resumeCalls };
  }

  const service = new KaraokeService({
    sessions,
    guests,
    guestSlots,
    queueItems,
    karaokeClaims,
    rooms,
    streamingRouter,
    providerConnections,
    nowEpochMs: () => NOW,
  });

  async function addGuest(fingerprint = 'fp-1') {
    const guest = await guests.create({ sessionId: SESSION_ID, fingerprint });
    const slot = await guestSlots.create({
      sessionId: SESSION_ID,
      fingerprintHash: fingerprint,
      slotToken: `slot-${fingerprint}`,
      status: 'active',
    });
    return { guest, slot };
  }

  async function addItem(
    status: QueueItemStatus = 'queued',
    guestId = 'requester-guest',
    trackUri = 'spotify:track:abc',
  ) {
    return queueItems.create({
      sessionId: SESSION_ID,
      guestId,
      trackUri,
      trackName: 'Hello',
      artistName: 'World',
      status,
    });
  }

  async function captureEvents() {
    const captured: unknown[] = [];
    await room.connect({
      clientId: 'c1',
      kind: 'host',
      sessionId: SESSION_ID,
      connectedAtEpochMs: NOW,
    });
    room.subscribe('c1', (e) => {
      captured.push(e);
    });
    return captured;
  }

  return {
    sessions,
    guests,
    guestSlots,
    queueItems,
    karaokeClaims,
    room,
    service,
    addGuest,
    addItem,
    captureEvents,
    providerControl,
  };
}

describe('sanitizeKaraokeDisplayName', () => {
  it('trims surrounding whitespace', () => {
    expect(sanitizeKaraokeDisplayName('  Ana  ')).toBe('Ana');
  });

  it('strips control characters (C0, DEL, C1)', () => {
    const bell = String.fromCharCode(0x07);
    const del = String.fromCharCode(0x7f);
    const c1 = String.fromCharCode(0x9f);
    const nl = String.fromCharCode(0x0a);
    expect(sanitizeKaraokeDisplayName(`A${bell}na!`)).toBe('Ana!');
    expect(sanitizeKaraokeDisplayName(`Ana${del}${c1}`)).toBe('Ana');
    expect(sanitizeKaraokeDisplayName(`Ana${nl}Ben`)).toBe('AnaBen');
  });

  it('returns null when the result is empty', () => {
    expect(sanitizeKaraokeDisplayName('   ')).toBeNull();
    expect(sanitizeKaraokeDisplayName('')).toBeNull();
    expect(
      sanitizeKaraokeDisplayName(String.fromCharCode(0x00, 0x01) + ' ' + String.fromCharCode(0x1f)),
    ).toBeNull();
  });

  it('returns null when the result exceeds 40 chars', () => {
    expect(sanitizeKaraokeDisplayName('x'.repeat(41))).toBeNull();
    expect(sanitizeKaraokeDisplayName('x'.repeat(40))).toBe('x'.repeat(40));
  });

  it('keeps inner spacing and emoji intact', () => {
    expect(sanitizeKaraokeDisplayName('Ana & Ben 🎤')).toBe('Ana & Ben 🎤');
  });
});

describe('KaraokeService.claim', () => {
  it('creates a claim with the sanitized name and broadcasts karaoke.claim_added', async () => {
    const { service, karaokeClaims, addGuest, addItem, captureEvents } = setup();
    const captured = await captureEvents();
    const { guest } = await addGuest();
    const item = await addItem('queued');

    const claim = await service.claim({
      sessionId: SESSION_ID,
      slotToken: 'slot-fp-1',
      queueItemId: item.id,
      displayName: '  Ana  ',
    });

    expect(claim).toMatchObject({
      sessionId: SESSION_ID,
      queueItemId: item.id,
      guestId: guest.id,
      displayName: 'Ana',
    });
    expect(await karaokeClaims.findAllForItem(item.id)).toHaveLength(1);
    expect(captured).toEqual([
      {
        type: 'karaoke.claim_added',
        itemId: item.id,
        claim: { guestId: guest.id, displayName: 'Ana' },
      },
    ]);
  });

  it('allows a NON-requester guest to claim (duet)', async () => {
    const { service, addGuest, addItem } = setup({ karaokeMicCount: 2 });
    const { guest: other } = await addGuest('fp-2');
    const item = await addItem('queued', 'someone-else');
    const claim = await service.claim({
      sessionId: SESSION_ID,
      slotToken: 'slot-fp-2',
      queueItemId: item.id,
      displayName: 'Ben',
    });
    expect(claim.guestId).toBe(other.id);
  });

  it('rejects karaoke_off when the session has karaoke disabled', async () => {
    const { service, addGuest, addItem } = setup({ karaokeMode: 'off' });
    await addGuest();
    const item = await addItem();
    await expect(
      service.claim({
        sessionId: SESSION_ID,
        slotToken: 'slot-fp-1',
        queueItemId: item.id,
        displayName: 'Ana',
      }),
    ).rejects.toMatchObject({ code: 'karaoke_off' });
  });

  it('rejects item_not_claimable for a rejected item', async () => {
    const { service, addGuest, addItem } = setup();
    await addGuest();
    const item = await addItem('rejected');
    await expect(
      service.claim({
        sessionId: SESSION_ID,
        slotToken: 'slot-fp-1',
        queueItemId: item.id,
        displayName: 'Ana',
      }),
    ).rejects.toMatchObject({ code: 'item_not_claimable' });
  });

  it('rejects mics_full at exactly micCount claims', async () => {
    const { service, addGuest, addItem } = setup({ karaokeMicCount: 1 });
    await addGuest('fp-1');
    await addGuest('fp-2');
    const item = await addItem('queued');
    await service.claim({
      sessionId: SESSION_ID,
      slotToken: 'slot-fp-1',
      queueItemId: item.id,
      displayName: 'Ana',
    });
    await expect(
      service.claim({
        sessionId: SESSION_ID,
        slotToken: 'slot-fp-2',
        queueItemId: item.id,
        displayName: 'Ben',
      }),
    ).rejects.toMatchObject({ code: 'mics_full' });
  });

  it('rejects already_claimed when the same guest claims twice', async () => {
    const { service, addGuest, addItem } = setup({ karaokeMicCount: 2 });
    await addGuest();
    const item = await addItem('queued');
    await service.claim({
      sessionId: SESSION_ID,
      slotToken: 'slot-fp-1',
      queueItemId: item.id,
      displayName: 'Ana',
    });
    await expect(
      service.claim({
        sessionId: SESSION_ID,
        slotToken: 'slot-fp-1',
        queueItemId: item.id,
        displayName: 'Ana again',
      }),
    ).rejects.toMatchObject({ code: 'already_claimed' });
  });

  it('rejects invalid_display_name when the sanitized name is empty or too long', async () => {
    const { service, addGuest, addItem } = setup();
    await addGuest();
    const item = await addItem();
    await expect(
      service.claim({
        sessionId: SESSION_ID,
        slotToken: 'slot-fp-1',
        queueItemId: item.id,
        displayName: '   ',
      }),
    ).rejects.toMatchObject({ code: 'invalid_display_name' });
    await expect(
      service.claim({
        sessionId: SESSION_ID,
        slotToken: 'slot-fp-1',
        queueItemId: item.id,
        displayName: 'x'.repeat(41),
      }),
    ).rejects.toMatchObject({ code: 'invalid_display_name' });
  });

  it('rejects unknown slot tokens, foreign slots, and inactive slots', async () => {
    const { service, guestSlots, addGuest, addItem } = setup();
    const { slot } = await addGuest();
    const item = await addItem();

    await expect(
      service.claim({
        sessionId: SESSION_ID,
        slotToken: 'nope',
        queueItemId: item.id,
        displayName: 'Ana',
      }),
    ).rejects.toMatchObject({ code: 'unknown_slot_token' });

    await expect(
      service.claim({
        sessionId: 'other-session',
        slotToken: 'slot-fp-1',
        queueItemId: item.id,
        displayName: 'Ana',
      }),
    ).rejects.toMatchObject({ code: 'slot_session_mismatch' });

    await guestSlots.setStatus({ id: slot.id, status: 'queued', queuePosition: 1 });
    await expect(
      service.claim({
        sessionId: SESSION_ID,
        slotToken: 'slot-fp-1',
        queueItemId: item.id,
        displayName: 'Ana',
      }),
    ).rejects.toMatchObject({ code: 'slot_not_active' });
  });

  it('rejects unknown items and items from another session', async () => {
    const { service, queueItems, addGuest } = setup();
    await addGuest();

    await expect(
      service.claim({
        sessionId: SESSION_ID,
        slotToken: 'slot-fp-1',
        queueItemId: 'missing',
        displayName: 'Ana',
      }),
    ).rejects.toMatchObject({ code: 'item_not_found' });

    const foreign = await queueItems.create({
      sessionId: 'another-session',
      guestId: 'g',
      trackUri: 'u',
      trackName: 't',
      artistName: 'a',
      status: 'queued',
    });
    await expect(
      service.claim({
        sessionId: SESSION_ID,
        slotToken: 'slot-fp-1',
        queueItemId: foreign.id,
        displayName: 'Ana',
      }),
    ).rejects.toMatchObject({ code: 'item_session_mismatch' });
  });
});

describe('KaraokeService.removeClaim', () => {
  it('removes the guest own claim while waiting and broadcasts karaoke.claim_removed', async () => {
    const { service, karaokeClaims, addGuest, addItem, captureEvents } = setup();
    const { guest } = await addGuest();
    const item = await addItem('queued');
    await service.claim({
      sessionId: SESSION_ID,
      slotToken: 'slot-fp-1',
      queueItemId: item.id,
      displayName: 'Ana',
    });
    const captured = await captureEvents();

    await service.removeClaim({
      sessionId: SESSION_ID,
      slotToken: 'slot-fp-1',
      queueItemId: item.id,
    });

    expect(await karaokeClaims.findAllForItem(item.id)).toEqual([]);
    expect(captured).toEqual([
      { type: 'karaoke.claim_removed', itemId: item.id, guestId: guest.id },
    ]);
  });

  it('rejects claim_not_found when the guest has no claim on the item', async () => {
    const { service, addGuest, addItem } = setup();
    await addGuest();
    const item = await addItem('queued');
    await expect(
      service.removeClaim({
        sessionId: SESSION_ID,
        slotToken: 'slot-fp-1',
        queueItemId: item.id,
      }),
    ).rejects.toMatchObject({ code: 'claim_not_found' });
  });

  it('rejects item_not_waiting once the item is playing', async () => {
    const { service, queueItems, addGuest, addItem } = setup();
    await addGuest();
    const item = await addItem('queued');
    await service.claim({
      sessionId: SESSION_ID,
      slotToken: 'slot-fp-1',
      queueItemId: item.id,
      displayName: 'Ana',
    });
    await queueItems.setStatus({ id: item.id, status: 'playing' });
    await expect(
      service.removeClaim({
        sessionId: SESSION_ID,
        slotToken: 'slot-fp-1',
        queueItemId: item.id,
      }),
    ).rejects.toMatchObject({ code: 'item_not_waiting' });
  });
});

describe('KaraokeService.hostRemoveClaim', () => {
  it('removes any guest claim even while the item is playing', async () => {
    const { service, queueItems, karaokeClaims, addGuest, addItem, captureEvents } = setup();
    const { guest } = await addGuest();
    const item = await addItem('queued');
    await service.claim({
      sessionId: SESSION_ID,
      slotToken: 'slot-fp-1',
      queueItemId: item.id,
      displayName: 'Ana',
    });
    await queueItems.setStatus({ id: item.id, status: 'playing' });
    const captured = await captureEvents();

    await service.hostRemoveClaim({
      sessionId: SESSION_ID,
      queueItemId: item.id,
      guestId: guest.id,
      actor: { userId: 'host-user' },
    });

    expect(await karaokeClaims.findAllForItem(item.id)).toEqual([]);
    expect(captured).toEqual([
      { type: 'karaoke.claim_removed', itemId: item.id, guestId: guest.id },
    ]);
  });

  it('rejects claim_not_found for a guest without a claim', async () => {
    const { service, addItem } = setup();
    const item = await addItem('queued');
    await expect(
      service.hostRemoveClaim({
        sessionId: SESSION_ID,
        queueItemId: item.id,
        guestId: 'nobody',
      }),
    ).rejects.toMatchObject({ code: 'claim_not_found' });
  });
});

describe('KaraokeService.handleTrackChange (spotlight)', () => {
  const URI = 'spotify:track:abc';

  it('spotlights the earliest CLAIMED matching item, skipping unclaimed earlier ones', async () => {
    const { service, karaokeClaims, addGuest, addItem, captureEvents } = setup();
    const { guest } = await addGuest();
    // Earliest item has NO claims; a later duplicate of the same track does.
    const unclaimed = await addItem('queued');
    Object.assign(unclaimed, { createdAt: new Date(NOW - 2000) });
    const claimed = await addItem('queued');
    Object.assign(claimed, { createdAt: new Date(NOW - 1000) });
    await karaokeClaims.create({
      sessionId: SESSION_ID,
      queueItemId: claimed.id,
      guestId: guest.id,
      displayName: 'Ana',
    });
    const captured = await captureEvents();

    await service.handleTrackChange({ sessionId: SESSION_ID, trackUri: URI });

    expect(captured).toEqual([
      {
        type: 'karaoke.spotlight',
        itemId: claimed.id,
        claims: [{ guestId: guest.id, displayName: 'Ana' }],
      },
    ]);
    expect(service.getKaraokeState(SESSION_ID)).toEqual({
      spotlightItemId: claimed.id,
      paused: false,
      pausedUntilEpochMs: null,
    });
  });

  it('ties between claimed duplicates go to the earliest createdAt', async () => {
    const { service, karaokeClaims, addGuest, addItem, captureEvents } = setup({
      karaokeMicCount: 2,
    });
    const { guest } = await addGuest();
    const later = await addItem('queued');
    Object.assign(later, { createdAt: new Date(NOW - 1000) });
    const earlier = await addItem('queued');
    Object.assign(earlier, { createdAt: new Date(NOW - 5000) });
    for (const item of [later, earlier]) {
      await karaokeClaims.create({
        sessionId: SESSION_ID,
        queueItemId: item.id,
        guestId: guest.id,
        displayName: 'Ana',
      });
    }
    const captured = await captureEvents();

    await service.handleTrackChange({ sessionId: SESSION_ID, trackUri: URI });

    expect(captured).toEqual([expect.objectContaining({ itemId: earlier.id })]);
  });

  it('does not spotlight rejected/played items or other URIs', async () => {
    const { service, karaokeClaims, addGuest, addItem, captureEvents } = setup();
    const { guest } = await addGuest();
    const rejected = await addItem('rejected');
    const otherUri = await addItem('queued', 'requester-guest', 'spotify:track:zzz');
    for (const item of [rejected, otherUri]) {
      await karaokeClaims.create({
        sessionId: SESSION_ID,
        queueItemId: item.id,
        guestId: guest.id,
        displayName: 'Ana',
      });
    }
    const captured = await captureEvents();

    await service.handleTrackChange({ sessionId: SESSION_ID, trackUri: URI });

    // Starting state was already "no spotlight" — no change, no broadcast.
    expect(captured).toEqual([]);
  });

  it('broadcasts only on CHANGE and clears with itemId null when the track moves on', async () => {
    const { service, karaokeClaims, addGuest, addItem, captureEvents } = setup();
    const { guest } = await addGuest();
    const item = await addItem('queued');
    await karaokeClaims.create({
      sessionId: SESSION_ID,
      queueItemId: item.id,
      guestId: guest.id,
      displayName: 'Ana',
    });
    const captured = await captureEvents();

    await service.handleTrackChange({ sessionId: SESSION_ID, trackUri: URI });
    await service.handleTrackChange({ sessionId: SESSION_ID, trackUri: URI }); // same — quiet
    await service.handleTrackChange({ sessionId: SESSION_ID, trackUri: 'spotify:track:next' });
    await service.handleTrackChange({ sessionId: SESSION_ID, trackUri: null }); // already null — quiet

    expect(captured).toEqual([
      expect.objectContaining({ type: 'karaoke.spotlight', itemId: item.id }),
      { type: 'karaoke.spotlight', itemId: null, claims: [] },
    ]);
  });

  it('auto pause mode: a fresh spotlight also broadcasts karaoke.paused with the deadline', async () => {
    const { service, karaokeClaims, addGuest, addItem, captureEvents } = setup({
      karaokePauseMode: 'auto',
      karaokePauseTimeoutSec: 45,
    });
    const { guest } = await addGuest();
    const item = await addItem('queued');
    await karaokeClaims.create({
      sessionId: SESSION_ID,
      queueItemId: item.id,
      guestId: guest.id,
      displayName: 'Ana',
    });
    const captured = await captureEvents();

    await service.handleTrackChange({ sessionId: SESSION_ID, trackUri: URI, nowEpochMs: NOW });

    expect(captured).toEqual([
      expect.objectContaining({ type: 'karaoke.spotlight', itemId: item.id }),
      { type: 'karaoke.paused', itemId: item.id, untilEpochMs: NOW + 45_000 },
    ]);
    expect(service.getKaraokeState(SESSION_ID)).toEqual({
      spotlightItemId: item.id,
      paused: true,
      pausedUntilEpochMs: NOW + 45_000,
    });
  });

  it('karaokeMode "off": a claimed track change never enters the spotlight', async () => {
    const { service, karaokeClaims, addGuest, addItem, captureEvents } = setup({
      karaokeMode: 'off',
    });
    const { guest } = await addGuest();
    const item = await addItem('queued');
    await karaokeClaims.create({
      sessionId: SESSION_ID,
      queueItemId: item.id,
      guestId: guest.id,
      displayName: 'Ana',
    });
    const captured = await captureEvents();

    await service.handleTrackChange({ sessionId: SESSION_ID, trackUri: URI });

    expect(captured).toEqual([]);
    expect(service.getKaraokeState(SESSION_ID)).toEqual({
      spotlightItemId: null,
      paused: false,
      pausedUntilEpochMs: null,
    });
  });

  it('host flips karaokeMode to "off" mid-spotlight: next track change clears it (and any pause) without calling provider resume', async () => {
    const { service, sessions, karaokeClaims, addGuest, addItem, captureEvents, providerControl } =
      setup({
        karaokePauseMode: 'auto',
        karaokePauseTimeoutSec: 30,
        withProviderMock: true,
      });
    const { guest } = await addGuest();
    const item = await addItem('queued');
    await karaokeClaims.create({
      sessionId: SESSION_ID,
      queueItemId: item.id,
      guestId: guest.id,
      displayName: 'Ana',
    });

    // Enter the spotlight while karaoke is still on — auto mode also pauses.
    await service.handleTrackChange({ sessionId: SESSION_ID, trackUri: URI, nowEpochMs: NOW });
    expect(service.getKaraokeState(SESSION_ID).paused).toBe(true);
    expect(providerControl?.pauseCalls()).toBe(1);

    // Host turns karaoke off mid-song (track hasn't changed yet).
    await sessions.update({ id: SESSION_ID, karaokeMode: 'off' });
    const captured = await captureEvents();

    // Next track-change tick (poller fires this on every URI sample, even
    // when the URI is unchanged from the poller's perspective — here we
    // simulate the same URI still playing) must clear the stale spotlight.
    await service.handleTrackChange({ sessionId: SESSION_ID, trackUri: URI, nowEpochMs: NOW });

    expect(captured).toEqual([{ type: 'karaoke.spotlight', itemId: null, claims: [] }]);
    expect(service.getKaraokeState(SESSION_ID)).toEqual({
      spotlightItemId: null,
      paused: false,
      pausedUntilEpochMs: null,
    });
    // The host controls playback directly once karaoke is off — no resume.
    expect(providerControl?.resumeCalls()).toBe(0);
  });
});

describe('KaraokeService.pause / ready', () => {
  const URI = 'spotify:track:abc';

  async function spotlightWithClaim(s: ReturnType<typeof setup>) {
    const { guest } = await s.addGuest();
    const item = await s.addItem('queued');
    await s.service.claim({
      sessionId: SESSION_ID,
      slotToken: 'slot-fp-1',
      queueItemId: item.id,
      displayName: 'Ana',
    });
    await s.service.handleTrackChange({ sessionId: SESSION_ID, trackUri: URI });
    return { guest, item };
  }

  it('pause: spotlight claimer pauses in manual mode; broadcasts with deadline', async () => {
    const s = setup(); // manual by default
    const { item } = await spotlightWithClaim(s);
    const captured = await s.captureEvents();

    const result = await s.service.pause({ sessionId: SESSION_ID, slotToken: 'slot-fp-1' });

    expect(result).toEqual({ untilEpochMs: NOW + 30_000 });
    expect(captured).toEqual([
      { type: 'karaoke.paused', itemId: item.id, untilEpochMs: NOW + 30_000 },
    ]);
    expect(s.service.getKaraokeState(SESSION_ID).paused).toBe(true);
  });

  it('pause rejects not_a_claimer when no spotlight is active', async () => {
    const s = setup();
    await s.addGuest();
    await expect(
      s.service.pause({ sessionId: SESSION_ID, slotToken: 'slot-fp-1' }),
    ).rejects.toMatchObject({ code: 'not_a_claimer' });
  });

  it('pause rejects not_a_claimer for a guest without a claim on the spotlight item', async () => {
    const s = setup();
    await spotlightWithClaim(s);
    await s.addGuest('fp-2');
    await expect(
      s.service.pause({ sessionId: SESSION_ID, slotToken: 'slot-fp-2' }),
    ).rejects.toMatchObject({ code: 'not_a_claimer' });
  });

  it('pause rejects pause_disabled outside manual mode', async () => {
    for (const karaokePauseMode of ['off', 'auto'] as const) {
      const s = setup({ karaokePauseMode });
      await spotlightWithClaim(s);
      await expect(
        s.service.pause({ sessionId: SESSION_ID, slotToken: 'slot-fp-1' }),
      ).rejects.toMatchObject({ code: 'pause_disabled' });
    }
  });

  it('ready: resumes and broadcasts karaoke.resumed while paused', async () => {
    const s = setup();
    const { item } = await spotlightWithClaim(s);
    await s.service.pause({ sessionId: SESSION_ID, slotToken: 'slot-fp-1' });
    const captured = await s.captureEvents();

    await s.service.ready({ sessionId: SESSION_ID, slotToken: 'slot-fp-1' });

    expect(captured).toEqual([{ type: 'karaoke.resumed', itemId: item.id }]);
    expect(s.service.getKaraokeState(SESSION_ID)).toEqual({
      spotlightItemId: item.id,
      paused: false,
      pausedUntilEpochMs: null,
    });
  });

  it('ready rejects not_paused when playback is not karaoke-paused', async () => {
    const s = setup();
    await spotlightWithClaim(s);
    await expect(
      s.service.ready({ sessionId: SESSION_ID, slotToken: 'slot-fp-1' }),
    ).rejects.toMatchObject({ code: 'not_paused' });
  });
});

describe('KaraokeService.reconcilePlayback', () => {
  const URI = 'spotify:track:abc';

  async function pausedSetup() {
    const s = setup({ karaokePauseMode: 'auto', karaokePauseTimeoutSec: 30 });
    const { guest } = await s.addGuest();
    const item = await s.addItem('queued');
    await s.karaokeClaims.create({
      sessionId: SESSION_ID,
      queueItemId: item.id,
      guestId: guest.id,
      displayName: 'Ana',
    });
    // Auto mode: entering the spotlight pauses with deadline NOW + 30s.
    await s.service.handleTrackChange({ sessionId: SESSION_ID, trackUri: URI, nowEpochMs: NOW });
    return { ...s, item };
  }

  it('provider reports playing while karaoke-paused → clears + broadcasts resumed', async () => {
    const s = await pausedSetup();
    const captured = await s.captureEvents();

    await s.service.reconcilePlayback({ sessionId: SESSION_ID, isPlaying: true, nowEpochMs: NOW });

    expect(captured).toEqual([{ type: 'karaoke.resumed', itemId: s.item.id }]);
    expect(s.service.getKaraokeState(SESSION_ID).paused).toBe(false);
  });

  it('past the deadline → clears + broadcasts resumed; idempotent afterwards', async () => {
    const s = await pausedSetup();
    const captured = await s.captureEvents();

    await s.service.reconcilePlayback({
      sessionId: SESSION_ID,
      isPlaying: false,
      nowEpochMs: NOW + 30_001,
    });
    await s.service.reconcilePlayback({
      sessionId: SESSION_ID,
      isPlaying: false,
      nowEpochMs: NOW + 35_000,
    });

    expect(captured).toEqual([{ type: 'karaoke.resumed', itemId: s.item.id }]);
  });

  it('before the deadline and still paused → no-op', async () => {
    const s = await pausedSetup();
    const captured = await s.captureEvents();

    await s.service.reconcilePlayback({
      sessionId: SESSION_ID,
      isPlaying: false,
      nowEpochMs: NOW + 29_999,
    });

    expect(captured).toEqual([]);
    expect(s.service.getKaraokeState(SESSION_ID).paused).toBe(true);
  });
});
