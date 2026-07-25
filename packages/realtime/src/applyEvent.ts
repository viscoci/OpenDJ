/**
 * Pure snapshot transition function. Given a SessionSnapshot and a SessionEvent,
 * return the next SessionSnapshot. No side effects.
 *
 * Both NodeSessionRoom (OSS) and the hosted SessionRoom Durable Object call
 * this on every publish so the realtime snapshot stays in sync with the
 * events being broadcast.
 */

import type { SessionEvent } from './types/event.js';
import type { QueueItemSummary } from './types/queue-summary.js';
import {
  createEmptyKaraokeState,
  RECENTLY_PLAYED_MAX,
  type SessionSnapshot,
} from './types/snapshot.js';

/**
 * Apply `update` to the item with `itemId` wherever it lives (pending or
 * queue). Returns the input snapshot unchanged when the id is unknown.
 */
function updateItemById(
  snapshot: SessionSnapshot,
  itemId: string,
  update: (item: QueueItemSummary) => QueueItemSummary,
): SessionSnapshot {
  const pendingIdx = snapshot.pending.findIndex((i) => i.id === itemId);
  if (pendingIdx >= 0) {
    const pending = [...snapshot.pending];
    pending[pendingIdx] = update(pending[pendingIdx]!);
    return { ...snapshot, pending };
  }
  const queueIdx = snapshot.queue.findIndex((i) => i.id === itemId);
  if (queueIdx >= 0) {
    const queue = [...snapshot.queue];
    queue[queueIdx] = update(queue[queueIdx]!);
    return { ...snapshot, queue };
  }
  return snapshot;
}

