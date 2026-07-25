import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeSessionRoom } from '@opendj/realtime';
import {
  QueueService,
  QueueServiceError,
  type RealtimeRoomRegistry,
} from '../../src/queue/QueueService.js';
import {
  InMemoryGuestRepository,
  InMemoryGuestSlotRepository,
  InMemoryKaraokeClaimRepository,
  InMemoryQueueItemRepository,
  InMemoryQueueSkipVoteRepository,
  InMemorySessionRepository,
} from '../../src/repositories/in-memory/index.js';
import type { GuestRecord, GuestSlotRecord, SessionRecord } from '../../src/repositories/types.js';

const SESSION_ID = '11111111-1111-1111-1111-111111111111';
const NOW = new Date('2026-04-30T12:00:00Z').getTime();

const baseSession: SessionRecord = {
  id: SESSION_ID,
  accountId: '22222222-2222-2222-2222-222222222222',
  name: 'Test',
  qrSlug: 'test',
  guestCapOverride: null,
  songsPerGuestCap: 3,
  maxConsecutivePerGuest: null,
  moderationEnabled: false,
  voteSkipMode: 'fixed',
  voteSkipThreshold: 5,
  karaokeMode: 'off',
  karaokeMicCount: 1,
  karaokePauseMode: 'manual',
  karaokePauseTimeoutSec: 30,
  startedAt: new Date(NOW),
  endedAt: null,
};

function setup(
  opts: {
    moderationEnabled?: boolean;
    capOverride?: number | null;
    maxConsecutivePerGuest?: number | null;
    karaokeMode?: 'off' | 'optional' | 'required';
  } = {},
) {
  const clock = { now: () => new Date(NOW) };
  const sessions = new InMemorySessionRepository();
  const guests = new InMemoryGuestRepository(clock);
  const guestSlots = new InMemoryGuestSlotRepository(clock);
  const queueItems = new InMemoryQueueItemRepository(clock);
  const queueSkipVotes = new InMemoryQueueSkipVoteRepository(queueItems, clock);
  const karaokeClaims = new InMemoryKaraokeClaimRepository(clock);

  sessions.seed({
    ...baseSession,
    moderationEnabled: opts.moderationEnabled ?? false,
    songsPerGuestCap: opts.capOverride ?? 3,
    maxConsecutivePerGuest: opts.maxConsecutivePerGuest ?? null,
    karaokeMode: opts.karaokeMode ?? 'off',
  });

  const room = new NodeSessionRoom({ sessionId: SESSION_ID, nowEpochMs: () => NOW });
  const rooms: RealtimeRoomRegistry = {
    forSession: (id) => (id === SESSION_ID ? room : null),
  };

  const service = new QueueService({
    sessions,
    guests,
    guestSlots,
    queueItems,
    queueSkipVotes,
    karaokeClaims,
    rooms,
  });

  // Convenience: register a guest + slot.
  async function addGuest(fingerprint = 'fp-1', userId: string | null = null) {
    const guest = await guests.create({ sessionId: SESSION_ID, fingerprint, userId });
    const slot = await guestSlots.create({
      sessionId: SESSION_ID,
      fingerprintHash: fingerprint,
      slotToken: `slot-${fingerprint}`,
      status: 'active',
    });
    return { guest, slot };
  }

  return {
    sessions,
    guests,
    guestSlots,
    queueItems,
    queueSkipVotes,
    karaokeClaims,
    rooms,
    room,
    service,
    addGuest,
  };
}

const TRACK = {
  uri: 'spotify:track:abc',
  name: 'Hello',
  artist: 'World',
  albumArt: null,
  durationMs: 200_000,
};

