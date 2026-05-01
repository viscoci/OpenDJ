import type { QueueItem } from '../types/queue.js';

export type ModerationDecision = 'approved' | 'rejected';

/**
 * Pure transform for moderation. Returns a NEW QueueItem with status updated
 * and `decidedAt` set to `now`. Does not mutate the input.
 *
 * Approving an already-rejected item, or vice-versa, is allowed: hosts can
 * reverse a previous decision. The returned `decidedAt` reflects the latest
 * call.
 *
 * `now` is required (not defaulted) so tests stay deterministic and so callers
 * can use a single coherent timestamp across multiple moderations in one batch.
 */
export function applyModerationDecision(
  item: QueueItem,
  decision: ModerationDecision,
  now: Date,
): QueueItem {
  return {
    ...item,
    status: decision,
    decidedAt: now,
  };
}
