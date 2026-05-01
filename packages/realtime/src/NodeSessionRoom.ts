/**
 * In-process implementation of `RealtimeRoom` for the OSS Node deploy.
 *
 * Holds the hot session snapshot in memory, manages a Map of subscribers,
 * and applies pure event transitions on every publish so the snapshot stays
 * in sync with what listeners see.
 *
 * `mutate(command)` is intentionally not implemented in v1 — routes call
 * `publish(event)` directly after their durable persistence step. A future
 * commit will add a command-handler registry that does mutate-as-transaction.
 *
 * Transport (WebSocket adapters) plugs in via `subscribe(clientId, sender)`.
 * The room is transport-agnostic — both `@hono/node-ws` and Cloudflare
 * Durable Object WebSockets satisfy the sender callback signature.
 *
 * For multi-container OSS scale-out, a Valkey pub/sub adapter can wrap a
 * NodeSessionRoom instance per container and forward `publish` calls across
 * containers — see brief §"OSS: NodeSessionRoom".
 */

import { applyEvent } from './applyEvent.js';
import type { RealtimeRoom } from './RealtimeRoom.js';
import type { RealtimeClient } from './types/client.js';
import type { SessionCommand } from './types/command.js';
import type { SessionEvent } from './types/event.js';
import { createEmptySnapshot, type SessionSnapshot } from './types/snapshot.js';

export type EventSender = (event: SessionEvent) => void | Promise<void>;

export interface NodeSessionRoomOptions {
  sessionId: string;
  initialSnapshot?: SessionSnapshot;
  /** Wall-clock injection — defaults to Date.now. Used by createEmptySnapshot's snapshotAtEpochMs. */
  nowEpochMs?: () => number;
}

export class NodeSessionRoom implements RealtimeRoom {
  readonly sessionId: string;
  private snapshot: SessionSnapshot;
  private readonly clients = new Map<string, RealtimeClient>();
  private readonly subscribers = new Map<string, EventSender>();
  private readonly now: () => number;

  constructor(options: NodeSessionRoomOptions) {
    this.sessionId = options.sessionId;
    this.now = options.nowEpochMs ?? Date.now;
    this.snapshot = options.initialSnapshot ?? createEmptySnapshot(options.sessionId, this.now());
  }

  async connect(client: RealtimeClient): Promise<void> {
    if (client.sessionId !== this.sessionId) {
      throw new Error(
        `RealtimeClient.sessionId "${client.sessionId}" does not match room sessionId "${this.sessionId}".`,
      );
    }
    this.clients.set(client.clientId, client);
  }

  async disconnect(clientId: string): Promise<void> {
    this.clients.delete(clientId);
    this.subscribers.delete(clientId);
  }

  async getSnapshot(): Promise<SessionSnapshot> {
    // Return a structural copy so callers can't mutate live state.
    return {
      ...this.snapshot,
      activeLyricsWindow: [...this.snapshot.activeLyricsWindow],
      queue: [...this.snapshot.queue],
      pending: [...this.snapshot.pending],
    };
  }

  /**
   * Apply `event` to the in-memory snapshot, then fan out to every subscriber.
   *
   * Subscriber callbacks may be sync or async. Async callbacks are awaited
   * sequentially — keep them fast (per-client send is bounded). For high-fan-out
   * scenarios, a future variant can fire them in parallel via Promise.all.
   *
   * Subscriber errors are swallowed (logged via console.error) — one slow or
   * failing client must not block broadcasts to the rest of the room.
   */
  async publish(event: SessionEvent): Promise<void> {
    this.snapshot = applyEvent(this.snapshot, event);
    for (const send of this.subscribers.values()) {
      try {
        await send(event);
      } catch (err) {
        console.error('[NodeSessionRoom] subscriber threw:', err);
      }
    }
    this.snapshot = { ...this.snapshot, snapshotAtEpochMs: this.now() };
  }

  async mutate<T = unknown>(_command: SessionCommand): Promise<T> {
    throw new Error(
      'NodeSessionRoom.mutate is not implemented. Persist via your service layer ' +
        'and call publish(event) directly.',
    );
  }

  // ─── Adapter API (not part of RealtimeRoom) ──────────────────────────

  /**
   * Register a transport callback for a connected client. Call after `connect`.
   * The provided `send` is invoked for every event from `publish`.
   */
  subscribe(clientId: string, send: EventSender): void {
    if (!this.clients.has(clientId)) {
      throw new Error(`subscribe: clientId "${clientId}" is not connected to this room.`);
    }
    this.subscribers.set(clientId, send);
  }

  /** Number of currently connected clients. Useful for tests + diagnostics. */
  get connectedCount(): number {
    return this.clients.size;
  }

  /** Number of clients with active subscribers (transport ready). */
  get subscribedCount(): number {
    return this.subscribers.size;
  }

  /** Replace the snapshot wholesale. Used by the room boot path after rehydrating from Postgres. */
  setSnapshot(snapshot: SessionSnapshot): void {
    this.snapshot = snapshot;
  }
}
