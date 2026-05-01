/**
 * QueueService — guest request, host moderation, and skip votes.
 *
 * Domain rules from `@opendj/core`:
 * - `canEnqueue` for the gate (session live? guest matches? cap not hit?)
 * - `applyModerationDecision` for the pure approve/reject transform
 * - `canSkip` for the threshold check (used by the route after each vote)
 *
 * The service is responsible for persisting state changes and handing the
 * resulting `SessionEvent` to a `RealtimeRoom` if one is provided. Routes
 * decide whether to surface the event ("submitted for review" vs "now playing").
 */

import {
  applyModerationDecision,
  canEnqueue,
  type CanEnqueueResult,
  type Guest,
  type QueueItem,
  type Session,
  type Track,
} from '@opendj/core';
import { toQueueItemSummary, type RealtimeRoom, type SessionEvent } from '@opendj/realtime';
import type {
  GuestRepository,
  GuestSlotRepository,
  QueueItemRecord,
  QueueItemRepository,
  SessionRepository,
} from '../repositories/types.js';

export class QueueServiceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'QueueServiceError';
    this.code = code;
  }
}

export interface QueueServiceDeps {
  sessions: SessionRepository;
  guests: GuestRepository;
  guestSlots: GuestSlotRepository;
  queueItems: QueueItemRepository;
  /** Optional room — when provided, mutations broadcast events. */
  rooms?: RealtimeRoomRegistry;
}

export interface RealtimeRoomRegistry {
  /** Return the room for a session, or null if none is currently bound. */
  forSession(sessionId: string): RealtimeRoom | null;
}

export interface RequestTrackInput {
  sessionId: string;
  /** Slot token from the guest's session — looked up to find the guest row. */
  slotToken: string;
  track: Track;
}

