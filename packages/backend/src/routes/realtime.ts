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
import type { SessionEvent } from '@opendj/realtime';
import type { RealtimeRoomManager } from '../realtime/RoomRegistryImpl.js';

export interface RealtimeRouteDeps {
  rooms: RealtimeRoomManager;
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
          // Initial snapshot so the client doesn't render blank until the next event.
          const snapshot = await room.getSnapshot();
          ws.send(JSON.stringify({ type: '_snapshot', snapshot, sessionId }));
        },
        async onClose() {
          if (clientId) await room.disconnect(clientId);
        },
        onError(_evt: unknown, ws: MinimalWSContext) {
          ws.close();
        },
      };
    }),
  );

  return app;
}
