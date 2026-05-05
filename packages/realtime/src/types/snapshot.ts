import type { NowPlayingTrack, Track } from '@opendj/core';
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
  /**
   * Last few tracks that played in this session, most recent first. Capped
   * to a small window (default 10) — this is a transient, in-room view, not
   * an analytics archive. The first entry is the track that was playing
   * RIGHT BEFORE `nowPlaying`. Use it for "Recently played" strips on
   * guest + TV views without making a separate query.
   */
  recentlyPlayed: NowPlayingTrack[];
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
  /**
   * Tracks the streaming provider says will play next, in order. This is
   * the host's actual playback queue (Spotify queue, etc.) — separate
   * from the OpenDJ-mediated `queue` above. Empty when the provider
   * doesn't expose a queue read or no provider is connected.
   */
  providerQueue: Track[];
  /** Number of guest slots currently in the `active` state. */
  activeGuestCount: number;
  /** Number of guest slots currently waiting for a free slot. */
  queuedGuestCount: number;
  /** Wall-clock time at which this snapshot was assembled. Used for staleness checks. */
  snapshotAtEpochMs: number;
}

/** Cap on `SessionSnapshot.recentlyPlayed` length. Older entries fall off. */
export const RECENTLY_PLAYED_MAX = 10;

/** Empty snapshot for a fresh session — useful for initialization in tests + room boot. */
export function createEmptySnapshot(sessionId: string, nowEpochMs: number): SessionSnapshot {
  return {
    sessionId,
    nowPlaying: null,
    recentlyPlayed: [],
    playbackClock: null,
    lyrics: null,
    activeLyricsWindow: [],
    queue: [],
    pending: [],
    providerQueue: [],
    activeGuestCount: 0,
    queuedGuestCount: 0,
    snapshotAtEpochMs: nowEpochMs,
  };
}
