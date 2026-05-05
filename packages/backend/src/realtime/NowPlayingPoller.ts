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
 *   - 429 (Spotify rate limit) → exponential backoff capped at `maxBackoffMs`.
 *   - Other errors → log + continue at the base interval.
 */

import {
  InvalidProviderCredentialsError,
  supportsNowPlayingRead,
  supportsQueueRead,
  type IStreamingProvider,
  type NowPlayingTrack,
  type Track,
} from '@opendj/core';
import {
  ProviderConnectionNotFoundError,
  StreamingRouter,
} from '../providers/streaming/StreamingRouter.js';
import type { RealtimeRoomManager } from './RoomRegistryImpl.js';
import type { ProviderConnectionRepository, SessionRepository } from '../repositories/types.js';

export interface NowPlayingPollerDeps {
  sessions: SessionRepository;
  providerConnections: ProviderConnectionRepository;
  streamingRouter: StreamingRouter;
  roomManager: RealtimeRoomManager;
}

export interface NowPlayingPollerOptions {
  /** Base poll interval. Default 5000 ms. */
  intervalMs?: number;
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
  /** Optional log sink. Defaults to `console`. */
  logger?: { warn(msg: string, meta?: unknown): void };
}

interface PerSession {
  /** Outstanding tick timer. */
  timer: ReturnType<typeof setTimeout> | null;
  /** Outstanding idle-grace teardown timer. */
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** Cached account + provider (avoid hammering repos every 5s). */
  cachedAccountId: string | null;
  cachedProviderId: string | null;
  /** Current backoff delay (only set after a 429). */
  backoffMs: number | null;
}

const SPOTIFY_PROVIDER_ID = 'spotify';

export class NowPlayingPoller {
  private readonly intervalMs: number;
  private readonly driftThresholdMs: number;
  private readonly idleGraceMs: number;
  private readonly maxBackoffMs: number;
  private readonly logger: { warn(msg: string, meta?: unknown): void };
  private readonly state = new Map<string, PerSession>();

  constructor(
    private readonly deps: NowPlayingPollerDeps,
    options: NowPlayingPollerOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? 5000;
    this.driftThresholdMs = options.driftThresholdMs ?? 4000;
    this.idleGraceMs = options.idleGraceMs ?? 30_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000;
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
        idleTimer: null,
        cachedAccountId: null,
        cachedProviderId: null,
        backoffMs: null,
      };
      this.state.set(sessionId, entry);
    }
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    if (entry.timer) return;
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

  /** Number of sessions currently being polled. Diagnostic. */
  size(): number {
    return this.state.size;
  }

  private tearDown(sessionId: string): void {
    const entry = this.state.get(sessionId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    this.state.delete(sessionId);
  }

  private scheduleNext(sessionId: string, delayMs: number): void {
    const entry = this.state.get(sessionId);
    if (!entry) return;
    entry.timer = setTimeout(() => {
      void this.tick(sessionId);
    }, delayMs);
  }

  private async tick(sessionId: string): Promise<void> {
    const entry = this.state.get(sessionId);
    if (!entry) return;
    entry.timer = null;

    let nextDelayMs: number = this.intervalMs;

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

      if (this.shouldPublish(prev, next)) {
        await room.publish({ type: 'now_playing.updated', track: next });
      }

      // Provider queue (e.g. Spotify queue) — fetch + diff alongside
      // now-playing. Costs one extra Spotify API call per tick when the
      // provider supports it; same auth as getNowPlaying so it shares
      // the 401/429 paths below.
      if (supportsQueueRead(provider)) {
        try {
          const queue = await provider.getQueue();
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
        entry.backoffMs = nextBackoff;
        nextDelayMs = nextBackoff;
        this.logger.warn('[NowPlayingPoller] 429 from provider, backing off', {
          sessionId,
          delayMs: nextBackoff,
        });
      } else {
        // Transient — just keep the schedule.
        this.logger.warn('[NowPlayingPoller] tick failed, continuing', {
          sessionId,
          error: (err as Error).message,
        });
      }
    } finally {
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
}

// SPOTIFY_PROVIDER_ID is intentionally exported for any external caller that
// wants to seed cachedProviderId differently in a test, but the class itself
// resolves it from `provider_connections` so future provider-agnostic
// deployments work without code changes.
export { SPOTIFY_PROVIDER_ID };