function recordToDomain(record: QueueItemRecord): QueueItem {
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

export class QueueService {
  constructor(private readonly deps: QueueServiceDeps) {}

  /**
   * Guest action: request a track.
   *
   * Flow: resolve slot → guest → session → load existing items → run canEnqueue →
   * insert with `pending` (when moderationEnabled) or `approved` → broadcast.
   */
  async requestTrack(input: RequestTrackInput, nowEpochMs?: number): Promise<QueueItemRecord> {
    const now = nowEpochMs ?? Date.now();
    const slot = await this.deps.guestSlots.findBySlotToken(input.slotToken);
    if (!slot) throw new QueueServiceError('unknown_slot_token', 'Unknown slot token.');
    if (slot.sessionId !== input.sessionId) {
      throw new QueueServiceError('slot_session_mismatch', 'Slot does not belong to this session.');
    }
    if (slot.status !== 'active') {
      throw new QueueServiceError('slot_not_active', `Slot status is "${slot.status}".`);
    }

    const session = await this.deps.sessions.findById(input.sessionId);
    if (!session) throw new QueueServiceError('session_not_found', 'Unknown session.');

    const guest = await this.deps.guests.findBySessionAndFingerprint(
      input.sessionId,
      slot.fingerprintHash,
    );
    if (!guest) {
      throw new QueueServiceError('guest_not_found', 'No guest row for this slot fingerprint.');
    }

    const existingRecords = await this.deps.queueItems.findAllForSession(input.sessionId);
    const existing = existingRecords.map(recordToDomain);
    const decision: CanEnqueueResult = canEnqueue(
      sessionToDomain(session),
      guestToDomain(guest),
      existing,
      new Date(now),
    );
    if (!decision.ok) {
      throw new QueueServiceError(decision.reason, `canEnqueue rejected: ${decision.reason}`);
    }

    const initialStatus = session.moderationEnabled ? 'pending' : 'approved';
    const created = await this.deps.queueItems.create({
      sessionId: input.sessionId,
      guestId: guest.id,
      trackUri: input.track.uri,
      trackName: input.track.name,
      artistName: input.track.artist,
      albumArtUrl: input.track.albumArt,
      durationMs: input.track.durationMs,
      status: initialStatus,
    });

    await this.publishToRoom(input.sessionId, {
      type: 'queue.item_requested',
      item: toQueueItemSummary(recordToDomain(created)),
    });
    if (initialStatus === 'approved') {
      await this.publishToRoom(input.sessionId, {
        type: 'queue.item_approved',
        itemId: created.id,
      });
    }

    return created;
  }

  /** Host action: approve or reject a pending item. */
  async moderate(
    input: { itemId: string; decision: 'approved' | 'rejected'; sessionId: string },
    nowEpochMs?: number,
  ): Promise<QueueItemRecord> {
    const now = nowEpochMs ?? Date.now();
    const item = await this.deps.queueItems.findById(input.itemId);
    if (!item) throw new QueueServiceError('item_not_found', 'Unknown queue item.');
    if (item.sessionId !== input.sessionId) {
      throw new QueueServiceError('item_session_mismatch', 'Item is not in this session.');
    }
    const updatedDomain = applyModerationDecision(
      recordToDomain(item),
      input.decision,
      new Date(now),
    );
    const updated = await this.deps.queueItems.setStatus({
      id: input.itemId,
      status: updatedDomain.status,
      decidedAt: updatedDomain.decidedAt,
    });
    if (!updated) throw new QueueServiceError('item_not_found', 'Item disappeared mid-update.');

    await this.publishToRoom(input.sessionId, {
      type: input.decision === 'approved' ? 'queue.item_approved' : 'queue.item_rejected',
      itemId: input.itemId,
    });
    return updated;
  }

  /** Guest action: remove their own pending item (only theirs, only pending/approved). */
  async removeOwn(input: { itemId: string; sessionId: string; slotToken: string }): Promise<void> {
    const slot = await this.deps.guestSlots.findBySlotToken(input.slotToken);
    if (!slot) throw new QueueServiceError('unknown_slot_token', 'Unknown slot token.');
    if (slot.sessionId !== input.sessionId) {
      throw new QueueServiceError('slot_session_mismatch', 'Slot does not belong to this session.');
    }

    const guest = await this.deps.guests.findBySessionAndFingerprint(
      input.sessionId,
      slot.fingerprintHash,
    );
    if (!guest) throw new QueueServiceError('guest_not_found', 'No guest for this slot.');

    const item = await this.deps.queueItems.findById(input.itemId);
    if (!item) throw new QueueServiceError('item_not_found', 'Unknown queue item.');
    if (item.sessionId !== input.sessionId) {
      throw new QueueServiceError('item_session_mismatch', 'Item is not in this session.');
    }
    if (item.guestId !== guest.id) {
      throw new QueueServiceError('not_owner', 'Guests can only remove their own items.');
    }
    if (item.status === 'playing') {
      throw new QueueServiceError(
        'item_playing',
        'Cannot remove a track that is currently playing.',
      );
    }
    await this.deps.queueItems.delete(input.itemId);
    await this.publishToRoom(input.sessionId, { type: 'queue.item_removed', itemId: input.itemId });
  }

  /**
   * Guest action: cast a skip vote. Returns the new vote count + threshold.
   *
   * v1 dedupe: in-memory `Set<itemId>` per QueueService instance — stops a
   * single guest from voting twice within a single backend process. Hosted
   * deployments will replace this with a `skip_votes` table for cross-instance
   * dedupe.
   */
  private readonly castedVotes = new Set<string>();

  async castSkipVote(input: {
    itemId: string;
    sessionId: string;
    slotToken: string;
  }): Promise<{ votes: number; threshold: number; voteSkipMode: Session['voteSkipMode'] }> {
    const slot = await this.deps.guestSlots.findBySlotToken(input.slotToken);
    if (!slot) throw new QueueServiceError('unknown_slot_token', 'Unknown slot token.');
    if (slot.sessionId !== input.sessionId) {
      throw new QueueServiceError('slot_session_mismatch', 'Slot does not belong to this session.');
    }

    const session = await this.deps.sessions.findById(input.sessionId);
    if (!session) throw new QueueServiceError('session_not_found', 'Unknown session.');

    const item = await this.deps.queueItems.findById(input.itemId);
    if (!item) throw new QueueServiceError('item_not_found', 'Unknown queue item.');
    if (item.sessionId !== input.sessionId) {
      throw new QueueServiceError('item_session_mismatch', 'Item is not in this session.');
    }

    const dedupeKey = `${input.itemId}:${slot.id}`;
    if (this.castedVotes.has(dedupeKey)) {
      throw new QueueServiceError(
        'already_voted',
        'This slot has already voted to skip this item.',
      );
    }
    this.castedVotes.add(dedupeKey);

    const votes = await this.deps.queueItems.incrementSkipVotes(input.itemId);
    await this.publishToRoom(input.sessionId, {
      type: 'skip_vote.updated',
      itemId: input.itemId,
      votes,
      threshold: session.voteSkipThreshold,
    });
    return {
      votes,
      threshold: session.voteSkipThreshold,
      voteSkipMode: session.voteSkipMode,
    };
  }

  async listForSession(sessionId: string): Promise<QueueItemRecord[]> {
    return this.deps.queueItems.findAllForSession(sessionId);
  }

  private async publishToRoom(sessionId: string, event: SessionEvent): Promise<void> {
    const room = this.deps.rooms?.forSession(sessionId);
    if (room) await room.publish(event);
  }
}

function sessionToDomain(record: {
  id: string;
  accountId: string;
  name: string;
  qrSlug: string;
  guestCapOverride: number | null;
  songsPerGuestCap: number;
  moderationEnabled: boolean;
  voteSkipMode: 'fixed' | 'percentage' | 'host_approval';
  voteSkipThreshold: number;
  startedAt: Date;
  endedAt: Date | null;
}): Session {
  return {
    id: record.id,
    accountId: record.accountId,
    name: record.name,
    qrSlug: record.qrSlug,
    guestCapOverride: record.guestCapOverride,
    songsPerGuestCap: record.songsPerGuestCap,
    moderationEnabled: record.moderationEnabled,
    voteSkipMode: record.voteSkipMode,
    voteSkipThreshold: record.voteSkipThreshold,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
  };
}

function guestToDomain(record: {
  id: string;
  sessionId: string;
  userId: string | null;
  fingerprint: string;
  name: string | null;
  createdAt: Date;
}): Guest {
  return {
    id: record.id,
    sessionId: record.sessionId,
    userId: record.userId,
    fingerprint: record.fingerprint,
    name: record.name,
    createdAt: record.createdAt,
  };
}
