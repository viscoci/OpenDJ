import { describe, expect, it } from 'vitest';
import { NodeSessionRoom } from '@opendj/realtime';
import { KaraokeService, type KaraokeRoomRegistry } from '../../src/karaoke/KaraokeService.js';
import { sanitizeKaraokeDisplayName } from '../../src/karaoke/displayName.js';
import {
  InMemoryGuestRepository,
  InMemoryGuestSlotRepository,
  InMemoryKaraokeClaimRepository,
  InMemoryQueueItemRepository,
  InMemorySessionRepository,
} from '../../src/repositories/in-memory/index.js';
import type { QueueItemStatus, SessionRecord } from '../../src/repositories/types.js';

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
  });

  const room = new NodeSessionRoom({ sessionId: SESSION_ID, nowEpochMs: () => NOW });
  const rooms: KaraokeRoomRegistry = {
    forSession: (id) => (id === SESSION_ID ? room : null),
  };

  const service = new KaraokeService({
    sessions,
    guests,
    guestSlots,
    queueItems,
    karaokeClaims,
    rooms,
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

  async function addItem(status: QueueItemStatus = 'queued', guestId = 'requester-guest') {
    return queueItems.create({
      sessionId: SESSION_ID,
      guestId,
      trackUri: 'spotify:track:abc',
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
