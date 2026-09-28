/**
 * Per-session "what's on Spotify right now" poller.
 *
 * The realtime room only fans out events that someone calls `publish` on.
 * Nothing in the app currently inspects the host's connected provider on a
 * cadence — so the `now_playing.updated` event type is defined and applied
 * to the snapshot, but never fires. This service fills that gap.
 *
 * Lifecycle:
 *   - `start(sessionId)` is called by the realtime WS route on the first
 *     subscriber. Idempotent. Cancels a pending teardown if one is queued.
 *   - `stop(sessionId)` is called when the last subscriber leaves. Schedules
 *     a teardown after `idleGraceMs` so a guest reload doesn't thrash the
 *     timer. A subsequent `start` cancels the pending teardown.
 *   - `stopAll()` is called on `SIGINT` / `SIGTERM` so no detached timers
 *     keep the Node event loop alive.
 *
 * Per-tick behavior:
 *   1. Re-resolve the session (auto-stop if the host ended it).
 *   2. Cache `(accountId, providerId)` for the session so we don't re-query
 *      `sessions` + `provider_connections` every 5s.
 *   3. Resolve the provider via `StreamingRouter.getProvider`. If the host
 *      hasn't connected anything, return early — nothing to poll.
 *   4. Type-guard `ISupportsNowPlayingRead`; bail if the provider can't.
 *   5. Call `getNowPlaying()`. Compare against the room's current snapshot.
 *      Only publish on a meaningful diff (track URI changed, isPlaying
 *      flipped, or progressMs drifted past `driftThresholdMs`). This keeps
 *      the WS chatty enough for live progress sync but quiet enough that
 *      idle pages don't get flooded.
 *   6. Reschedule iff the room still has at least one subscriber.
 *
 * Errors:
 *   - `ProviderConnectionNotFoundError` / `InvalidProviderCredentialsError`
 *     → log once, stop polling this session. The host's next reconnect will
 *     trigger a fresh `start`.
 *   - 429 (Spotify rate limit, or the shared ProviderCooldowns refusing the
 *     call) → wait out the Retry-After window and publish
 *     `provider.status_updated` so clients can say Spotify is throttling us.
 *     The first successful tick afterwards publishes `{ state: 'ok' }`.
 *
 * Call budget: Spotify quotas are per app, so every tick counts. The
 * provider queue is re-read only when the track changes, every
 * `queueRefreshMs`, or while a fresh request is waiting to sync; and the
 * cadence drops to `idleIntervalMs` while nothing is playing.
 *   - Other errors → log + continue at the base interval.
 */

import {
  InvalidProviderCredentialsError,
  supportsNowPlayingRead,
  supportsQueueRead,
  supportsQueueTrack,
  supportsSkipTrack,
  type IStreamingProvider,
  type NowPlayingTrack,
  type Track,
} from '@opendj/core';
import type { LyricsDocument } from '@opendj/lyrics';
import type { ProviderStatus } from '@opendj/realtime';
import { createPlaybackClockSample } from '@opendj/sync';
import {
  ProviderConnectionNotFoundError,
  StreamingRouter,
} from '../providers/streaming/StreamingRouter.js';
import type { RealtimeRoomManager } from './RoomRegistryImpl.js';
import type {
  ProviderConnectionRepository,
  QueueItemRecord,
  QueueItemRepository,
  SessionRepository,
} from '../repositories/types.js';
import type { RateLimitedEvent } from '../providers/streaming/ProviderCooldowns.js';