export function applyEvent(snapshot: SessionSnapshot, event: SessionEvent): SessionSnapshot {
  switch (event.type) {
    case 'queue.item_requested':
      return {
        ...snapshot,
        pending: [...snapshot.pending, event.item],
      };

    case 'queue.item_approved': {
      const idx = snapshot.pending.findIndex((i) => i.id === event.itemId);
      if (idx < 0) {
        // Already-approved or unknown id — be permissive, just touch status if found in queue.
        const queueIdx = snapshot.queue.findIndex((i) => i.id === event.itemId);
        if (queueIdx < 0) return snapshot;
        const queue = [...snapshot.queue];
        queue[queueIdx] = { ...queue[queueIdx]!, status: 'approved' };
        return { ...snapshot, queue };
      }
      const moved = { ...snapshot.pending[idx]!, status: 'approved' as const };
      const pending = [...snapshot.pending.slice(0, idx), ...snapshot.pending.slice(idx + 1)];
      return { ...snapshot, pending, queue: [...snapshot.queue, moved] };
    }

    case 'queue.item_rejected': {
      const idx = snapshot.pending.findIndex((i) => i.id === event.itemId);
      if (idx >= 0) {
        const pending = [...snapshot.pending.slice(0, idx), ...snapshot.pending.slice(idx + 1)];
        return { ...snapshot, pending };
      }
      const queueIdx = snapshot.queue.findIndex((i) => i.id === event.itemId);
      if (queueIdx < 0) return snapshot;
      const queue = [...snapshot.queue.slice(0, queueIdx), ...snapshot.queue.slice(queueIdx + 1)];
      return { ...snapshot, queue };
    }

    case 'queue.item_removed':
      return {
        ...snapshot,
        queue: snapshot.queue.filter((i) => i.id !== event.itemId),
        pending: snapshot.pending.filter((i) => i.id !== event.itemId),
      };

    case 'now_playing.updated': {
      // Roll the previous track onto recentlyPlayed when it actually
      // changes (different uri or null transition). Same-track updates
      // (progress/isPlaying flips) do NOT churn the history.
      const prev = snapshot.nowPlaying;
      const next = event.track;
      const trackChanged =
        (prev === null && next !== null) ||
        (prev !== null && next === null) ||
        (prev !== null && next !== null && prev.uri !== next.uri);
      let recentlyPlayed = snapshot.recentlyPlayed;
      if (trackChanged && prev !== null) {
        // Avoid duplicate adjacent entries (defensive — `prev !== next.uri`
        // already gated this, but just in case applyEvent is called twice).
        const head = recentlyPlayed[0];
        if (!head || head.uri !== prev.uri) {
          recentlyPlayed = [prev, ...recentlyPlayed].slice(0, RECENTLY_PLAYED_MAX);
        }
      }
      // Skip-vote tally is bound to a single track URI — drop it on any
      // track transition so the count restarts at 0 for the new song.
      const nowPlayingSkipVote = trackChanged ? null : snapshot.nowPlayingSkipVote;
      // Lyrics are bound to the previous track's URI — carrying them across
      // a track change would let a mid-join/reconnect client render the old
      // song's lyrics under the new track until its own lyrics.loaded lands.
      const lyrics = trackChanged ? null : snapshot.lyrics;
      return { ...snapshot, nowPlaying: next, recentlyPlayed, nowPlayingSkipVote, lyrics };
    }

    case 'now_playing_skip_vote.updated':
      return {
        ...snapshot,
        nowPlayingSkipVote: {
          trackUri: event.trackUri,
          count: event.count,
          threshold: event.threshold,
        },
      };

    case 'skip_vote.updated': {
      const queueIdx = snapshot.queue.findIndex((i) => i.id === event.itemId);
      if (queueIdx < 0) return snapshot;
      const queue = [...snapshot.queue];
      queue[queueIdx] = { ...queue[queueIdx]!, skipVotes: event.votes };
      return { ...snapshot, queue };
    }

    case 'provider_queue.updated': {
      // Drop any per-URI skip-vote tallies whose track has rolled out of
      // the provider queue — the vote becomes meaningless once the track
      // is no longer scheduled.
      const remainingUris = new Set(event.tracks.map((t) => t.uri));
      let providerQueueSkipVotes = snapshot.providerQueueSkipVotes;
      for (const uri of Object.keys(providerQueueSkipVotes)) {
        if (!remainingUris.has(uri)) {
          if (providerQueueSkipVotes === snapshot.providerQueueSkipVotes) {
            providerQueueSkipVotes = { ...providerQueueSkipVotes };
          }
          delete providerQueueSkipVotes[uri];
        }
      }
      return { ...snapshot, providerQueue: event.tracks, providerQueueSkipVotes };
    }

    case 'provider_queue_skip_vote.updated':
      return {
        ...snapshot,
        providerQueueSkipVotes: {
          ...snapshot.providerQueueSkipVotes,
          [event.trackUri]: { count: event.count, threshold: event.threshold },
        },
      };

    case 'karaoke.claim_added':
      // Replace-then-append keeps the fold idempotent — re-delivery of the
      // same claim (or a display-name change) never duplicates a singer.
      return updateItemById(snapshot, event.itemId, (item) => ({
        ...item,
        karaokeClaims: [
          ...item.karaokeClaims.filter((c) => c.guestId !== event.claim.guestId),
          event.claim,
        ],
      }));

    case 'karaoke.claim_removed':
      return updateItemById(snapshot, event.itemId, (item) => ({
        ...item,
        karaokeClaims: item.karaokeClaims.filter((c) => c.guestId !== event.guestId),
      }));

    case 'karaoke.spotlight': {
      // `?? createEmptyKaraokeState()` tolerates snapshots serialized by
      // older servers that predate the karaoke slice.
      const prev = snapshot.karaoke ?? createEmptyKaraokeState();
      const changed = prev.spotlightItemId !== event.itemId;
      const karaoke = {
        spotlightItemId: event.itemId,
        // A pause is bound to its spotlight item — a NEW (or cleared)
        // spotlight drops any stale hold. Same-item re-broadcast keeps it.
        paused: changed ? false : prev.paused,
        pausedUntilEpochMs: changed ? null : prev.pausedUntilEpochMs,
      };
      // Refresh the spotlighted item's singer list from the event so a
      // client that missed claim deltas still renders the right names.
      const next =
        event.itemId === null
          ? snapshot
          : updateItemById(snapshot, event.itemId, (item) => ({
              ...item,
              karaokeClaims: [...event.claims],
            }));
      return { ...next, karaoke };
    }

    case 'karaoke.paused':
      return {
        ...snapshot,
        karaoke: {
          spotlightItemId: event.itemId,
          paused: true,
          pausedUntilEpochMs: event.untilEpochMs,
        },
      };

    case 'karaoke.resumed': {
      const prev = snapshot.karaoke ?? createEmptyKaraokeState();
      return { ...snapshot, karaoke: { ...prev, paused: false, pausedUntilEpochMs: null } };
    }

    case 'guest_slots.updated':
      return {
        ...snapshot,
        activeGuestCount: event.activeCount,
        queuedGuestCount: event.queuedCount,
      };

    case 'playback.clock_sampled':
      return { ...snapshot, playbackClock: event.sample };

    case 'playback.corrected':
      // Predicted positions are read-only signals — the snapshot's playbackClock
      // remains the durable sample. Don't mutate; clients consume the event directly.
      return snapshot;

    case 'lyrics.loaded':
      return { ...snapshot, lyrics: event.lyrics };

    case 'lyrics.feedback_recorded':
      // Feedback doesn't change the snapshot — it's a write-side event.
      return snapshot;

    case 'sync.cue_window_updated':
      // Caller decides whether to also emit a `lyrics.loaded` to refresh
      // the snapshot's window — the cue stream itself is broadcast directly.
      return snapshot;

    case 'session.ended':
      // Snapshot kept as-is; consumers detect end via the event itself.
      return snapshot;
  }
}