describe('QueueService.requestTrack', () => {
  it('inserts an approved item when moderation is off and broadcasts request + approved', async () => {
    const { service, queueItems, room, addGuest } = setup({ moderationEnabled: false });
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
    await addGuest();

    const created = await service.requestTrack(
      { sessionId: SESSION_ID, slotToken: 'slot-fp-1', track: TRACK },
      NOW,
    );
    expect(created.status).toBe('approved');
    expect(queueItems.rows.size).toBe(1);
    expect(captured.length).toBe(2);
    expect((captured[0] as { type: string }).type).toBe('queue.item_requested');
    expect((captured[1] as { type: string }).type).toBe('queue.item_approved');
  });

  it('inserts a pending item when moderation is on and broadcasts only requested', async () => {
    const { service, queueItems, room, addGuest } = setup({ moderationEnabled: true });
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
    await addGuest();

    const created = await service.requestTrack(
      { sessionId: SESSION_ID, slotToken: 'slot-fp-1', track: TRACK },
      NOW,
    );
    expect(created.status).toBe('pending');
    expect(queueItems.rows.size).toBe(1);
    expect(captured.length).toBe(1);
    expect((captured[0] as { type: string }).type).toBe('queue.item_requested');
  });

  it('rejects unknown slot token', async () => {
    const { service } = setup();
    await expect(
      service.requestTrack({ sessionId: SESSION_ID, slotToken: 'nope', track: TRACK }, NOW),
    ).rejects.toMatchObject({ code: 'unknown_slot_token' });
  });

  it('rejects when slot is queued (not active)', async () => {
    const { service, guestSlots, addGuest } = setup();
    const { slot } = await addGuest();
    await guestSlots.setStatus({ id: slot.id, status: 'queued', queuePosition: 1 });
    await expect(
      service.requestTrack({ sessionId: SESSION_ID, slotToken: 'slot-fp-1', track: TRACK }, NOW),
    ).rejects.toMatchObject({ code: 'slot_not_active' });
  });

  it('rejects when guest is at the per-guest cap', async () => {
    const { service, addGuest } = setup({ capOverride: 1 });
    await addGuest();
    await service.requestTrack(
      { sessionId: SESSION_ID, slotToken: 'slot-fp-1', track: TRACK },
      NOW,
    );
    await expect(
      service.requestTrack(
        {
          sessionId: SESSION_ID,
          slotToken: 'slot-fp-1',
          track: { ...TRACK, uri: 'spotify:track:second' },
        },
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'cap_reached' });
  });

  it('rejects when the guest would exceed the consecutive-songs cap', async () => {
    const { service, addGuest } = setup({ maxConsecutivePerGuest: 1 });
    await addGuest();
    await service.requestTrack(
      { sessionId: SESSION_ID, slotToken: 'slot-fp-1', track: TRACK },
      NOW,
    );
    await expect(
      service.requestTrack(
        {
          sessionId: SESSION_ID,
          slotToken: 'slot-fp-1',
          track: { ...TRACK, uri: 'spotify:track:second' },
        },
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'consecutive_cap_reached' });
  });
});

describe('QueueService.moderate', () => {
  it('approves a pending item, sets decidedAt, broadcasts approved', async () => {
    const { service, queueItems, room, addGuest } = setup({ moderationEnabled: true });
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
    await addGuest();

    const item = await service.requestTrack(
      { sessionId: SESSION_ID, slotToken: 'slot-fp-1', track: TRACK },
      NOW,
    );
    captured.length = 0;

    const approved = await service.moderate(
      { itemId: item.id, decision: 'approved', sessionId: SESSION_ID },
      NOW + 1000,
    );
    expect(approved.status).toBe('approved');
    expect(approved.decidedAt?.getTime()).toBe(NOW + 1000);
    expect(captured.map((e) => (e as { type: string }).type)).toEqual(['queue.item_approved']);
    expect(queueItems.rows.get(item.id)?.status).toBe('approved');
  });

  it('rejects on unknown item', async () => {
    const { service } = setup();
    await expect(
      service.moderate(
        { itemId: 'does-not-exist', decision: 'approved', sessionId: SESSION_ID },
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'item_not_found' });
  });

  it('rejects mismatched session', async () => {
    const { service, addGuest } = setup({ moderationEnabled: true });
    await addGuest();
    const item = await service.requestTrack(
      { sessionId: SESSION_ID, slotToken: 'slot-fp-1', track: TRACK },
      NOW,
    );
    await expect(
      service.moderate({ itemId: item.id, decision: 'approved', sessionId: 'other-session' }, NOW),
    ).rejects.toMatchObject({ code: 'item_session_mismatch' });
  });
});

describe('QueueService.removeOwn', () => {
  it("removes the guest's own pending item", async () => {
    const { service, queueItems, addGuest } = setup({ moderationEnabled: true });
    await addGuest();
    const item = await service.requestTrack(
      { sessionId: SESSION_ID, slotToken: 'slot-fp-1', track: TRACK },
      NOW,
    );
    await service.removeOwn({
      itemId: item.id,
      sessionId: SESSION_ID,
      slotToken: 'slot-fp-1',
    });
    expect(queueItems.rows.size).toBe(0);
  });

  it("refuses to remove another guest's item", async () => {
    const { service, addGuest } = setup({ moderationEnabled: true });
    await addGuest('fp-1');
    await addGuest('fp-2');
    const item = await service.requestTrack(
      { sessionId: SESSION_ID, slotToken: 'slot-fp-1', track: TRACK },
      NOW,
    );
    await expect(
      service.removeOwn({
        itemId: item.id,
        sessionId: SESSION_ID,
        slotToken: 'slot-fp-2',
      }),
    ).rejects.toMatchObject({ code: 'not_owner' });
  });

  it('refuses to remove a currently playing item', async () => {
    const { service, queueItems, addGuest } = setup();
    await addGuest();
    const item = await service.requestTrack(
      { sessionId: SESSION_ID, slotToken: 'slot-fp-1', track: TRACK },
      NOW,
    );
    await queueItems.setStatus({ id: item.id, status: 'playing' });
    await expect(
      service.removeOwn({
        itemId: item.id,
        sessionId: SESSION_ID,
        slotToken: 'slot-fp-1',
      }),
    ).rejects.toMatchObject({ code: 'item_playing' });
  });
});