export interface NowPlayingPollerDeps {
  sessions: SessionRepository;
  providerConnections: ProviderConnectionRepository;
  streamingRouter: StreamingRouter;
  roomManager: RealtimeRoomManager;
  /**
   * When supplied, the poller reconciles OpenDJ queue item status against
   * the provider's actual playback state each tick — items that have
   * rolled past the now-playing slot get marked `played` so they stop
   * counting against the per-guest cap. Optional for tests + Workers
   * deploys that don't materialize queue items.
   */
  queueItems?: QueueItemRepository;
  /**
   * Provider-queue skip-vote registry. When supplied, the poller calls
   * `provider.skipTrack()` whenever the now-playing URI has been voted
   * past threshold and consumes the rejection on success.
   */
  providerQueueRejections?: {
    getRejectedProviderUris(sessionId: string): ReadonlySet<string>;
    consumeProviderRejection(sessionId: string, trackUri: string): boolean;
  };
  /**
   * When supplied, the poller fires a cache-fronted lyrics lookup on every
   * track change and publishes `lyrics.loaded` (null lyrics on miss/failure).
   * Failures never affect playback or queue behavior.
   */
  lyricsLookup?: {
    lookup(input: {
      trackName: string;
      artistName: string;
      durationMs?: number | null;
      providerTrackUri?: string;
    }): Promise<LyricsDocument | null>;
  };
  /**
   * Karaoke spotlight + pause integration (KaraokeService). When supplied,
   * the poller reconciles pause state every tick (host-resume detection +
   * the auto-resume deadline) and re-derives the spotlight on track change
   * — same per-session bookkeeping shape as the lyrics lookup above.
   * Failures are logged and never affect playback polling.
   */
  karaoke?: {
    handleTrackChange(input: {
      sessionId: string;
      trackUri: string | null;
      nowEpochMs?: number;
    }): Promise<void>;
    reconcilePlayback(input: {
      sessionId: string;
      isPlaying: boolean;
      nowEpochMs?: number;
    }): Promise<void>;
  };
}

export interface NowPlayingPollerOptions {
  /** Base poll interval while a track is playing. Default 5000 ms. */
  intervalMs?: number;
  /**
   * Poll interval while nothing is playing (stopped or paused, outside a
   * karaoke hold). Default 15000 ms — a TV page left open overnight
   * shouldn't burn the Spotify quota.
   */
  idleIntervalMs?: number;
  /**
   * Re-read the provider queue at least this often while the track is
   * unchanged. Track changes and fresh requests force an earlier read.
   * Default 30000 ms.
   */
  queueRefreshMs?: number;
  /**
   * Don't republish a `now_playing.updated` for the SAME track unless server
   * progress drifted from local prediction by more than this. Default 4000 ms.
   * Prevents 720 events/hour for songs that just keep playing.
   */
  driftThresholdMs?: number;
  /** Hold the timer for this long after the last subscriber leaves. Default 30000 ms. */
  idleGraceMs?: number;
  /** Backoff cap when the provider returns 429. Default 60000 ms. */
  maxBackoffMs?: number;
  /** Injectable clock for tests. Default Date.now. */
  nowEpochMs?: () => number;
  /** Optional log sink. Defaults to `console`. */
  logger?: { warn(msg: string, meta?: unknown): void };
}

interface PerSession {
  /** Outstanding tick timer. */
  timer: ReturnType<typeof setTimeout> | null;
  /**
   * True while a tick body is executing. `tick()` nulls `timer` on entry,
   * so without this flag a `start()` call landing mid-tick (guest page
   * reload → WS resubscribe) would see "no timer" and schedule a SECOND
   * concurrent tick chain. Chains multiply poll rate and, worse, race the
   * auto-skip paths — parallel ticks each saw the same rejected track and
   * each dispatched a skip, eating innocent songs (observed live:
   * 3 skips for one URI within 155ms).
   */
  ticking: boolean;
  /**
   * Wall clock of the last auto-skip THIS session dispatched. Spotify
   * needs ~500ms to settle a skip and keeps reporting the old track
   * meanwhile — any tick in that window would re-match the rejected URI
   * and skip again. All auto-skip paths are suppressed within
   * `SKIP_SETTLE_MS` of the last dispatch.
   */
  lastSkipAtMs: number;
  /** Outstanding idle-grace teardown timer. */
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** Cached account + provider (avoid hammering repos every 5s). */
  cachedAccountId: string | null;
  cachedProviderId: string | null;
  /** Current backoff delay (only set after a 429). */
  backoffMs: number | null;
  /**
   * Per-item last-pushed-at-epoch-ms map. Reconcile uses it to throttle
   * retry pushes — Spotify's queue-read endpoint can lag the queue-write
   * by several seconds, so a freshly pushed track briefly looks
   * "unsynced" on the very next tick and naively retrying creates
   * duplicate Spotify entries.
   */
  lastPushedAt: Map<string, number>;
  /**
   * Provider URI of the track we last fired a lyrics lookup for. `null`
   * until the first lookup. Prevents re-looking-up the same track on
   * every tick while it's still playing.
   */
  lastLyricsUri: string | null;
  /**
   * Provider URI last handed to the karaoke spotlight detector (`null`
   * when playback was stopped). Spotlight re-derivation only runs when
   * this changes — the same track playing on doesn't re-query claims.
   */
  lastKaraokeUri: string | null;
  /** Wall clock of the last successful provider-queue read; null = never. */
  lastQueueReadAtMs: number | null;
  /** Now-playing URI at the last provider-queue read (change forces a re-read). */
  lastQueueTrackUri: string | null;
}

