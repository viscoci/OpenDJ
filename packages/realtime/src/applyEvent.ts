/**
 * Pure snapshot transition function. Given a SessionSnapshot and a SessionEvent,
 * return the next SessionSnapshot. No side effects.
 *
 * Both NodeSessionRoom (OSS) and the hosted SessionRoom Durable Object call
 * this on every publish so the realtime snapshot stays in sync with the
 * events being broadcast.
 */

import type { SessionEvent } from './types/event.js';
import type { SessionSnapshot } from './types/snapshot.js';

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

    case 'now_playing.updated':
      return { ...snapshot, nowPlaying: event.track };

    case 'skip_vote.updated': {
      const queueIdx = snapshot.queue.findIndex((i) => i.id === event.itemId);
      if (queueIdx < 0) return snapshot;
      const queue = [...snapshot.queue];
      queue[queueIdx] = { ...queue[queueIdx]!, skipVotes: event.votes };
      return { ...snapshot, queue };
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
