import type { Account, Plan } from '../../src/types/account.js';
import type { Guest } from '../../src/types/guest.js';
import type { QueueItem, QueueItemStatus } from '../../src/types/queue.js';
import type { Session, VoteSkipMode } from '../../src/types/session.js';

export function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'acc-1',
    displayName: 'Test Account',
    slug: 'test',
    plan: 'free' satisfies Plan,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

export function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    accountId: 'acc-1',
    name: 'Test Session',
    qrSlug: 'test',
    guestCapOverride: null,
    songsPerGuestCap: 3,
    maxConsecutivePerGuest: null,
    moderationEnabled: false,
    voteSkipMode: 'fixed' satisfies VoteSkipMode,
    voteSkipThreshold: 5,
    karaokeMode: 'off',
    karaokeMicCount: 1,
    karaokePauseMode: 'manual',
    karaokePauseTimeoutSec: 30,
    startedAt: new Date('2026-01-01T00:00:00Z'),
    endedAt: null,
    ...overrides,
  };
}

export function makeGuest(overrides: Partial<Guest> = {}): Guest {
  return {
    id: 'guest-1',
    sessionId: 'sess-1',
    userId: null,
    fingerprint: 'fp-1',
    name: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

export function makeItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 'item-1',
    sessionId: 'sess-1',
    guestId: 'guest-1',
    trackUri: 'spotify:track:default',
    trackName: 'Default',
    artistName: 'Tester',
    albumArtUrl: null,
    durationMs: 200_000,
    status: 'pending' satisfies QueueItemStatus,
    skipVotes: 0,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    decidedAt: null,
    ...overrides,
  };
}
