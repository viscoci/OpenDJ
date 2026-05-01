import { describe, expect, it, vi } from 'vitest';
import { NodeSessionRoom } from '../src/NodeSessionRoom.js';
import type { RealtimeClient } from '../src/types/client.js';
import type { SessionEvent } from '../src/types/event.js';
import { createEmptySnapshot } from '../src/types/snapshot.js';

function client(overrides: Partial<RealtimeClient> = {}): RealtimeClient {
  return {
    clientId: overrides.clientId ?? `c-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'guest',
    sessionId: 'sess-1',
    connectedAtEpochMs: 1_700_000_000_000,
    ...overrides,
  };
}

const SAMPLE_REQUESTED: SessionEvent = {
  type: 'queue.item_requested',
  item: {
    id: 'item-1',
    guestId: 'g-1',
    trackUri: 'spotify:track:abc',
    trackName: 't',
    artistName: 'a',
    albumArtUrl: null,
    durationMs: 200_000,
    status: 'pending',
    skipVotes: 0,
    createdAtEpochMs: 1_700_000_000_000,
    decidedAtEpochMs: null,
  },
};

describe('NodeSessionRoom — connect / disconnect', () => {
  it('rejects clients with a mismatched sessionId', async () => {
    const room = new NodeSessionRoom({ sessionId: 'sess-1' });
    await expect(room.connect(client({ sessionId: 'other' }))).rejects.toThrow(/sessionId/);
  });

  it('tracks connectedCount + subscribedCount independently', async () => {
    const room = new NodeSessionRoom({ sessionId: 'sess-1' });
    const c1 = client({ clientId: 'c1' });
    const c2 = client({ clientId: 'c2' });
    await room.connect(c1);
    await room.connect(c2);
    expect(room.connectedCount).toBe(2);
    expect(room.subscribedCount).toBe(0);
    room.subscribe('c1', () => {});
    expect(room.subscribedCount).toBe(1);
  });

  it('disconnect drops both client + subscriber', async () => {
    const room = new NodeSessionRoom({ sessionId: 'sess-1' });
    await room.connect(client({ clientId: 'c1' }));
    room.subscribe('c1', () => {});
    expect(room.subscribedCount).toBe(1);
    await room.disconnect('c1');
    expect(room.connectedCount).toBe(0);
    expect(room.subscribedCount).toBe(0);
  });

  it('disconnect on unknown clientId is a no-op', async () => {
    const room = new NodeSessionRoom({ sessionId: 'sess-1' });
    await expect(room.disconnect('does-not-exist')).resolves.toBeUndefined();
  });

  it('subscribe before connect throws', () => {
    const room = new NodeSessionRoom({ sessionId: 'sess-1' });
    expect(() => room.subscribe('c1', () => {})).toThrow(/not connected/);
  });
});

describe('NodeSessionRoom — getSnapshot', () => {
  it('returns the initial snapshot bound to the room sessionId', async () => {
    const room = new NodeSessionRoom({ sessionId: 'sess-1', nowEpochMs: () => 1_700_000_000_000 });
    const snap = await room.getSnapshot();
    expect(snap.sessionId).toBe('sess-1');
    expect(snap.snapshotAtEpochMs).toBe(1_700_000_000_000);
  });

  it('respects an explicit initialSnapshot', async () => {
    const initial = createEmptySnapshot('sess-1', 1_700_000_000_000);
    initial.activeGuestCount = 3;
    const room = new NodeSessionRoom({ sessionId: 'sess-1', initialSnapshot: initial });
    expect((await room.getSnapshot()).activeGuestCount).toBe(3);
  });

  it('returns a copy — caller mutations do not leak into the room state', async () => {
    const room = new NodeSessionRoom({ sessionId: 'sess-1' });
    const snap = await room.getSnapshot();
    snap.queue.push({
      id: 'sneak',
      guestId: 'g',
      trackUri: 'u',
      trackName: 't',
      artistName: 'a',
      albumArtUrl: null,
      durationMs: 0,
      status: 'pending',
      skipVotes: 0,
      createdAtEpochMs: 0,
      decidedAtEpochMs: null,
    });
    const fresh = await room.getSnapshot();
    expect(fresh.queue).toEqual([]);
  });
});

describe('NodeSessionRoom — publish', () => {
  it('applies the event to the snapshot', async () => {
    const room = new NodeSessionRoom({ sessionId: 'sess-1' });
    await room.publish(SAMPLE_REQUESTED);
    const snap = await room.getSnapshot();
    expect(snap.pending.map((i) => i.id)).toEqual(['item-1']);
  });

  it('fans out to every subscriber', async () => {
    const room = new NodeSessionRoom({ sessionId: 'sess-1' });
    await room.connect(client({ clientId: 'c1' }));
    await room.connect(client({ clientId: 'c2' }));
    const a = vi.fn();
    const b = vi.fn();
    room.subscribe('c1', a);
    room.subscribe('c2', b);
    await room.publish(SAMPLE_REQUESTED);
    expect(a).toHaveBeenCalledWith(SAMPLE_REQUESTED);
    expect(b).toHaveBeenCalledWith(SAMPLE_REQUESTED);
  });

  it('does not call disconnected subscribers', async () => {
    const room = new NodeSessionRoom({ sessionId: 'sess-1' });
    await room.connect(client({ clientId: 'c1' }));
    const a = vi.fn();
    room.subscribe('c1', a);
    await room.disconnect('c1');
    await room.publish(SAMPLE_REQUESTED);
    expect(a).not.toHaveBeenCalled();
  });

  it('swallows subscriber errors so one bad client cannot block broadcast', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const room = new NodeSessionRoom({ sessionId: 'sess-1' });
      await room.connect(client({ clientId: 'c1' }));
      await room.connect(client({ clientId: 'c2' }));
      const good = vi.fn();
      room.subscribe('c1', () => {
        throw new Error('boom');
      });
      room.subscribe('c2', good);
      await room.publish(SAMPLE_REQUESTED);
      expect(good).toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('updates snapshotAtEpochMs after each publish', async () => {
    const ticks = [1_000, 2_000, 3_000];
    let i = 0;
    const room = new NodeSessionRoom({
      sessionId: 'sess-1',
      nowEpochMs: () => ticks[i++]!,
    });
    await room.publish(SAMPLE_REQUESTED);
    const snap = await room.getSnapshot();
    expect(snap.snapshotAtEpochMs).toBe(2_000);
  });
});

describe('NodeSessionRoom — mutate', () => {
  it('throws — v1 has no command handler registry', async () => {
    const room = new NodeSessionRoom({ sessionId: 'sess-1' });
    await expect(room.mutate({ type: 'end_session', endedByUserId: 'u-1' })).rejects.toThrow(
      /not implemented/,
    );
  });
});

describe('NodeSessionRoom — setSnapshot (boot rehydration)', () => {
  it('replaces the snapshot wholesale', async () => {
    const room = new NodeSessionRoom({ sessionId: 'sess-1' });
    const replacement = createEmptySnapshot('sess-1', 1_700_000_000_000);
    replacement.activeGuestCount = 9;
    room.setSnapshot(replacement);
    const snap = await room.getSnapshot();
    expect(snap.activeGuestCount).toBe(9);
  });
});
