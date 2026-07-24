/**
 * KaraokeService — guest mic claims on queue items, plus the karaoke
 * spotlight + pause/resume state machine (spec §4).
 *
 * Domain rules from `@opendj/core`:
 * - `canClaimMic` for the gate (karaoke on? item claimable? mics free?
 *   guest not already on it?)
 * - `canRemoveClaim` for guest self-removal (own claim, item still waiting)
 *
 * Mirrors QueueService: resolve slot → guest → session, run the pure rule,
 * persist, broadcast to the realtime room, best-effort audit. Host removal
 * bypasses `canRemoveClaim` (spec: "host can remove any claim").
 *
 * Spotlight/pause state lives server-side, in-memory, per session — the
 * NowPlayingPoller drives it (`handleTrackChange` on track transitions,
 * `reconcilePlayback` every tick) and the guest pause/ready routes mutate
 * it. Every transition broadcasts a `karaoke.*` event so the room snapshot
 * stays the realtime source of truth; provider pause/resume calls are
 * best-effort (state still transitions + broadcasts when Spotify hiccups).
 */

import {
  canClaimMic,
  canRemoveClaim,
  supportsPause,
  supportsResume,
  type KaraokeClaim,
  type QueueItem,
  type Session,
} from '@opendj/core';
import {
  createEmptyKaraokeState,
  type KaraokeClaimSummary,
  type KaraokeSnapshotState,
  type RealtimeRoom,
  type SessionEvent,
} from '@opendj/realtime';
import type { StreamingRouter } from '../providers/streaming/StreamingRouter.js';
import type {
  GuestRepository,
  GuestSlotRepository,
  KaraokeClaimRecord,
  KaraokeClaimRepository,
  ProviderConnectionRepository,
  QueueItemRecord,
  QueueItemRepository,
  SessionRecord,
  SessionRepository,
} from '../repositories/types.js';
import {
  guestLabelFromFingerprint,
  type SessionAuditService,
} from '../session/SessionAuditService.js';
import { toKaraokeClaimSummary } from './claimSummaries.js';
import { sanitizeKaraokeDisplayName } from './displayName.js';

/** Queue item statuses eligible for the spotlight match (spec §4). */
const SPOTLIGHT_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'approved',
  'queued',
  'playing',
]);

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
  /**
   * Optional provider playback control (same wiring as QueueService).
   * When both are present, spotlight/pause transitions call the host's
   * connected provider (`pause`/`resume`) best-effort — a provider failure
   * never blocks the state transition or its broadcast.
   */
  streamingRouter?: StreamingRouter;
  providerConnections?: ProviderConnectionRepository;
  /** Injectable wall clock for pause deadlines. Defaults to Date.now. */
  nowEpochMs?: () => number;
}

export class KaraokeService {
  private readonly now: () => number;
  /** Per-session spotlight/pause state. In-memory by design (spec §8). */
  private readonly karaokeState = new Map<string, KaraokeSnapshotState>();

  constructor(private readonly deps: KaraokeServiceDeps) {
    this.now = deps.nowEpochMs ?? Date.now;
  }

  /** Current spotlight/pause state for a session. Diagnostic + tests. */
  getKaraokeState(sessionId: string): Readonly<KaraokeSnapshotState> {
    return this.karaokeState.get(sessionId) ?? createEmptyKaraokeState();
  }

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

