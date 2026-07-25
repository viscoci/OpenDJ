/**
 * WebSocket upgrade route at `/api/v1/sessions/:id/realtime`.
 *
 * The actual WS protocol/adapter is runtime-specific (`@hono/node-ws` for
 * Node, Cloudflare's WebSocketPair for Workers, etc.) — this factory accepts
 * an `upgradeWebSocket` helper from the adapter and wires the lifecycle.
 *
 * Connection lifecycle:
 * 1. Client connects → assign a clientId, materialize/lookup the room
 * 2. Send the current snapshot as the first message: `{ type: '_snapshot', snapshot, sessionId }`
 * 3. Subscribe a sender that JSON-stringifies every published `SessionEvent`
 * 4. On close: disconnect the client (drops subscriber + client record)
 *
 * Anonymous-guest auth model: no slot token required to listen — the queue
 * is public to anyone with the QR slug, so reads (snapshot + events) are too.
 * Mutations require a slot token via the existing route handlers (which
 * publish to the room after persisting).
 */

import { Hono } from 'hono';
import { toQueueItemSummary, type KaraokeClaimSummary, type SessionEvent } from '@opendj/realtime';
import { groupClaimSummaries } from '../karaoke/claimSummaries.js';
import type { NowPlayingPoller } from '../realtime/NowPlayingPoller.js';
import type { RealtimeRoomManager } from '../realtime/RoomRegistryImpl.js';
import type { KaraokeClaimRepository, QueueItemRepository } from '../repositories/types.js';

export interface RealtimeRouteDeps {
  rooms: RealtimeRoomManager;
  /**
   * Optional. When supplied, the WS route starts the poller on first
   * subscriber and schedules a stop on last disconnect. Tests + Workers
   * deploys can omit it.
   */
  nowPlayingPoller?: NowPlayingPoller | null;
  /**
   * Optional. When supplied, the WS route hydrates a freshly-materialized
   * room's snapshot from the persistent queue store on first subscriber
   * — without this, items submitted before the room (or before this
   * server's boot) are missing from the initial `_snapshot` frame even
   * though they're still in the DB.
   */
  queueItems?: QueueItemRepository;
  /**
   * Optional. When supplied alongside `queueItems`, hydrated items carry
   * their karaoke mic claims instead of the empty default.
   */
  karaokeClaims?: KaraokeClaimRepository;
}

/**
 * Minimal WS context shape we actually use. Matches both `@hono/node-ws` and
 * Hono's built-in WSContext — both expose `send` + `close`.
 */
interface MinimalWSContext {
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

interface MinimalWSEvents {
  onOpen?: (event: unknown, ws: MinimalWSContext) => void | Promise<void>;
  onMessage?: (event: { data: unknown }, ws: MinimalWSContext) => void | Promise<void>;
  onClose?: (event: unknown, ws: MinimalWSContext) => void | Promise<void>;
  onError?: (event: unknown, ws: MinimalWSContext) => void | Promise<void>;
}

/**
 * Adapter-supplied helper. `@hono/node-ws` exports it from
 * `createNodeWebSocket(...)`; Cloudflare exports a different shape that
 * still satisfies this signature.
 */
export type UpgradeWebSocket = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  factory: (c: any) => MinimalWSEvents | Promise<MinimalWSEvents>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
) => any;

export function realtimeRoutes(deps: RealtimeRouteDeps, upgradeWebSocket: UpgradeWebSocket): Hono {
  const app = new Hono();
  // One-time hydration per room — once we've folded DB items into the
  // snapshot we don't want to do it again on every reconnect (live events
  // keep the snapshot in sync from there).
  const hydratedSessions = new Set<string>();

  app.get(
    '/',
    upgradeWebSocket((c: { req: { param: (n: string) => string | undefined } }) => {
      const sessionId = c.req.param('id') ?? '';
      const room = deps.rooms.ensureRoom(sessionId);
      let clientId: string | null = null;

      return {
        async onOpen(_evt: unknown, ws: MinimalWSContext) {
          clientId = crypto.randomUUID();
          await room.connect({
            clientId,
            kind: 'guest',
            sessionId,
            connectedAtEpochMs: Date.now(),
          });
          room.subscribe(clientId, (event: SessionEvent) => {
            ws.send(JSON.stringify(event));
          });
          // Now-playing poller starts on first subscriber. Idempotent — the
          // poller no-ops if it's already running for this session and
          // cancels a pending teardown if the previous subscriber dropped
          // within the idle grace.
          if (deps.nowPlayingPoller) {
            deps.nowPlayingPoller.start(sessionId);
          }
          // Hydrate the room's snapshot from persistent storage on the
          // first subscriber. The room is in-memory and otherwise only
          // tracks events fired since it was instantiated, so anything
          // submitted before this server's boot wouldn't appear in
          // pending/queue arrays. Idempotent per session.
          if (!hydratedSessions.has(sessionId) && deps.queueItems) {
            try {
              const items = await deps.queueItems.findAllForSession(sessionId);
              const claimsByItem = deps.karaokeClaims
                ? groupClaimSummaries(await deps.karaokeClaims.findAllForSession(sessionId))
                : new Map<string, KaraokeClaimSummary[]>();
              const current = await room.getSnapshot();
              const pending = [...current.pending];
              const queue = [...current.queue];
              const seenIds = new Set<string>([
                ...pending.map((p) => p.id),
                ...queue.map((q) => q.id),
              ]);
              for (const item of items) {
                if (seenIds.has(item.id)) continue;
                const summary = toQueueItemSummary(
                  {
                    id: item.id,
                    sessionId: item.sessionId,
                    guestId: item.guestId,
                    trackUri: item.trackUri,
                    trackName: item.trackName,
                    artistName: item.artistName,
                    albumArtUrl: item.albumArtUrl,
                    durationMs: item.durationMs,
                    status: item.status,
                    skipVotes: item.skipVotes,
                    createdAt: item.createdAt,
                    decidedAt: item.decidedAt,
                  },
                  claimsByItem.get(item.id) ?? [],
                );
                if (item.status === 'pending') pending.push(summary);
                else if (
                  item.status === 'approved' ||
                  item.status === 'queued' ||
                  item.status === 'playing'
                ) {
                  queue.push(summary);
                }
              }
              room.setSnapshot({ ...current, pending, queue });
              hydratedSessions.add(sessionId);
            } catch {
              // Non-fatal — guests will see the snapshot fill in via
              // subsequent live events. Avoid blocking the WS open path.
            }
          }
          // Initial snapshot so the client doesn't render blank until the next event.
          const snapshot = await room.getSnapshot();
          ws.send(JSON.stringify({ type: '_snapshot', snapshot, sessionId }));
        },
        async onClose() {
          if (clientId) await room.disconnect(clientId);
          // If we just disconnected the LAST subscriber, schedule the
          // poller's teardown after the idle grace. A guest reload within
          // that window cancels the teardown via the next onOpen's `start`.
          if (deps.nowPlayingPoller && room.subscribedCount === 0) {
            deps.nowPlayingPoller.stop(sessionId);
          }
        },
        onError(_evt: unknown, ws: MinimalWSContext) {
          ws.close();
        },
      };
    }),
  );

  return app;
}
