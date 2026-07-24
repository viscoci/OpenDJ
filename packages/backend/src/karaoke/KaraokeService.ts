/**
 * KaraokeService — guest mic claims on queue items.
 *
 * Domain rules from `@opendj/core`:
 * - `canClaimMic` for the gate (karaoke on? item claimable? mics free?
 *   guest not already on it?)
 * - `canRemoveClaim` for guest self-removal (own claim, item still waiting)
 *
 * Mirrors QueueService: resolve slot → guest → session, run the pure rule,
 * persist, broadcast to the realtime room, best-effort audit. Host removal
 * bypasses `canRemoveClaim` (spec: "host can remove any claim").
 */

import {
  canClaimMic,
  canRemoveClaim,
  type KaraokeClaim,
  type QueueItem,
  type Session,
} from '@opendj/core';
import type { RealtimeRoom, SessionEvent } from '@opendj/realtime';
import type {
  GuestRepository,
  GuestSlotRepository,
  KaraokeClaimRecord,
  KaraokeClaimRepository,
  QueueItemRecord,
  QueueItemRepository,
  SessionRecord,
  SessionRepository,
} from '../repositories/types.js';
import {
  guestLabelFromFingerprint,
  type SessionAuditService,
} from '../session/SessionAuditService.js';
import { sanitizeKaraokeDisplayName } from './displayName.js';

export class KaraokeServiceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'KaraokeServiceError';
    this.code = code;
  }
}

export interface KaraokeRoomRegistry {
  forSession(sessionId: string): RealtimeRoom | null;
}

export interface KaraokeServiceDeps {
  sessions: SessionRepository;
  guests: GuestRepository;
  guestSlots: GuestSlotRepository;
  queueItems: QueueItemRepository;
  karaokeClaims: KaraokeClaimRepository;
  /** Optional room — when provided, mutations broadcast events. */
  rooms?: KaraokeRoomRegistry;
  /** Optional host-facing audit trail. Best-effort. */
  audit?: SessionAuditService;
}

export class KaraokeService {
  constructor(private readonly deps: KaraokeServiceDeps) {}

  /**
   * Guest action: claim a mic on a queue item.
   *
   * Flow: resolve slot → guest → session → item → sanitize name → run
   * `canClaimMic` → insert → broadcast `karaoke.claim_added`.
   */
  async claim(input: {
    sessionId: string;
    slotToken: string;
    queueItemId: string;
    displayName: string;
  }): Promise<KaraokeClaimRecord> {
    const { slot, session, guest } = await this.resolveGuest(input.sessionId, input.slotToken);
    const item = await this.resolveItem(input.sessionId, input.queueItemId);

    const displayName = sanitizeKaraokeDisplayName(input.displayName);
    if (displayName === null) {
      throw new KaraokeServiceError(
        'invalid_display_name',
        'Display name must be 1-40 characters after trimming.',
      );
    }

    const existingClaims = await this.deps.karaokeClaims.findAllForItem(input.queueItemId);
    const decision = canClaimMic(
      sessionToDomain(session),
      itemToDomain(item),
      existingClaims.map(claimToDomain),
      guest.id,
    );
    if (!decision.ok) {
      throw new KaraokeServiceError(decision.reason, `canClaimMic rejected: ${decision.reason}`);
    }

    const created = await this.deps.karaokeClaims.create({
      sessionId: input.sessionId,
      queueItemId: input.queueItemId,
      guestId: guest.id,
      displayName,
    });

    await this.publishToRoom(input.sessionId, {
      type: 'karaoke.claim_added',
      itemId: input.queueItemId,
      claim: { guestId: guest.id, displayName },
    });

    void this.deps.audit?.record({
      sessionId: input.sessionId,
      actorKind: 'guest',
      actorId: guest.id,
      actorLabel: guestLabelFromFingerprint(slot.fingerprintHash),
      action: 'karaoke.claim_added',
      details: {
        itemId: input.queueItemId,
        trackUri: item.trackUri,
        trackName: item.trackName,
        displayName,
      },
    });

    return created;
  }

  /**
   * Guest action: remove their OWN claim while the item is still waiting.
   */
  async removeClaim(input: {
    sessionId: string;
    slotToken: string;
    queueItemId: string;
  }): Promise<void> {
    const { slot, guest } = await this.resolveGuest(input.sessionId, input.slotToken);
    const item = await this.resolveItem(input.sessionId, input.queueItemId);

    const claim = await this.deps.karaokeClaims.findByItemAndGuest(input.queueItemId, guest.id);
    if (!claim) {
      throw new KaraokeServiceError('claim_not_found', 'No claim by this guest on this item.');
    }

    const decision = canRemoveClaim(itemToDomain(item), claimToDomain(claim), guest.id);
    if (!decision.ok) {
      throw new KaraokeServiceError(decision.reason, `canRemoveClaim rejected: ${decision.reason}`);
    }

    await this.deps.karaokeClaims.delete(claim.id);
    await this.publishToRoom(input.sessionId, {
      type: 'karaoke.claim_removed',
      itemId: input.queueItemId,
      guestId: guest.id,
    });

    void this.deps.audit?.record({
      sessionId: input.sessionId,
      actorKind: 'guest',
      actorId: guest.id,
      actorLabel: guestLabelFromFingerprint(slot.fingerprintHash),
      action: 'karaoke.claim_removed',
      details: {
        itemId: input.queueItemId,
        trackUri: item.trackUri,
        trackName: item.trackName,
      },
    });
  }