  /**
   * Poller hook — the session's now-playing track changed (or stopped;
   * `trackUri: null`). Re-derives the karaoke spotlight per spec §4: the
   * EARLIEST (createdAt asc) queue item with status pending|approved|queued|
   * playing whose trackUri matches the playing track AND carries >=1 mic
   * claim. Broadcasts `karaoke.spotlight` only when the spotlight actually
   * changes; a fresh spotlight under `auto` pause mode also pauses playback
   * and broadcasts `karaoke.paused` with the auto-resume deadline.
   */
  async handleTrackChange(input: {
    sessionId: string;
    trackUri: string | null;
    nowEpochMs?: number;
  }): Promise<void> {
    const now = input.nowEpochMs ?? this.now();
    const state = this.stateFor(input.sessionId);

    let spotlightItemId: string | null = null;
    let claims: KaraokeClaimSummary[] = [];
    if (input.trackUri !== null) {
      const items = await this.deps.queueItems.findAllForSession(input.sessionId);
      const candidates = items
        .filter((i) => i.trackUri === input.trackUri && SPOTLIGHT_STATUSES.has(i.status))
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      for (const candidate of candidates) {
        const itemClaims = await this.deps.karaokeClaims.findAllForItem(candidate.id);
        if (itemClaims.length > 0) {
          spotlightItemId = candidate.id;
          claims = itemClaims.map(toKaraokeClaimSummary);
          break;
        }
      }
    }

    if (spotlightItemId === state.spotlightItemId) return; // no change — stay quiet

    state.spotlightItemId = spotlightItemId;
    // Any pause belonged to the previous spotlight — drop it silently (the
    // spotlight broadcast resets the pause slice in the reducer too).
    state.paused = false;
    state.pausedUntilEpochMs = null;
    await this.publishToRoom(input.sessionId, {
      type: 'karaoke.spotlight',
      itemId: spotlightItemId,
      claims,
    });

    if (spotlightItemId === null) return;

    const session = await this.deps.sessions.findById(input.sessionId);
    if (!session || session.karaokePauseMode !== 'auto') return;

    await this.callProvider(session, 'pause');
    state.paused = true;
    state.pausedUntilEpochMs = now + session.karaokePauseTimeoutSec * 1000;
    await this.publishToRoom(input.sessionId, {
      type: 'karaoke.paused',
      itemId: spotlightItemId,
      untilEpochMs: state.pausedUntilEpochMs,
    });
  }

  /**
   * Poller hook — every tick. Reconciles karaoke-pause state against the
   * provider's actual playback:
   * - paused but the provider reports playing → the host resumed out-of-band
   *   (existing playback controls): clear the pause + broadcast resumed.
   * - paused past the deadline → best-effort provider resume + clear +
   *   broadcast. Idempotent — a second tick past the deadline is a no-op
   *   because the state already cleared.
   */
  async reconcilePlayback(input: {
    sessionId: string;
    isPlaying: boolean;
    nowEpochMs?: number;
  }): Promise<void> {
    const state = this.karaokeState.get(input.sessionId);
    if (!state?.paused) return;
    const now = input.nowEpochMs ?? this.now();

    if (input.isPlaying) {
      await this.clearPauseAndBroadcast(input.sessionId, state);
      return;
    }
    if (state.pausedUntilEpochMs !== null && now > state.pausedUntilEpochMs) {
      const session = await this.deps.sessions.findById(input.sessionId);
      if (session) await this.callProvider(session, 'resume');
      await this.clearPauseAndBroadcast(input.sessionId, state);
    }
  }

  /**
   * Guest action: hold playback while grabbing the mic. Only a claimer of
   * the CURRENT spotlight item may pause, and only in `manual` pause mode.
   * Sets the auto-resume deadline `now + karaokePauseTimeoutSec`.
   */
  async pause(input: { sessionId: string; slotToken: string }): Promise<{ untilEpochMs: number }> {
    const { slot, session, guest } = await this.resolveGuest(input.sessionId, input.slotToken);
    const state = this.stateFor(input.sessionId);
    const spotlightItemId = await this.requireSpotlightClaim(state, guest.id);
    if (session.karaokePauseMode !== 'manual') {
      throw new KaraokeServiceError(
        'pause_disabled',
        `Guest pause requires karaokePauseMode "manual" (session is "${session.karaokePauseMode}").`,
      );
    }

    const untilEpochMs = this.now() + session.karaokePauseTimeoutSec * 1000;
    await this.callProvider(session, 'pause');
    state.paused = true;
    state.pausedUntilEpochMs = untilEpochMs;
    await this.publishToRoom(input.sessionId, {
      type: 'karaoke.paused',
      itemId: spotlightItemId,
      untilEpochMs,
    });

    void this.deps.audit?.record({
      sessionId: input.sessionId,
      actorKind: 'guest',
      actorId: guest.id,
      actorLabel: guestLabelFromFingerprint(slot.fingerprintHash),
      action: 'karaoke.paused',
      details: { itemId: spotlightItemId, untilEpochMs },
    });

    return { untilEpochMs };
  }