const SPOTIFY_PROVIDER_ID = 'spotify';

/**
 * Suppress further auto-skips for this long after dispatching one. Covers
 * Spotify's ~500ms skip-settle latency (during which it still reports the
 * old track) with comfortable slack; one poll interval later the reported
 * now-playing is trustworthy again.
 */
const SKIP_SETTLE_MS = 1500;

/**
 * Approved items younger than this are still "in flight" to the provider:
 * the retry pump may re-push them, and anything older gets a terminal
 * status from reconciliation.
 */
const RECONCILE_GRACE_MS = 30_000;

export class NowPlayingPoller {
  private readonly intervalMs: number;
  private readonly idleIntervalMs: number;
  private readonly queueRefreshMs: number;
  private readonly driftThresholdMs: number;
  private readonly idleGraceMs: number;
  private readonly maxBackoffMs: number;
  private readonly nowEpochMs: () => number;
  private readonly logger: { warn(msg: string, meta?: unknown): void };
  private readonly state = new Map<string, PerSession>();

  constructor(
    private readonly deps: NowPlayingPollerDeps,
    options: NowPlayingPollerOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? 5000;
    this.idleIntervalMs = options.idleIntervalMs ?? 15_000;
    this.queueRefreshMs = options.queueRefreshMs ?? 30_000;
    this.driftThresholdMs = options.driftThresholdMs ?? 4000;
    this.idleGraceMs = options.idleGraceMs ?? 30_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000;
    this.nowEpochMs = options.nowEpochMs ?? Date.now;
    this.logger = options.logger ?? console;
  }

  /**
   * Begin polling `sessionId`. Cancels a pending teardown if there is one.
   * If a tick is already scheduled the call is a no-op. Safe to spam from
   * every WS open event.
   */
  start(sessionId: string): void {
    let entry = this.state.get(sessionId);
    if (!entry) {
      entry = {
        timer: null,
        ticking: false,
        lastSkipAtMs: 0,
        idleTimer: null,
        cachedAccountId: null,
        cachedProviderId: null,
        backoffMs: null,
        lastPushedAt: new Map(),
        lastLyricsUri: null,
        lastKaraokeUri: null,
        lastQueueReadAtMs: null,
        lastQueueTrackUri: null,
      };
      this.state.set(sessionId, entry);
    }
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    // `ticking` matters as much as `timer`: a tick in flight has no timer
    // set, and scheduling here would fork a second concurrent tick chain.
    if (entry.timer || entry.ticking) return;
    this.scheduleNext(sessionId, 0);
  }

  /**
   * Schedule a teardown for `sessionId` after `idleGraceMs`. Idempotent: a
   * second call while one is queued doesn't bump the deadline. A `start`
   * call within the grace cancels the teardown.
   */
  stop(sessionId: string): void {
    const entry = this.state.get(sessionId);
    if (!entry) return;
    if (entry.idleTimer) return;
    entry.idleTimer = setTimeout(() => this.tearDown(sessionId), this.idleGraceMs);
  }

  /** Hard-stop every poller. Call on SIGTERM. */
  stopAll(): void {
    for (const sessionId of this.state.keys()) {
      this.tearDown(sessionId);
    }
  }

  /**
   * Fan a freshly opened provider cooldown out to every polled session on
   * that account, so clients learn about it immediately rather than on
   * their next tick. Wired to `ProviderCooldowns.onRateLimited`.
   */
  async notifyRateLimited(event: RateLimitedEvent): Promise<void> {
    const status: ProviderStatus = {
      state: 'rate_limited',
      providerId: event.providerId,
      untilEpochMs: event.untilEpochMs,
    };
    for (const [sessionId, entry] of this.state) {
      if (entry.cachedAccountId !== event.accountId) continue;
      if (entry.cachedProviderId !== event.providerId) continue;
      await this.publishStatus(sessionId, status);
    }
  }

  /** Number of sessions currently being polled. Diagnostic. */
  size(): number {
    return this.state.size;
  }

