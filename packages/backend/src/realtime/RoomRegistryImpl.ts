/**
 * Per-process room registry. Lazily creates a `NodeSessionRoom` the first
 * time a session is referenced; keeps it around until explicitly removed.
 *
 * Implements `RealtimeRoomRegistry` (read-only `forSession`) used by services
 * like `QueueService`, plus `RealtimeRoomManager` (adds `ensureRoom` /
 * `removeRoom`) used by the WebSocket upgrade route to materialize rooms
 * on first guest connection.
 *
 * Hosted Cloudflare Durable Object deploys won't use this — Workers + DOs
 * route to a single per-session actor by id natively.
 */

import { NodeSessionRoom } from '@opendj/realtime';
import type { RealtimeRoom } from '@opendj/realtime';
import type { RealtimeRoomRegistry } from '../queue/QueueService.js';

export interface RealtimeRoomManager extends RealtimeRoomRegistry {
  /** Get the room for `sessionId`, creating it if it doesn't yet exist. */
  ensureRoom(sessionId: string): NodeSessionRoom;
  /** Drop the room (e.g. on `session.ended`). */
  removeRoom(sessionId: string): void;
  /** Active room count — useful for diagnostics. */
  size(): number;
}

export class RoomRegistryImpl implements RealtimeRoomManager {
  private readonly rooms = new Map<string, NodeSessionRoom>();

  forSession(sessionId: string): RealtimeRoom | null {
    return this.rooms.get(sessionId) ?? null;
  }

  ensureRoom(sessionId: string): NodeSessionRoom {
    const existing = this.rooms.get(sessionId);
    if (existing) return existing;
    const room = new NodeSessionRoom({ sessionId });
    this.rooms.set(sessionId, room);
    return room;
  }

  removeRoom(sessionId: string): void {
    this.rooms.delete(sessionId);
  }

  size(): number {
    return this.rooms.size;
  }
}
