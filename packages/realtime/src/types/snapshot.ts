import type { NowPlayingTrack } from '@opendj/core';
import type { LyricsDocument, LyricsLine } from '@opendj/lyrics';
import type { PlaybackClockSample } from '@opendj/sync';
import type { QueueItemSummary } from './queue-summary.js';

/**
 * Compact session state broadcast to clients on (re)connect and on snapshot
 * correction events. Postgres remains the durable source of truth; the room
 * is the realtime source of truth while the session is live.
 *
 * See docs/agent-brief.md §"Realtime and caching architecture".
 */
export interface SessionSnapshot {
  sessionId: string;
  nowPlaying: NowPlayingTrack | null;
  /** Most recent playback clock sample. Clients interpolate locally. */
  playbackClock: PlaybackClockSample | null;
  /** Current lyrics document (synced or unsynced). null when no match. */
  lyrics: LyricsDocument | null;
  /** Pre-computed window around the active position for TV/live view convenience. */
  activeLyricsWindow: LyricsLine[];
  /** Approved or queued items awaiting / during playback. */
  queue: QueueItemSummary[];
  /** Items still awaiting host moderation. */
  pending: QueueItemSummary[];
  /** Number of guest slots currently in the `active` state. */
  activeGuestCount: number;
  /** Number of guest slots currently waiting for a free slot. */
  queuedGuestCount: number;
  /** Wall-clock time at which this snapshot was assembled. Used for staleness checks. */
  snapshotAtEpochMs: number;
}

/** Empty snapshot for a fresh session — useful for initialization in tests + room boot. */
export function createEmptySnapshot(sessionId: string, nowEpochMs: number): SessionSnapshot {
  return {
    sessionId,
    nowPlaying: null,
    playbackClock: null,
    lyrics: null,
    activeLyricsWindow: [],
    queue: [],
    pending: [],
    activeGuestCount: 0,
    queuedGuestCount: 0,
    snapshotAtEpochMs: nowEpochMs,
  };
}
