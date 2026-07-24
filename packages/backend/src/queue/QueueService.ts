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
  supportsSkipTrack,
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
import {
  guestLabelFromFingerprint,
  type SessionAuditService,
} from '../session/SessionAuditService.js';

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
  /**
   * Optional. When wired, every mutation funnels into the host-facing
   * audit log so the host can review who did what later. Best-effort —
   * failures don't block the user-facing action.
   */
  audit?: SessionAuditService;
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
      input.track.uri,
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

    void this.deps.audit?.record({
      sessionId: input.sessionId,
      actorKind: 'guest',
      actorId: guest.id,
      actorLabel: guestLabelFromFingerprint(slot.fingerprintHash),
      action: 'queue.requested',
      details: {
        itemId: created.id,
        trackUri: input.track.uri,
        trackName: input.track.name,
        artistName: input.track.artist,
        moderation: session.moderationEnabled ? 'pending' : 'auto_approved',
      },
    });

    return created;
  }

  /** Host action: approve or reject a pending item. */
  async moderate(
    input: {
      itemId: string;
      decision: 'approved' | 'rejected';
      sessionId: string;
      actor?: { userId: string; label?: string };
    },
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

    void this.deps.audit?.record({
      sessionId: input.sessionId,
      actorKind: 'host',
      actorId: input.actor?.userId ?? null,
      actorLabel: input.actor?.label ?? 'Host',
      action: input.decision === 'approved' ? 'queue.approved' : 'queue.rejected',
      details: {
        itemId: input.itemId,
        trackUri: updated.trackUri,
        trackName: updated.trackName,
      },
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
    } else {
      // Decision was 'rejected' — if the rejected URI is the currently-
      // playing track, best-effort skip immediately rather than waiting
      // for the next NowPlayingPoller tick. The reconcile pass would
      // catch it within ~5s but that delay reads as "Remove didn't
      // work" to the host clicking the button.
      const room = this.deps.rooms?.forSession(input.sessionId);
      const nowPlaying = room ? (await room.getSnapshot()).nowPlaying : null;
      if (
        nowPlaying &&
        updated.trackUri === nowPlaying.uri &&
        this.deps.streamingRouter &&
        this.deps.providerConnections
      ) {
        const session = await this.deps.sessions.findById(input.sessionId);
        if (session) {
          try {
            const conns = await this.deps.providerConnections.findAllForAccount(session.accountId);
            const conn = conns[0];
            if (conn) {
              const provider = await this.deps.streamingRouter.getProvider(
                session.accountId,
                conn.providerId,
              );
              if (supportsSkipTrack(provider)) {
                await provider.skipTrack();
              }
            }
          } catch (err) {
            console.warn(
              `[QueueService] moderate(rejected) skip-on-current failed: ${(err as Error).message}`,
            );
          }
        }
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
    void this.deps.audit?.record({
      sessionId: input.sessionId,
      actorKind: 'guest',
      actorId: guest.id,
      actorLabel: guestLabelFromFingerprint(slot.fingerprintHash),
      action: 'queue.removed',
      details: {
        itemId: input.itemId,
        trackUri: item.trackUri,
        trackName: item.trackName,
      },
    });
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

    void this.deps.audit?.record({
      sessionId: input.sessionId,
      actorKind: 'guest',
      actorId: guest.id,
      actorLabel: guestLabelFromFingerprint(slot.fingerprintHash),
      action: 'skip_vote.cast',
      details: {
        itemId: input.itemId,
        trackUri: item.trackUri,
        trackName: item.trackName,
        votes,
        threshold: session.voteSkipThreshold,
      },
    });

    // Auto-reject when the threshold is crossed (fixed/percentage modes).
    // host_approval defers — host has to approve the skip via moderation.
    if (
      thresholdReached &&
      (session.voteSkipMode === 'fixed' || session.voteSkipMode === 'percentage')
    ) {
      const updated = await this.deps.queueItems.setStatus({
        id: input.itemId,
        status: 'rejected',
        decidedAt: new Date(Date.now()),
      });
      if (updated) {
        await this.publishToRoom(input.sessionId, {
          type: 'queue.item_rejected',
          itemId: input.itemId,
        });
        void this.deps.audit?.record({
          sessionId: input.sessionId,
          actorKind: 'system',
          action: 'skip_vote.threshold_reached',
          details: {
            itemId: input.itemId,
            trackUri: item.trackUri,
            trackName: item.trackName,
            votes,
            threshold: session.voteSkipThreshold,
          },
        });
      }
      // Best-effort: if the rejected track is the one currently playing,
      // call provider.skipTrack() so guests don't have to listen to it
      // play out.
      const room = this.deps.rooms?.forSession(input.sessionId);
      const nowPlaying = room ? (await room.getSnapshot()).nowPlaying : null;
      if (
        nowPlaying &&
        item.trackUri === nowPlaying.uri &&
        this.deps.streamingRouter &&
        this.deps.providerConnections
      ) {
        try {
          const conns = await this.deps.providerConnections.findAllForAccount(session.accountId);
          const conn = conns[0];
          if (conn) {
            const provider = await this.deps.streamingRouter.getProvider(
              session.accountId,
              conn.providerId,
            );
            if (supportsSkipTrack(provider)) {
              await provider.skipTrack();
            }
          }
        } catch (err) {
          console.warn(`[QueueService] skip-on-vote-threshold failed: ${(err as Error).message}`);
        }
      }
    }

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

  /**
   * Per-process in-memory skip-vote tally for the currently-playing
   * track. Keyed by sessionId; voters are guest ids. Reset whenever the
   * trackUri changes since the cached value.
   *
   * Lives on QueueService because it's tied to QueueService's lifecycle
   * + ergonomic re-use of slot/guest resolution. Hosted deploys
   * eventually persist this for cross-instance dedup; OSS demo trades
   * that for simplicity since vote-to-skip is per-session-instant only.
   */
  private readonly nowPlayingVotes = new Map<string, { trackUri: string; voters: Set<string> }>();

  /**
   * Guest action: cast a skip-vote against whatever's currently playing.
   * Returns the new aggregate count + threshold + a flag the caller can
   * use for "skipped by votes" UX. When `thresholdReached` flips true the
   * server has already (best-effort) called `provider.skipTrack()` and
   * fired a `now_playing_skip_vote.updated` event with count >= threshold.
   */
  async castNowPlayingSkipVote(input: { sessionId: string; slotToken: string }): Promise<{
    count: number;
    threshold: number;
    thresholdReached: boolean;
    trackUri: string;
  }> {
    const slot = await this.deps.guestSlots.findBySlotToken(input.slotToken);
    if (!slot) throw new QueueServiceError('unknown_slot_token', 'Unknown slot token.');
    if (slot.sessionId !== input.sessionId) {
      throw new QueueServiceError('slot_session_mismatch', 'Slot does not belong to this session.');
    }

    const session = await this.deps.sessions.findById(input.sessionId);
    if (!session) throw new QueueServiceError('session_not_found', 'Unknown session.');

    const room = this.deps.rooms?.forSession(input.sessionId);
    if (!room) {
      throw new QueueServiceError('no_room', 'Realtime room not materialized.');
    }
    const snapshot = await room.getSnapshot();
    const nowPlaying = snapshot.nowPlaying;
    if (!nowPlaying) {
      throw new QueueServiceError('no_track_playing', 'Nothing is playing right now.');
    }

    const guest = await this.deps.guests.findBySessionAndFingerprint(
      input.sessionId,
      slot.fingerprintHash,
    );
    if (!guest) throw new QueueServiceError('guest_not_found', 'No guest row for this slot.');

    // Bucket per-track. A new track URI invalidates prior votes.
    let bucket = this.nowPlayingVotes.get(input.sessionId);
    if (!bucket || bucket.trackUri !== nowPlaying.uri) {
      bucket = { trackUri: nowPlaying.uri, voters: new Set() };
      this.nowPlayingVotes.set(input.sessionId, bucket);
    }
    if (bucket.voters.has(guest.id)) {
      throw new QueueServiceError(
        'already_voted',
        'This guest has already voted to skip the current track.',
      );
    }
    bucket.voters.add(guest.id);

    const count = bucket.voters.size;
    const threshold = session.voteSkipThreshold;
    const thresholdReached = count >= threshold;

    await this.publishToRoom(input.sessionId, {
      type: 'now_playing_skip_vote.updated',
      trackUri: nowPlaying.uri,
      count,
      threshold,
    });

    void this.deps.audit?.record({
      sessionId: input.sessionId,
      actorKind: 'guest',
      actorId: guest.id,
      actorLabel: guestLabelFromFingerprint(slot.fingerprintHash),
      action: 'skip_vote.now_playing_cast',
      details: {
        trackUri: nowPlaying.uri,
        trackName: nowPlaying.name,
        count,
        threshold,
      },
    });

    if (thresholdReached) {
      // Best-effort: call provider.skipTrack. The next now-playing tick
      // will broadcast the new track + the snapshot's
      // nowPlayingSkipVote will reset to null via applyEvent.
      try {
        if (this.deps.streamingRouter && this.deps.providerConnections) {
          const conns = await this.deps.providerConnections.findAllForAccount(session.accountId);
          const conn = conns[0];
          if (conn) {
            const provider = await this.deps.streamingRouter.getProvider(
              session.accountId,
              conn.providerId,
            );
            if (supportsSkipTrack(provider)) {
              await provider.skipTrack();
            }
          }
        }
      } catch (err) {
        console.warn(`[QueueService] skip-on-threshold failed: ${(err as Error).message}`);
      }
      // Clear the bucket so the next track starts at zero — the new
      // now_playing.updated will reset the snapshot field via applyEvent.
      this.nowPlayingVotes.delete(input.sessionId);
      void this.deps.audit?.record({
        sessionId: input.sessionId,
        actorKind: 'system',
        action: 'skip_vote.threshold_reached',
        details: {
          trackUri: nowPlaying.uri,
          trackName: nowPlaying.name,
          count,
          threshold,
          target: 'now_playing',
        },
      });
    }

    return { count, threshold, thresholdReached, trackUri: nowPlaying.uri };
  }

  /**
   * Per-process in-memory skip-vote tally for provider-queue tracks that
   * have no OpenDJ counterpart (host added them directly via Spotify,
   * playlist context, etc.). Keyed by sessionId → trackUri → voter
   * guestIds. Mirrors {@link nowPlayingVotes} but indexed per-URI.
   */
  private readonly providerQueueVotes = new Map<string, Map<string, Set<string>>>();
  /**
   * URIs that crossed the skip-vote threshold but haven't yet been
   * skipped (because they aren't currently playing). Consumed by the
   * NowPlayingPoller — when it sees one of these reach the now-playing
   * slot it calls `provider.skipTrack()` and removes the URI.
   */
  private readonly rejectedProviderUris = new Map<string, Set<string>>();

  /**
   * Host action: reject a provider-queue track that has no OpenDJ
   * counterpart. Adds the URI to {@link rejectedProviderUris} so the
   * NowPlayingPoller skips it when it reaches the now-playing slot, and
   * best-effort calls `provider.skipTrack()` immediately if it's the
   * current track. No vote ledger — bypasses the threshold entirely.
   */
  async hostRejectProviderTrack(input: {
    sessionId: string;
    trackUri: string;
    actor?: { userId: string; label?: string };
  }): Promise<{ skippedNow: boolean }> {
    const session = await this.deps.sessions.findById(input.sessionId);
    if (!session) throw new QueueServiceError('session_not_found', 'Unknown session.');

    const room = this.deps.rooms?.forSession(input.sessionId);
    if (!room) throw new QueueServiceError('no_room', 'Realtime room not materialized.');
    const snapshot = await room.getSnapshot();
    const inProviderQueue = snapshot.providerQueue.some((t) => t.uri === input.trackUri);
    const isNowPlaying = snapshot.nowPlaying?.uri === input.trackUri;
    if (!inProviderQueue && !isNowPlaying) {
      throw new QueueServiceError(
        'track_not_in_queue',
        'That track is not in the provider queue right now.',
      );
    }

    let rejected = this.rejectedProviderUris.get(input.sessionId);
    if (!rejected) {
      rejected = new Set();
      this.rejectedProviderUris.set(input.sessionId, rejected);
    }
    rejected.add(input.trackUri);

    let skippedNow = false;
    if (isNowPlaying && this.deps.streamingRouter && this.deps.providerConnections) {
      try {
        const conns = await this.deps.providerConnections.findAllForAccount(session.accountId);
        const conn = conns[0];
        if (conn) {
          const provider = await this.deps.streamingRouter.getProvider(
            session.accountId,
            conn.providerId,
          );
          if (supportsSkipTrack(provider)) {
            await provider.skipTrack();
            this.consumeProviderRejection(input.sessionId, input.trackUri);
            skippedNow = true;
          }
        }
      } catch (err) {
        console.warn(
          `[QueueService] hostRejectProviderTrack skip-on-now-playing failed: ${(err as Error).message}`,
        );
      }
    }
    // Drop any in-flight vote tally for this URI — host action overrides.
    this.providerQueueVotes.get(input.sessionId)?.delete(input.trackUri);

    void this.deps.audit?.record({
      sessionId: input.sessionId,
      actorKind: 'host',
      actorId: input.actor?.userId ?? null,
      actorLabel: input.actor?.label ?? 'Host',
      action: 'queue.host_provider_rejected',
      details: {
        trackUri: input.trackUri,
        trackName: snapshot.providerQueue.find((t) => t.uri === input.trackUri)?.name ?? null,
        skippedNow,
      },
    });

    return { skippedNow };
  }

  /**
   * Diagnostic / NowPlayingPoller hook. Returns the live rejected-URI
   * set for `sessionId`, or an empty set if none. Caller should treat
   * the set as read-only — mutations belong to {@link consumeProviderRejection}.
   */
  getRejectedProviderUris(sessionId: string): ReadonlySet<string> {
    return this.rejectedProviderUris.get(sessionId) ?? new Set();
  }

  /**
   * Pop a rejected URI for `sessionId`, returning true iff it was
   * present. Used by the NowPlayingPoller after it successfully calls
   * `provider.skipTrack()`.
   */
  consumeProviderRejection(sessionId: string, trackUri: string): boolean {
    const set = this.rejectedProviderUris.get(sessionId);
    if (!set) return false;
    const had = set.delete(trackUri);
    if (set.size === 0) this.rejectedProviderUris.delete(sessionId);
    return had;
  }

  /**
   * Guest action: cast a skip-vote against a provider-queue track that
   * doesn't have an OpenDJ queue_item (so {@link castSkipVote} can't
   * apply). Threshold semantics match — fixed/percentage modes auto-
   * reject + best-effort `provider.skipTrack` if currently playing,
   * otherwise the URI joins {@link rejectedProviderUris} and the
   * NowPlayingPoller skips it when it eventually reaches the slot.
   */
  async castProviderQueueSkipVote(input: {
    sessionId: string;
    slotToken: string;
    trackUri: string;
  }): Promise<{ count: number; threshold: number; thresholdReached: boolean }> {
    const slot = await this.deps.guestSlots.findBySlotToken(input.slotToken);
    if (!slot) throw new QueueServiceError('unknown_slot_token', 'Unknown slot token.');
    if (slot.sessionId !== input.sessionId) {
      throw new QueueServiceError('slot_session_mismatch', 'Slot does not belong to this session.');
    }

    const session = await this.deps.sessions.findById(input.sessionId);
    if (!session) throw new QueueServiceError('session_not_found', 'Unknown session.');

    const room = this.deps.rooms?.forSession(input.sessionId);
    if (!room) throw new QueueServiceError('no_room', 'Realtime room not materialized.');
    const snapshot = await room.getSnapshot();
    const inProviderQueue = snapshot.providerQueue.some((t) => t.uri === input.trackUri);
    const isNowPlaying = snapshot.nowPlaying?.uri === input.trackUri;
    if (!inProviderQueue && !isNowPlaying) {
      throw new QueueServiceError(
        'track_not_in_queue',
        'That track is not in the provider queue right now.',
      );
    }

    const guest = await this.deps.guests.findBySessionAndFingerprint(
      input.sessionId,
      slot.fingerprintHash,
    );
    if (!guest) throw new QueueServiceError('guest_not_found', 'No guest row for this slot.');

    let perSession = this.providerQueueVotes.get(input.sessionId);
    if (!perSession) {
      perSession = new Map();
      this.providerQueueVotes.set(input.sessionId, perSession);
    }
    let voters = perSession.get(input.trackUri);
    if (!voters) {
      voters = new Set();
      perSession.set(input.trackUri, voters);
    }
    if (voters.has(guest.id)) {
      throw new QueueServiceError(
        'already_voted',
        'This guest has already voted to skip this track.',
      );
    }
    voters.add(guest.id);

    const count = voters.size;
    const threshold = session.voteSkipThreshold;
    const thresholdReached = count >= threshold;

    await this.publishToRoom(input.sessionId, {
      type: 'provider_queue_skip_vote.updated',
      trackUri: input.trackUri,
      count,
      threshold,
    });

    void this.deps.audit?.record({
      sessionId: input.sessionId,
      actorKind: 'guest',
      actorId: guest.id,
      actorLabel: guestLabelFromFingerprint(slot.fingerprintHash),
      action: 'skip_vote.provider_track_cast',
      details: {
        trackUri: input.trackUri,
        trackName: snapshot.providerQueue.find((t) => t.uri === input.trackUri)?.name ?? null,
        count,
        threshold,
      },
    });

    if (
      thresholdReached &&
      (session.voteSkipMode === 'fixed' || session.voteSkipMode === 'percentage')
    ) {
      // Stash for poller pickup, even if we attempt the immediate skip.
      let rejected = this.rejectedProviderUris.get(input.sessionId);
      if (!rejected) {
        rejected = new Set();
        this.rejectedProviderUris.set(input.sessionId, rejected);
      }
      rejected.add(input.trackUri);

      if (isNowPlaying && this.deps.streamingRouter && this.deps.providerConnections) {
        try {
          const conns = await this.deps.providerConnections.findAllForAccount(session.accountId);
          const conn = conns[0];
          if (conn) {
            const provider = await this.deps.streamingRouter.getProvider(
              session.accountId,
              conn.providerId,
            );
            if (supportsSkipTrack(provider)) {
              await provider.skipTrack();
              // Successful immediate skip — no need for the poller to do it.
              this.consumeProviderRejection(input.sessionId, input.trackUri);
            }
          }
        } catch (err) {
          console.warn(
            `[QueueService] provider-queue skip-on-threshold failed: ${(err as Error).message}`,
          );
        }
      }
      // Drop the per-URI bucket so the same URI re-queued later starts fresh.
      perSession.delete(input.trackUri);
      if (perSession.size === 0) this.providerQueueVotes.delete(input.sessionId);
      void this.deps.audit?.record({
        sessionId: input.sessionId,
        actorKind: 'system',
        action: 'skip_vote.threshold_reached',
        details: {
          trackUri: input.trackUri,
          trackName: snapshot.providerQueue.find((t) => t.uri === input.trackUri)?.name ?? null,
          count,
          threshold,
          target: 'provider_track',
        },
      });
    }

    return { count, threshold, thresholdReached };
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
      console.warn('[QueueService] pushToProviderQueue skipped: streaming router not wired');
      return;
    }
    const conns = await this.deps.providerConnections.findAllForAccount(accountId);
    const conn = conns[0];
    if (!conn) {
      console.warn(
        `[QueueService] pushToProviderQueue skipped: no provider connection for account ${accountId}`,
      );
      return;
    }
    try {
      const provider = await this.deps.streamingRouter.getProvider(accountId, conn.providerId);
      if (!supportsQueueTrack(provider)) {
        console.warn(
          `[QueueService] pushToProviderQueue skipped: provider ${conn.providerId} does not support queueTrack`,
        );
        return;
      }
      await provider.queueTrack(track);

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
  maxConsecutivePerGuest?: number | null;
  allowDuplicates?: boolean;
  moderationEnabled: boolean;
  voteSkipMode: 'fixed' | 'percentage' | 'host_approval';
  voteSkipThreshold: number;
  karaokeMode: 'off' | 'optional' | 'required';
  karaokeMicCount: number;
  karaokePauseMode: 'off' | 'manual' | 'auto';
  karaokePauseTimeoutSec: number;
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