describe('QueueService.castSkipVote', () => {
  it('increments votes + broadcasts + dedupes per slot', async () => {
    const { service, queueItems, room, addGuest } = setup();
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
    await addGuest('fp-1');
    await addGuest('fp-2');
    const item = await service.requestTrack(
      { sessionId: SESSION_ID, slotToken: 'slot-fp-1', track: TRACK },
      NOW,
    );
    captured.length = 0;

    const vote1 = await service.castSkipVote({
      itemId: item.id,
      sessionId: SESSION_ID,
      slotToken: 'slot-fp-2',
    });
    expect(vote1.votes).toBe(1);
    expect(vote1.threshold).toBe(5);

    // Same slot can't vote twice
    await expect(
      service.castSkipVote({
        itemId: item.id,
        sessionId: SESSION_ID,
        slotToken: 'slot-fp-2',
      }),
    ).rejects.toMatchObject({ code: 'already_voted' });

    expect(queueItems.rows.get(item.id)?.skipVotes).toBe(1);
    expect((captured[0] as { type: string }).type).toBe('skip_vote.updated');
  });

  it('rejects unknown item', async () => {
    const { service, addGuest } = setup();
    await addGuest();
    await expect(
      service.castSkipVote({
        itemId: 'does-not-exist',
        sessionId: SESSION_ID,
        slotToken: 'slot-fp-1',
      }),
    ).rejects.toMatchObject({ code: 'item_not_found' });
  });
});

describe('QueueService.requestTrack — karaoke claim bundling', () => {
  it("rejects with karaoke_claim_required in 'required' mode when no claim is bundled — BEFORE inserting", async () => {
    const { service, queueItems, addGuest } = setup({ karaokeMode: 'required' });
    await addGuest();
    await expect(
      service.requestTrack({ sessionId: SESSION_ID, slotToken: 'slot-fp-1', track: TRACK }, NOW),
    ).rejects.toMatchObject({ code: 'karaoke_claim_required' });
    expect(queueItems.rows.size).toBe(0);
  });

  it("rejects with karaoke_off when a claim is bundled but karaokeMode is 'off' — BEFORE inserting", async () => {
    const { service, queueItems, addGuest } = setup({ karaokeMode: 'off' });
    await addGuest();
    await expect(
      service.requestTrack(
        {
          sessionId: SESSION_ID,
          slotToken: 'slot-fp-1',
          track: TRACK,
          karaoke: { displayName: 'Ana' },
        },
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'karaoke_off' });
    expect(queueItems.rows.size).toBe(0);
  });

  it('rejects invalid display names BEFORE inserting the item', async () => {
    const { service, queueItems, addGuest } = setup({ karaokeMode: 'optional' });
    await addGuest();
    await expect(
      service.requestTrack(
        {
          sessionId: SESSION_ID,
          slotToken: 'slot-fp-1',
          track: TRACK,
          karaoke: { displayName: '   ' },
        },
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'invalid_display_name' });
    expect(queueItems.rows.size).toBe(0);
  });

  it("creates item + claim and broadcasts claim_added in 'optional' mode", async () => {
    const { service, karaokeClaims, room, addGuest } = setup({ karaokeMode: 'optional' });
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
    const { guest } = await addGuest();

    const created = await service.requestTrack(
      {
        sessionId: SESSION_ID,
        slotToken: 'slot-fp-1',
        track: TRACK,
        karaoke: { displayName: '  Ana  ' },
      },
      NOW,
    );

    const claims = await karaokeClaims.findAllForItem(created.id);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ guestId: guest.id, displayName: 'Ana' });

    const types = captured.map((e) => (e as { type: string }).type);
    expect(types).toEqual(['queue.item_requested', 'karaoke.claim_added', 'queue.item_approved']);
    const requested = captured[0] as { item: { karaokeClaims: unknown[] } };
    expect(requested.item.karaokeClaims).toEqual([{ guestId: guest.id, displayName: 'Ana' }]);
    const claimAdded = captured[1] as { itemId: string; claim: unknown };
    expect(claimAdded.itemId).toBe(created.id);
    expect(claimAdded.claim).toEqual({ guestId: guest.id, displayName: 'Ana' });
  });

  it("satisfies 'required' mode when the claim is bundled", async () => {
    const { service, karaokeClaims, addGuest } = setup({ karaokeMode: 'required' });
    await addGuest();
    const created = await service.requestTrack(
      {
        sessionId: SESSION_ID,
        slotToken: 'slot-fp-1',
        track: TRACK,
        karaoke: { displayName: 'Ben' },
      },
      NOW,
    );
    expect(await karaokeClaims.findAllForItem(created.id)).toHaveLength(1);
  });

  it('plain request without karaoke input still works in optional mode (no claim created)', async () => {
    const { service, karaokeClaims, addGuest } = setup({ karaokeMode: 'optional' });
    await addGuest();
    const created = await service.requestTrack(
      { sessionId: SESSION_ID, slotToken: 'slot-fp-1', track: TRACK },
      NOW,
    );
    expect(await karaokeClaims.findAllForItem(created.id)).toEqual([]);
  });
});
