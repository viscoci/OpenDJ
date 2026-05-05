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
  supportsQueueTrack,
  type CanEnqueueResult,
  type Guest,
  type QueueItem,
  type Session,
  type Track,
} from '@opendj/core';
import { toQueueItemSummary, type RealtimeRoom, type SessionEvent } from '@opendj/realtime';
import type {
  ProviderConnectionRepository,
  GuestRepository,
  GuestSlotRepository,
  QueueItemRecord,
  QueueItemRepository,
  QueueSkipVoteRepository,
  SessionRepository,
} from '../repositories/types.js';
import type { StreamingRouter } from '../providers/streaming/StreamingRouter.js';

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
  /** Persistent (cross-instance) skip-vote dedupe + counter. */
  queueSkipVotes: QueueSkipVoteRepository;
  /** Optional room — when provided, mutations broadcast events. */
  rooms?: RealtimeRoomRegistry;
  /**
   * Optional streaming-provider integration. When supplied, approved queue
   * items get pushed into the host's actual playback queue (Spotify queue,
   * etc.) via `provider.queueTrack`. Without it the OpenDJ queue is just
   * a request log — Spotify doesn't see what guests asked for.
   */
  streamingRouter?: StreamingRouter;
  providerConnections?: ProviderConnectionRepository;
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
      await this.pushToProviderQueue(session.accountId, input.track);
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

    if (input.decision === 'approved') {
      // Mirror the approval onto the streaming provider's queue so Spotify
      // (or whatever else is connected) actually plays the track. Without
      // this the OpenDJ queue is just a request log — the host's player
      // never learns about the requests.
      const session = await this.deps.sessions.findById(input.sessionId);
      if (session) {
        await this.pushToProviderQueue(session.accountId, {
          uri: updated.trackUri,
          name: updated.trackName,
          artist: updated.artistName,
          albumArt: updated.albumArtUrl,
          durationMs: updated.durationMs ?? 0,
        });
      }
    }
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
   * Dedupe + counter live in `queue_skip_votes` (composite PK on
   * (queue_item_id, guest_id)) so a guest's second vote returns
   * `already_voted` whether or not it lands on the same backend instance.
   */
  async castSkipVote(input: { itemId: string; sessionId: string; slotToken: string }): Promise<{
    votes: number;
    threshold: number;
    voteSkipMode: Session['voteSkipMode'];
    thresholdReached: boolean;
  }> {
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

    const guest = await this.deps.guests.findBySessionAndFingerprint(
      input.sessionId,
      slot.fingerprintHash,
    );
    if (!guest) throw new QueueServiceError('guest_not_found', 'No guest row for this slot.');

    const result = await this.deps.queueSkipVotes.recordVote({
      queueItemId: input.itemId,
      guestId: guest.id,
    });
    if (!result.inserted) {
      throw new QueueServiceError(
        'already_voted',
        'This guest has already voted to skip this item.',
      );
    }

    const votes = result.voteCount;
    const thresholdReached = votes >= session.voteSkipThreshold;

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
      thresholdReached,
    };
  }

  async listForSession(sessionId: string): Promise<QueueItemRecord[]> {
    return this.deps.queueItems.findAllForSession(sessionId);
  }

  private async publishToRoom(sessionId: string, event: SessionEvent): Promise<void> {
    const room = this.deps.rooms?.forSession(sessionId);
    if (room) await room.publish(event);
  }

  /**
   * Push a track into the host's connected streaming-provider queue (e.g.
   * Spotify queue) when the integration is wired. Failure is non-fatal —
   * the OpenDJ queue item already exists, the host can still see it, and
   * the next NowPlayingPoller tick will reconcile.
   */
  private async pushToProviderQueue(accountId: string, track: Track): Promise<void> {
    if (!this.deps.streamingRouter || !this.deps.providerConnections) {
      // eslint-disable-next-line no-console
      console.warn('[QueueService] pushToProviderQueue skipped: streaming router not wired');
      return;
    }
    const conns = await this.deps.providerConnections.findAllForAccount(accountId);
    const conn = conns[0];
    if (!conn) {
      // eslint-disable-next-line no-console
      console.warn(
        `[QueueService] pushToProviderQueue skipped: no provider connection for account ${accountId}`,
      );
      return;
    }
    try {
      const provider = await this.deps.streamingRouter.getProvider(accountId, conn.providerId);
      if (!supportsQueueTrack(provider)) {
        // eslint-disable-next-line no-console
        console.warn(
          `[QueueService] pushToProviderQueue skipped: provider ${conn.providerId} does not support queueTrack`,
        );
        return;
      }
      await provider.queueTrack(track);
      // eslint-disable-next-line no-console
      console.log(
        `[QueueService] pushed "${track.name}" to ${conn.providerId} queue for account ${accountId}`,
      );
    } catch (err) {
      // Swallow — host UI will still show the OpenDJ row, and the next
      // poller tick will reflect the truth on the provider side. Common
      // failures: NO_ACTIVE_DEVICE (host has no active Spotify Connect
      // target), 403 (free Spotify account — Connect API is Premium
      // only), 401 (token can't be refreshed).
      const e = err as Error & { status?: number; code?: string };
      // eslint-disable-next-line no-console
      console.warn(
        `[QueueService] pushToProviderQueue failed: ${e.message}${e.status ? ` [HTTP ${e.status}]` : ''}${e.code ? ` [${e.code}]` : ''}`,
      );
    }
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