  /**
   * Guest action: "I'm ready" — resume playback. Any claimer of the
   * spotlight item may resume; requires an active karaoke pause.
   */
  async ready(input: { sessionId: string; slotToken: string }): Promise<void> {
    const { slot, session, guest } = await this.resolveGuest(input.sessionId, input.slotToken);
    const state = this.stateFor(input.sessionId);
    const spotlightItemId = await this.requireSpotlightClaim(state, guest.id);
    if (!state.paused) {
      throw new KaraokeServiceError('not_paused', 'Playback is not karaoke-paused.');
    }

    await this.callProvider(session, 'resume');
    await this.clearPauseAndBroadcast(input.sessionId, state);

    void this.deps.audit?.record({
      sessionId: input.sessionId,
      actorKind: 'guest',
      actorId: guest.id,
      actorLabel: guestLabelFromFingerprint(slot.fingerprintHash),
      action: 'karaoke.resumed',
      details: { itemId: spotlightItemId },
    });
  }

  private stateFor(sessionId: string): KaraokeSnapshotState {
    let state = this.karaokeState.get(sessionId);
    if (!state) {
      state = createEmptyKaraokeState();
      this.karaokeState.set(sessionId, state);
    }
    return state;
  }

  /**
   * Guard shared by pause/ready: the guest must hold a mic claim on the
   * CURRENT spotlight item. Returns the spotlight item id for convenience.
   */
  private async requireSpotlightClaim(
    state: KaraokeSnapshotState,
    guestId: string,
  ): Promise<string> {
    if (state.spotlightItemId === null) {
      throw new KaraokeServiceError('not_a_claimer', 'No karaoke spotlight is active.');
    }
    const claim = await this.deps.karaokeClaims.findByItemAndGuest(state.spotlightItemId, guestId);
    if (!claim) {
      throw new KaraokeServiceError(
        'not_a_claimer',
        'Guest holds no mic claim on the spotlight item.',
      );
    }
    return state.spotlightItemId;
  }

  /** Clear the pause slice and broadcast `karaoke.resumed` for the spotlight. */
  private async clearPauseAndBroadcast(
    sessionId: string,
    state: KaraokeSnapshotState,
  ): Promise<void> {
    const itemId = state.spotlightItemId;
    state.paused = false;
    state.pausedUntilEpochMs = null;
    if (itemId !== null) {
      await this.publishToRoom(sessionId, { type: 'karaoke.resumed', itemId });
    }
  }

  /**
   * Best-effort provider pause/resume via the session's connected provider
   * (same resolution as QueueService's skip calls). Failures log + return —
   * the karaoke state machine never depends on the provider call landing.
   */
  private async callProvider(session: SessionRecord, action: 'pause' | 'resume'): Promise<void> {
    if (!this.deps.streamingRouter || !this.deps.providerConnections) return;
    try {
      const conns = await this.deps.providerConnections.findAllForAccount(session.accountId);
      const conn = conns[0];
      if (!conn) return;
      const provider = await this.deps.streamingRouter.getProvider(
        session.accountId,
        conn.providerId,
      );
      if (action === 'pause') {
        if (supportsPause(provider)) await provider.pause();
      } else if (supportsResume(provider)) {
        await provider.resume();
      }
    } catch (err) {
      console.warn(`[KaraokeService] provider ${action} failed: ${(err as Error).message}`);
    }
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
