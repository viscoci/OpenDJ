import type { NowPlayingTrack, Track } from '@opendj/core';
import type { LyricsDocument, LyricsFeedbackKind } from '@opendj/lyrics';
import type { PlaybackClockSample, PredictedPlaybackPosition, SyncCue } from '@opendj/sync';
import type { KaraokeClaimSummary, QueueItemSummary } from './queue-summary.js';

/**
 * Discriminated union of every realtime event broadcast by a SessionRoom /
 * NodeSessionRoom to connected clients.
 *
 * High-frequency progress ticks are intentionally NOT in this union — clients
 * locally interpolate from the most recent `playback.clock_sampled` /
 * `playback.corrected` event using `predictPlaybackPosition` from @opendj/sync.
 *
 * See docs/agent-brief.md §"Event model".
 */
export type SessionEvent =
  // Queue lifecycle
  | { type: 'queue.item_requested'; item: QueueItemSummary }
  | { type: 'queue.item_approved'; itemId: string }
  | { type: 'queue.item_rejected'; itemId: string }
  | { type: 'queue.item_removed'; itemId: string }
  // Now playing + skip
  | { type: 'now_playing.updated'; track: NowPlayingTrack | null }
  | { type: 'skip_vote.updated'; itemId: string; votes: number; threshold: number }
  // Live skip-vote tally against the currently-playing track. `count: 0`
  // is the reset signal when the track transitions.
  | {
      type: 'now_playing_skip_vote.updated';
      trackUri: string;
      count: number;
      threshold: number;
    }
  // Provider's own playback queue (Spotify queue, etc.) — fires when the
  // poller sees a change. Separate from queue.item_* which only describes
  // the OpenDJ moderation list.
  | { type: 'provider_queue.updated'; tracks: Track[] }
  // Live skip-vote tally against a provider-queue track that has no OpenDJ
  // counterpart (host added it via Spotify directly, playlist context,
  // etc.). Separate from `skip_vote.updated` (queue_items.id keyed) because
  // there's no item id to reference. The server clears stale entries when
  // the URI leaves the provider queue.
  | {
      type: 'provider_queue_skip_vote.updated';
      trackUri: string;
      count: number;
      threshold: number;
    }
  // Karaoke mic claims — folded into the matching queue/pending item's
  // `karaokeClaims` array by the reducer.
  | { type: 'karaoke.claim_added'; itemId: string; claim: KaraokeClaimSummary }
  | { type: 'karaoke.claim_removed'; itemId: string; guestId: string }
  // Karaoke spotlight + pause lifecycle (snapshot.karaoke slice).
  // `spotlight` fires when the playing track lands on (or leaves) a claimed
  // queue item — `itemId: null` clears it; `claims` snapshots the singers so
  // late joiners render names without replaying claim deltas. `paused` /
  // `resumed` bracket a karaoke playback hold; `untilEpochMs` is the
  // wall-clock auto-resume deadline.
  | { type: 'karaoke.spotlight'; itemId: string | null; claims: KaraokeClaimSummary[] }
  | { type: 'karaoke.paused'; itemId: string; untilEpochMs: number }
  | { type: 'karaoke.resumed'; itemId: string }
  // Guest slots
  | { type: 'guest_slots.updated'; activeCount: number; queuedCount: number }
  // Playback clock + correction (sync layer)
  | { type: 'playback.clock_sampled'; sample: PlaybackClockSample }
  | { type: 'playback.corrected'; position: PredictedPlaybackPosition }
  // Lyrics + cues
  | { type: 'lyrics.loaded'; trackUri: string; lyrics: LyricsDocument | null }
  | { type: 'lyrics.feedback_recorded'; trackUri: string; feedbackKind: LyricsFeedbackKind }
  | { type: 'sync.cue_window_updated'; trackUri: string; cues: SyncCue[] }
  // Session lifecycle
  | { type: 'session.ended' };

export type SessionEventType = SessionEvent['type'];

/**
 * Narrow `SessionEvent` to a specific variant by its discriminant.
 *
 * ```ts
 * if (isEventOfType(event, 'queue.item_requested')) {
 *   event.item; // QueueItemSummary, narrowed
 * }
 * ```
 */
export function isEventOfType<T extends SessionEventType>(
  event: SessionEvent,
  type: T,
): event is Extract<SessionEvent, { type: T }> {
  return event.type === type;
}

const QUEUE_EVENT_TYPES = new Set<SessionEventType>([
  'queue.item_requested',
  'queue.item_approved',
  'queue.item_rejected',
  'queue.item_removed',
  'skip_vote.updated',
]);

const PLAYBACK_EVENT_TYPES = new Set<SessionEventType>([
  'now_playing.updated',
  'playback.clock_sampled',
  'playback.corrected',
]);

const LYRICS_EVENT_TYPES = new Set<SessionEventType>([
  'lyrics.loaded',
  'lyrics.feedback_recorded',
  'sync.cue_window_updated',
]);

export function isQueueEvent(event: SessionEvent): boolean {
  return QUEUE_EVENT_TYPES.has(event.type);
}

export function isPlaybackEvent(event: SessionEvent): boolean {
  return PLAYBACK_EVENT_TYPES.has(event.type);
}

export function isLyricsEvent(event: SessionEvent): boolean {
  return LYRICS_EVENT_TYPES.has(event.type);
}
