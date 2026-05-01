import type { NowPlayingTrack, Track } from '@opendj/core';
import type { LyricsFeedbackInput } from '@opendj/lyrics';
import type { PlaybackClockSample } from '@opendj/sync';

/**
 * Mutations the realtime room serializes against in-memory state. The room
 * persists the durable consequence to Postgres and broadcasts the resulting
 * SessionEvent to connected clients.
 *
 * Commands are issued from authenticated request handlers — the room itself
 * does not authorize. By the time a command reaches the room, the calling
 * route has already verified claims, slot tokens, and abuse decisions.
 */
export type SessionCommand =
  | { type: 'enqueue'; track: Track; guestId: string }
  | {
      type: 'moderate';
      itemId: string;
      decision: 'approved' | 'rejected';
      moderatedByUserId: string;
    }
  | { type: 'remove_item'; itemId: string; byGuestId: string }
  | { type: 'cast_skip_vote'; itemId: string; byGuestId: string }
  | { type: 'set_now_playing'; track: NowPlayingTrack | null }
  | { type: 'sample_playback_clock'; sample: PlaybackClockSample }
  | { type: 'record_lyrics_feedback'; feedback: LyricsFeedbackInput }
  | { type: 'end_session'; endedByUserId: string };

export type SessionCommandType = SessionCommand['type'];

export function isCommandOfType<T extends SessionCommandType>(
  command: SessionCommand,
  type: T,
): command is Extract<SessionCommand, { type: T }> {
  return command.type === type;
}
