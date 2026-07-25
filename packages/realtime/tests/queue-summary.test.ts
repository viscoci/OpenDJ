import { describe, expect, it } from 'vitest';
import type { QueueItem } from '@opendj/core';
import { toQueueItemSummary } from '../src/types/queue-summary.js';

function item(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 'item-1',
    sessionId: 'sess-1',
    guestId: 'guest-1',
    trackUri: 'spotify:track:abc',
    trackName: 'Hello',
    artistName: 'World',
    albumArtUrl: 'https://example.com/art.jpg',
    durationMs: 200_000,
    status: 'pending',
    skipVotes: 0,
    createdAt: new Date('2026-04-30T12:00:00Z'),
    decidedAt: null,
    ...overrides,
  };
}

describe('toQueueItemSummary', () => {
  it('projects core fields', () => {
    const summary = toQueueItemSummary(item());
    expect(summary).toEqual({
      id: 'item-1',
      guestId: 'guest-1',
      trackUri: 'spotify:track:abc',
      trackName: 'Hello',
      artistName: 'World',
      albumArtUrl: 'https://example.com/art.jpg',
      durationMs: 200_000,
      status: 'pending',
      skipVotes: 0,
      createdAtEpochMs: new Date('2026-04-30T12:00:00Z').getTime(),
      decidedAtEpochMs: null,
      karaokeClaims: [],
    });
  });

  it('defaults karaokeClaims to an empty array', () => {
    const summary = toQueueItemSummary(item());
    expect(summary.karaokeClaims).toEqual([]);
  });

  it('attaches the provided karaoke claims', () => {
    const claims = [
      { guestId: 'guest-1', displayName: 'Ana' },
      { guestId: 'guest-2', displayName: 'Ben' },
    ];
    const summary = toQueueItemSummary(item(), claims);
    expect(summary.karaokeClaims).toEqual(claims);
  });

  it('converts decidedAt Date to epoch ms', () => {
    const decidedAt = new Date('2026-04-30T12:01:00Z');
    const summary = toQueueItemSummary(item({ decidedAt }));
    expect(summary.decidedAtEpochMs).toBe(decidedAt.getTime());
  });

  it('preserves null albumArtUrl + null durationMs', () => {
    const summary = toQueueItemSummary(item({ albumArtUrl: null, durationMs: null }));
    expect(summary.albumArtUrl).toBeNull();
    expect(summary.durationMs).toBeNull();
  });

  it('does NOT include sessionId in the summary (broadcast scope)', () => {
    const summary = toQueueItemSummary(item());
    expect((summary as Record<string, unknown>).sessionId).toBeUndefined();
  });
});
