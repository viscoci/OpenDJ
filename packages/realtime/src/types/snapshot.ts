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
  /**
   * Client-computed; the server never populates this (kept empty by design).
   * Clients derive the active window from `lyrics` + `playbackClock` using
   * `predictPlaybackPosition` locally — see the LyricsEngine in @opendj/frontend.
   */
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
  /**
   * Live skip-vote tally against whatever's currently playing. Bound to
   * the now-playing track's URI — when nowPlaying transitions to a
   * different URI, this resets to count=0. `threshold` is read from
   * `session.voteSkipThreshold` at the time of the first vote.
   * Null when nothing is playing.
   */
  nowPlayingSkipVote: {
    trackUri: string;
    count: number;
    threshold: number;
  } | null;
  /**
   * Live skip-vote tallies against provider-queue tracks (Spotify queue
   * tracks the host added directly, etc.). Keyed by trackUri. Cleared
   * server-side as URIs leave the provider queue. Empty object when no
   * provider-track votes have been cast since boot.
   */
  providerQueueSkipVotes: Record<string, { count: number; threshold: number }>;
  /** Number of guest slots currently in the `active` state. */
  activeGuestCount: number;
  /** Number of guest slots currently waiting for a free slot. */
  queuedGuestCount: number;
  /**
   * Karaoke spotlight + pause state (spec §4/§5). The spotlight is the
   * queue item whose claimed track is currently playing; `paused` is true
   * while playback is karaoke-held (guest pause or `auto` pause mode) and
   * `pausedUntilEpochMs` is the wall-clock auto-resume deadline.
   *
   * Older servers may broadcast snapshots without this field — consumers
   * (and `applyEvent`) treat absence as the empty state below.
   */
  karaoke: KaraokeSnapshotState;
  /** Wall-clock time at which this snapshot was assembled. Used for staleness checks. */
  snapshotAtEpochMs: number;
}

/** Karaoke spotlight + pause slice of the session snapshot. */
export interface KaraokeSnapshotState {
  /** Queue item currently in the karaoke spotlight; null when none. */
  spotlightItemId: string | null;
  /** True while playback is karaoke-paused. */
  paused: boolean;
  /** Auto-resume deadline (wall clock) while paused; null otherwise. */
  pausedUntilEpochMs: number | null;
}

/** Default karaoke state — no spotlight, not paused. Fresh object per call. */
export function createEmptyKaraokeState(): KaraokeSnapshotState {
  return { spotlightItemId: null, paused: false, pausedUntilEpochMs: null };
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
    nowPlayingSkipVote: null,
    providerQueueSkipVotes: {},
    activeGuestCount: 0,
    queuedGuestCount: 0,
    karaoke: createEmptyKaraokeState(),
    snapshotAtEpochMs: nowEpochMs,
  };
}