  private tearDown(sessionId: string): void {
    const entry = this.state.get(sessionId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.lastPushedAt.clear();
    this.state.delete(sessionId);
  }

  private scheduleNext(sessionId: string, delayMs: number): void {
    const entry = this.state.get(sessionId);
    if (!entry) return;
    // Never orphan a pending timer — an overwritten-but-live timeout would
    // fire its own tick chain alongside the new one.
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      void this.tick(sessionId);
    }, delayMs);
  }

  private async tick(sessionId: string): Promise<void> {
    const entry = this.state.get(sessionId);
    if (!entry) return;
    entry.timer = null;
    entry.ticking = true;

    let nextDelayMs: number = this.intervalMs;
    /**
     * Set when this tick called provider.skipTrack(). Forces a fast
     * follow-up so the new now-playing reaches clients within a second
     * instead of waiting a full intervalMs. Spotify's API needs ~500ms
     * to settle a skip — sub-second polls would just observe the old
     * state.
     */
    let skipDispatched = false;

    try {
      // Auto-stop if the session was ended while we were ticking.
      const session = await this.deps.sessions.findById(sessionId);
      if (!session || session.endedAt !== null) {
        this.tearDown(sessionId);
        return;
      }

      // Resolve which provider connection backs this session. Cache it so
      // repeated ticks don't hammer the providers repo.
      if (!entry.cachedProviderId) {
        const conns = await this.deps.providerConnections.findAllForAccount(session.accountId);
        const connected = conns[0];
        if (!connected) return; // nothing connected; come back next tick
        entry.cachedAccountId = session.accountId;
        entry.cachedProviderId = connected.providerId;
      }

      let provider: IStreamingProvider;
      try {
        provider = await this.deps.streamingRouter.getProvider(
          entry.cachedAccountId!,
          entry.cachedProviderId!,
        );
      } catch (err) {
        if (
          err instanceof ProviderConnectionNotFoundError ||
          err instanceof InvalidProviderCredentialsError
        ) {
          this.logger.warn('[NowPlayingPoller] provider connection invalid, stopping session', {
            sessionId,
            error: err.message,
          });
          this.tearDown(sessionId);
          return;
        }
        throw err;
      }

      if (!supportsNowPlayingRead(provider)) {
        // Provider's not a now-playing source at all (e.g. a search-only
        // adapter). No point spinning further.
        this.tearDown(sessionId);
        return;
      }

      const next = await provider.getNowPlaying();
      const room = this.deps.roomManager.forSession(sessionId);
      if (!room) {
        // Room was torn down while we were awaiting. Reschedule won't help;
        // the route will start us again next subscribe.
        this.tearDown(sessionId);
        return;
      }
      const snapshot = await room.getSnapshot();
      const prev = snapshot.nowPlaying;

      // The provider answered, so any rate-limit window is over.
      if (snapshot.providerStatus?.state === 'rate_limited') {
        await room.publish({ type: 'provider.status_updated', status: { state: 'ok' } });
      }

      if (this.shouldPublish(prev, next)) {
        await room.publish({ type: 'now_playing.updated', track: next });
      }

      // Sync layer: broadcast a clock sample each tick so clients can
      // interpolate playback position locally (spec: no high-frequency
      // progress broadcasts — samples at poll cadence only).
      if (next) {
        await room.publish({
          type: 'playback.clock_sampled',
          sample: createPlaybackClockSample(next, this.nowEpochMs(), {
            providerId: entry.cachedProviderId ?? SPOTIFY_PROVIDER_ID,
          }),
        });
      }

      // Lyrics: on track change, fire a non-blocking lookup and publish the
      // result. Guard against out-of-order completion by re-checking the
      // room's CURRENT now-playing before publishing.
      if (next === null) {
        // Playback fully stopped (device stop, not pause): reset so the
        // lookup re-fires when the same track resumes with the same URI.
        entry.lastLyricsUri = null;
      }
      if (this.deps.lyricsLookup && next && next.uri !== entry.lastLyricsUri) {
        entry.lastLyricsUri = next.uri;
        const lookupUri = next.uri;
        void this.deps.lyricsLookup
          .lookup({
            trackName: next.name,
            artistName: next.artist,
            durationMs: next.durationMs,
            providerTrackUri: next.uri,
          })
          .catch(() => null)
          .then(async (lyrics) => {
            const currentRoom = this.deps.roomManager.forSession(sessionId);
            if (!currentRoom) return;
            const current = await currentRoom.getSnapshot();
            if (current.nowPlaying?.uri !== lookupUri) return; // stale result
            await currentRoom.publish({ type: 'lyrics.loaded', trackUri: lookupUri, lyrics });
          })
          .catch(() => {
            /* publish failed (room torn down) — lyrics never block playback */
          });
      }

      // Karaoke: reconcile pause state every tick (host-resume detection +
      // auto-resume deadline), then re-derive the spotlight on track change
      // (same per-session bookkeeping shape as the lyrics lookup above).
      // Reconcile runs FIRST so this tick's pre-pause isPlaying sample can
      // never clear a pause the track-change handler is about to set.
      if (this.deps.karaoke) {
        try {
          await this.deps.karaoke.reconcilePlayback({
            sessionId,
            isPlaying: next?.isPlaying ?? false,
            nowEpochMs: this.nowEpochMs(),
          });
          const karaokeUri = next?.uri ?? null;
          if (karaokeUri !== entry.lastKaraokeUri) {
            entry.lastKaraokeUri = karaokeUri;
            await this.deps.karaoke.handleTrackChange({
              sessionId,
              trackUri: karaokeUri,
              nowEpochMs: this.nowEpochMs(),
            });
          }
        } catch (err) {
          this.logger.warn('[NowPlayingPoller] karaoke sync failed, continuing', {
            sessionId,
            error: (err as Error).message,
          });
        }
      }

      // Auto-skip rejected provider-queue URIs the moment they reach the
      // now-playing slot. Cheaper than the post-fetch reconcile loop and
      // gets the skip out before we even fan the snapshot to clients.
      // Settle guard: within SKIP_SETTLE_MS of a dispatched skip, `next`
      // may still be the track we just skipped — re-skipping would eat the
      // song AFTER it.
      const skipSettling = this.nowEpochMs() - entry.lastSkipAtMs < SKIP_SETTLE_MS;
      if (next && this.deps.providerQueueRejections && !skipSettling) {
        const rejectedSet = this.deps.providerQueueRejections.getRejectedProviderUris(sessionId);
        if (rejectedSet.has(next.uri)) {
          try {
            if (supportsSkipTrack(provider)) {
              await provider.skipTrack();
              entry.lastSkipAtMs = this.nowEpochMs();
              this.deps.providerQueueRejections.consumeProviderRejection(sessionId, next.uri);
              skipDispatched = true;
              this.logger.warn('[NowPlayingPoller] auto-skipped vote-rejected provider track', {
                sessionId,
                trackUri: next.uri,
              });
            }
          } catch (err) {
            this.logger.warn('[NowPlayingPoller] provider-rejection auto-skip failed', {
              sessionId,
              error: (err as Error).message,
            });
          }
        }
      }

      // Provider queue (e.g. Spotify queue) — fetch + diff alongside
      // now-playing, but only when it can have changed in a way we care
      // about (see `shouldReadQueue`). Otherwise reconcile against the last
      // known queue from the snapshot.
      const items = this.deps.queueItems
        ? await this.deps.queueItems.findAllForSession(sessionId)
        : null;
      let providerQueue: ReadonlyArray<Track> = snapshot.providerQueue;
      if (supportsQueueRead(provider) && this.shouldReadQueue(entry, next, items)) {
        try {
          const queue = await provider.getQueue();
          providerQueue = queue;
          entry.lastQueueReadAtMs = this.nowEpochMs();
          entry.lastQueueTrackUri = next?.uri ?? null;
          if (this.providerQueueChanged(snapshot.providerQueue, queue)) {
            await room.publish({ type: 'provider_queue.updated', tracks: queue });
          }
        } catch (qErr) {
          // Queue read can fail independently (e.g. 403 on accounts without
          // playback). Log + continue — don't tear down the now-playing
          // poller for a queue-read hiccup.
          this.logger.warn('[NowPlayingPoller] provider queue read failed, continuing', {
            sessionId,
            error: (qErr as Error).message,
          });
        }
      }

      // Reconcile OpenDJ queue items against the provider's reality:
      // anything `approved` whose URI no longer appears in (now-playing ∪
      // providerQueue) has rolled past, mark it `played` so it stops
      // counting against the per-guest cap. 30s grace window prevents
      // racing newly-pushed items that haven't yet shown up on the next
      // queue read.
      if (items) {
        const reconcileSkipped = await this.reconcileQueue(sessionId, next, providerQueue, items);
        if (reconcileSkipped) skipDispatched = true;
      }

      // Tighten the next tick when we just dispatched a skip so the new
      // now-playing reaches clients ASAP. Spotify needs ~500ms to settle
      // a skip — anything sub-second risks reporting the old track as
      // still playing.
      if (skipDispatched) {
        nextDelayMs = 750;
      } else if ((next === null || !next.isPlaying) && !snapshot.karaoke?.paused) {
        // Nothing playing: slow down. A karaoke hold keeps the base
        // cadence so host-resume detection + the auto-resume deadline
        // stay responsive.
        nextDelayMs = this.idleIntervalMs;
      }

      // Successful tick clears any backoff.
      entry.backoffMs = null;
    } catch (err: unknown) {
      const errObj = err as { status?: number; statusCode?: number };
      const status = errObj?.status ?? errObj?.statusCode;
      if (status === 401) {
        this.logger.warn('[NowPlayingPoller] 401 from provider, stopping', { sessionId });
        this.tearDown(sessionId);
        return;
      }
      if (status === 429) {
        const current = entry.backoffMs ?? this.intervalMs;
        const nextBackoff = Math.min(this.maxBackoffMs, current * 2);
        // Honor the provider's Retry-After when it's LONGER than our own
        // exponential backoff. Spotify's extended-penalty windows run tens
        // of minutes; retrying every `maxBackoffMs` inside the window keeps
        // the app rate-limited indefinitely. +1s of slack so the first
        // retry lands after the window actually closes.
        const retryAfterSec = (err as { retryAfterSec?: number | null })?.retryAfterSec;
        const retryAfterMs =
          typeof retryAfterSec === 'number' && retryAfterSec > 0 ? retryAfterSec * 1000 + 1000 : 0;
        entry.backoffMs = nextBackoff;
        nextDelayMs = Math.max(nextBackoff, retryAfterMs);
        const untilEpochMs =
          (err as { untilEpochMs?: number })?.untilEpochMs ?? this.nowEpochMs() + nextDelayMs;
        await this.publishStatus(sessionId, {
          state: 'rate_limited',
          providerId: entry.cachedProviderId ?? SPOTIFY_PROVIDER_ID,
          untilEpochMs,
        });
        this.logger.warn('[NowPlayingPoller] 429 from provider, backing off', {
          sessionId,
          delayMs: nextDelayMs,
          retryAfterSec: retryAfterSec ?? null,
        });
      } else {
        // Transient — just keep the schedule.
        this.logger.warn('[NowPlayingPoller] tick failed, continuing', {
          sessionId,
          error: (err as Error).message,
        });
      }
    } finally {
      entry.ticking = false;
      // Reschedule iff the room still has subscribers AND we're not in the
      // middle of an idle-grace teardown.
      const stillTracked = this.state.get(sessionId);
      if (stillTracked && !stillTracked.idleTimer) {
        const room = this.deps.roomManager.forSession(sessionId);
        const stillSubscribed =
          room !== null && (room as { subscribedCount?: number }).subscribedCount !== 0;
        if (stillSubscribed) {
          this.scheduleNext(sessionId, nextDelayMs);
        } else if (room === null) {
          // No room at all — nothing to publish to.
          this.tearDown(sessionId);
        }
        // else: room exists but no subscribers — leave the timer un-scheduled
        // and let `stop` queue the teardown.
      }
    }
  }

  /**
   * Diff predicate. Publish iff something the UI cares about changed.
   * Exposed for tests.
   */
  shouldPublish(prev: NowPlayingTrack | null, next: NowPlayingTrack | null): boolean {
    if (prev === null && next === null) return false;
    if (prev === null || next === null) return true;
    if (prev.uri !== next.uri) return true;
    if (prev.isPlaying !== next.isPlaying) return true;
    if (Math.abs(prev.progressMs - next.progressMs) > this.driftThresholdMs) return true;
    return false;
  }

  /**
   * Whether this tick needs a fresh provider-queue read. Each read is a
   * Spotify call, so only read when the answer can matter: first tick,
   * track changed (items rolled over), periodic refresh, or an approved
   * request still inside the grace window (the retry pump must not
   * re-push based on a stale queue — that duplicates tracks).
   */
  private shouldReadQueue(
    entry: PerSession,
    next: NowPlayingTrack | null,
    items: ReadonlyArray<QueueItemRecord> | null,
  ): boolean {
    const now = this.nowEpochMs();
    if (entry.lastQueueReadAtMs === null) return true;
    if ((next?.uri ?? null) !== entry.lastQueueTrackUri) return true;
    if (now - entry.lastQueueReadAtMs >= this.queueRefreshMs) return true;
    return (
      items?.some(
        (item) => item.status === 'approved' && now - item.createdAt.getTime() < RECONCILE_GRACE_MS,
      ) ?? false
    );
  }

  /** Publish a provider-status change to the session's room (no-op if unchanged). */
  private async publishStatus(sessionId: string, status: ProviderStatus): Promise<void> {
    const room = this.deps.roomManager.forSession(sessionId);
    if (!room) return;
    try {
      const current = (await room.getSnapshot()).providerStatus;
      if (JSON.stringify(current) === JSON.stringify(status)) return;
      await room.publish({ type: 'provider.status_updated', status });
    } catch {
      // Status is advisory — never let it break the poll loop.
    }
  }

  /**
   * True iff the provider's queue ordering changed. Compares URIs in order
   * — anything else (length, content, position) reduces to a URI-list diff.
   * Exposed for tests.
   */
  providerQueueChanged(prev: ReadonlyArray<Track>, next: ReadonlyArray<Track>): boolean {
    if (prev.length !== next.length) return true;
    for (let i = 0; i < prev.length; i += 1) {
      if (prev[i]!.uri !== next[i]!.uri) return true;
    }
    return false;
  }

  /**
   * Reconcile OpenDJ queue items against the provider's reality. Two
   * passes per tick, both gated on `queueItems` being wired:
   *
   * 1. **Retry pump**: approved items younger than `RECONCILE_GRACE_MS`
   *    that aren't on the provider's queue and aren't currently playing
   *    get re-pushed via `provider.queueTrack`. Covers the case where
   *    the initial push failed (NO_ACTIVE_DEVICE at request time, host
   *    came online late, transient network blip).
   *
   * 2. **Status reconciliation**: items older than the grace window get
   *    a deterministic terminal status — `playing` if their URI is now
   *    playing, `played` if they're past the queue + now-playing, so
   *    they stop counting against the per-guest cap.
   */
  private async reconcileQueue(
    sessionId: string,
    nowPlaying: NowPlayingTrack | null,
    providerQueue: ReadonlyArray<Track>,
    items: ReadonlyArray<QueueItemRecord>,
  ): Promise<boolean> {
    const repo = this.deps.queueItems!;
    /**
     * Spotify's queue-read endpoint lags the queue-write by several
     * seconds: a track posted to /me/player/queue might not surface
     * in the next /me/player/queue read for 3–8s. Don't even consider
     * a retry until enough time has passed for that read to settle —
     * otherwise we double-push the same track and the host sees it
     * twice in their Up Next.
     */
    const RETRY_AFTER_PUSH_MS = 12_000;
    const now = Date.now();
    let skipDispatched = false;
    const sessionState = this.state.get(sessionId);
    const lastPushedAt = sessionState?.lastPushedAt;

    // Resolve the provider once for the retry pump (only if we'll need it).
    let providerForRetry: IStreamingProvider | null = null;
    const hasUnsyncedYoung = items.some((item) => {
      if (item.status !== 'approved') return false;
      const ageMs = now - item.createdAt.getTime();
      if (ageMs >= RECONCILE_GRACE_MS) return false;
      if (nowPlaying?.uri === item.trackUri) return false;
      return !providerQueue.some((t) => t.uri === item.trackUri);
    });
    if (hasUnsyncedYoung) {
      const cached = this.state.get(sessionId);
      if (cached?.cachedAccountId && cached.cachedProviderId) {
        try {
          providerForRetry = await this.deps.streamingRouter.getProvider(
            cached.cachedAccountId,
            cached.cachedProviderId,
          );
        } catch {
          // already logged in tick(); skip retry this round.
        }
      }
    }

    // First pass: if the currently-playing URI matches a queue item that
    // was voted-rejected (or moderated-rejected), skip it best-effort so
    // guests don't have to listen to it play out.
    //
    // Two safety gates so a stale rejection doesn't haunt the URI forever:
    //
    //   1. Skip if there's an active (approved/queued/playing) item with
    //      the same URI — that means a guest re-requested the song after
    //      the original rejection, so the user clearly wants it to play.
    //   2. After we successfully dispatch a skip, flip the rejected row
    //      to 'played' so a future re-queue of the same URI doesn't hit
    //      this match again.
    // Settle guard mirrors the tick's early skip path: after ANY skip this
    // session dispatched, `nowPlaying` is unreliable for SKIP_SETTLE_MS —
    // skipping again here would eat the following track.
    const skipSettling =
      sessionState !== undefined && this.nowEpochMs() - sessionState.lastSkipAtMs < SKIP_SETTLE_MS;
    if (nowPlaying && !skipSettling) {
      const rejectedHit = items.find(
        (i) => i.status === 'rejected' && i.trackUri === nowPlaying.uri,
      );
      const hasActiveSameUri = items.some(
        (i) =>
          i.trackUri === nowPlaying.uri &&
          (i.status === 'approved' || i.status === 'queued' || i.status === 'playing'),
      );
      if (rejectedHit && !hasActiveSameUri) {
        const cached = this.state.get(sessionId);
        if (cached?.cachedAccountId && cached.cachedProviderId) {
          try {
            const provider = await this.deps.streamingRouter.getProvider(
              cached.cachedAccountId,
              cached.cachedProviderId,
            );
            if (supportsSkipTrack(provider)) {
              await provider.skipTrack();
              if (sessionState) sessionState.lastSkipAtMs = this.nowEpochMs();
              skipDispatched = true;
              // Tombstone the rejected row so this match doesn't re-fire
              // on the same URI later. Status 'played' is semantically
              // close — the item is no longer eligible for any queue
              // pipeline; keeps it out of canEnqueue active-status checks.
              await repo.setStatus({
                id: rejectedHit.id,
                status: 'played',
                decidedAt: new Date(now),
              });
              this.logger.warn('[NowPlayingPoller] auto-skipped rejected track', {
                sessionId,
                itemId: rejectedHit.id,
                trackUri: rejectedHit.trackUri,
              });
            }
          } catch (err) {
            this.logger.warn('[NowPlayingPoller] auto-skip-on-rejected failed', {
              sessionId,
              error: (err as Error).message,
            });
          }
        }
      }
    }

    for (const item of items) {
      if (item.status !== 'approved' && item.status !== 'playing') continue;
      const ageMs = now - item.createdAt.getTime();
      const isCurrent = nowPlaying?.uri === item.trackUri;
      const isQueued = providerQueue.some((t) => t.uri === item.trackUri);

      if (ageMs < RECONCILE_GRACE_MS) {
        // Within grace: try to retry-push if missing on the provider.
        // Throttle by last push time — Spotify's queue-read endpoint
        // lags writes by several seconds, so a freshly pushed track
        // legitimately looks "unsynced" on the very next tick. Without
        // this gate we'd POST it again and end up with duplicates in
        // the host's Spotify queue.
        const lastPush = lastPushedAt?.get(item.id) ?? item.createdAt.getTime();
        const sincePush = now - lastPush;
        if (
          !isCurrent &&
          !isQueued &&
          providerForRetry &&
          supportsQueueTrack(providerForRetry) &&
          item.status === 'approved' &&
          sincePush >= RETRY_AFTER_PUSH_MS
        ) {
          try {
            await providerForRetry.queueTrack({
              uri: item.trackUri,
              name: item.trackName,
              artist: item.artistName,
              albumArt: item.albumArtUrl,
              durationMs: item.durationMs ?? 0,
            });
            lastPushedAt?.set(item.id, now);
            this.logger.warn('[NowPlayingPoller] retry-pushed unsynced item to provider', {
              sessionId,
              itemId: item.id,
              trackUri: item.trackUri,
              sincePushMs: sincePush,
            });
          } catch (err) {
            // Swallow — most common cause is NO_ACTIVE_DEVICE; we'll try
            // again next tick or eventually mark played after grace.
            this.logger.warn('[NowPlayingPoller] retry-push failed', {
              sessionId,
              itemId: item.id,
              error: (err as Error).message,
            });
          }
        }
        continue;
      }

      // Past grace: deterministic terminal status.
      if (isCurrent && item.status !== 'playing') {
        await repo.setStatus({ id: item.id, status: 'playing' });
      } else if (!isCurrent && !isQueued) {
        await repo.setStatus({ id: item.id, status: 'played', decidedAt: new Date(now) });
      }
    }
    return skipDispatched;
  }
}

// SPOTIFY_PROVIDER_ID is intentionally exported for any external caller that
// wants to seed cachedProviderId differently in a test, but the class itself
// resolves it from `provider_connections` so future provider-agnostic
// deployments work without code changes.
export { SPOTIFY_PROVIDER_ID };
