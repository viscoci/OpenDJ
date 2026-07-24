import type { KaraokeClaimSummary } from '@opendj/realtime';
import type { KaraokeClaimRecord } from '../repositories/types.js';

/** Project a claim record to its broadcast-safe summary. */
export function toKaraokeClaimSummary(claim: KaraokeClaimRecord): KaraokeClaimSummary {
  return { guestId: claim.guestId, displayName: claim.displayName };
}

/**
 * Group claim records by queue item id, preserving the repository's
 * oldest-first order within each item. Routes use this to attach
 * `karaokeClaims` wherever a `QueueItemSummary` is built:
 *
 * ```ts
 * const byItem = groupClaimSummaries(await karaokeClaims.findAllForSession(id));
 * toQueueItemSummary(item, byItem.get(item.id) ?? []);
 * ```
 */
export function groupClaimSummaries(
  claims: KaraokeClaimRecord[],
): Map<string, KaraokeClaimSummary[]> {
  const byItem = new Map<string, KaraokeClaimSummary[]>();
  for (const claim of claims) {
    const list = byItem.get(claim.queueItemId);
    if (list) list.push(toKaraokeClaimSummary(claim));
    else byItem.set(claim.queueItemId, [toKaraokeClaimSummary(claim)]);
  }
  return byItem;
}