  /**
   * Host action: remove ANY guest's claim. Bypasses `canRemoveClaim`
   * entirely (works even mid-song) — the host override from the spec.
   */
  async hostRemoveClaim(input: {
    sessionId: string;
    queueItemId: string;
    guestId: string;
    actor?: { userId: string; label?: string };
  }): Promise<void> {
    const item = await this.resolveItem(input.sessionId, input.queueItemId);

    const claim = await this.deps.karaokeClaims.findByItemAndGuest(
      input.queueItemId,
      input.guestId,
    );
    if (!claim) {
      throw new KaraokeServiceError('claim_not_found', 'No claim by that guest on this item.');
    }

    await this.deps.karaokeClaims.delete(claim.id);
    await this.publishToRoom(input.sessionId, {
      type: 'karaoke.claim_removed',
      itemId: input.queueItemId,
      guestId: input.guestId,
    });

    void this.deps.audit?.record({
      sessionId: input.sessionId,
      actorKind: 'host',
      actorId: input.actor?.userId ?? null,
      actorLabel: input.actor?.label ?? 'Host',
      action: 'karaoke.claim_removed',
      details: {
        itemId: input.queueItemId,
        trackUri: item.trackUri,
        trackName: item.trackName,
        guestId: input.guestId,
      },
    });
  }

  /** Shared slot → session → guest resolution (same order as QueueService). */
  private async resolveGuest(sessionId: string, slotToken: string) {
    const slot = await this.deps.guestSlots.findBySlotToken(slotToken);
    if (!slot) throw new KaraokeServiceError('unknown_slot_token', 'Unknown slot token.');
    if (slot.sessionId !== sessionId) {
      throw new KaraokeServiceError(
        'slot_session_mismatch',
        'Slot does not belong to this session.',
      );
    }
    if (slot.status !== 'active') {
      throw new KaraokeServiceError('slot_not_active', `Slot status is "${slot.status}".`);
    }

    const session = await this.deps.sessions.findById(sessionId);
    if (!session) throw new KaraokeServiceError('session_not_found', 'Unknown session.');

    const guest = await this.deps.guests.findBySessionAndFingerprint(
      sessionId,
      slot.fingerprintHash,
    );
    if (!guest) {
      throw new KaraokeServiceError('guest_not_found', 'No guest row for this slot fingerprint.');
    }
    return { slot, session, guest };
  }

  private async resolveItem(sessionId: string, queueItemId: string): Promise<QueueItemRecord> {
    const item = await this.deps.queueItems.findById(queueItemId);
    if (!item) throw new KaraokeServiceError('item_not_found', 'Unknown queue item.');
    if (item.sessionId !== sessionId) {
      throw new KaraokeServiceError('item_session_mismatch', 'Item is not in this session.');
    }
    return item;
  }

  private async publishToRoom(sessionId: string, event: SessionEvent): Promise<void> {
    const room = this.deps.rooms?.forSession(sessionId);
    if (room) await room.publish(event);
  }
}

function sessionToDomain(record: SessionRecord): Session {
  return {
    id: record.id,
    accountId: record.accountId,
    name: record.name,
    qrSlug: record.qrSlug,
    guestCapOverride: record.guestCapOverride,
    songsPerGuestCap: record.songsPerGuestCap,
    maxConsecutivePerGuest: record.maxConsecutivePerGuest ?? null,
    allowDuplicates: record.allowDuplicates ?? false,
    moderationEnabled: record.moderationEnabled,
    voteSkipMode: record.voteSkipMode,
    voteSkipThreshold: record.voteSkipThreshold,
    karaokeMode: record.karaokeMode,
    karaokeMicCount: record.karaokeMicCount,
    karaokePauseMode: record.karaokePauseMode,
    karaokePauseTimeoutSec: record.karaokePauseTimeoutSec,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
  };
}

function itemToDomain(record: QueueItemRecord): QueueItem {
  return {
    id: record.id,
    sessionId: record.sessionId,
    guestId: record.guestId,
    trackUri: record.trackUri,
    trackName: record.trackName,
    artistName: record.artistName,
    albumArtUrl: record.albumArtUrl,
    durationMs: record.durationMs,
    status: record.status,
    skipVotes: record.skipVotes,
    createdAt: record.createdAt,
    decidedAt: record.decidedAt,
  };
}

function claimToDomain(record: KaraokeClaimRecord): KaraokeClaim {
  return {
    id: record.id,
    sessionId: record.sessionId,
    queueItemId: record.queueItemId,
    guestId: record.guestId,
    displayName: record.displayName,
    createdAt: record.createdAt,
  };
}
