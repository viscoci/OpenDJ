import type { RealtimeClient } from './types/client.js';
import type { SessionCommand } from './types/command.js';
import type { SessionEvent } from './types/event.js';
import type { SessionSnapshot } from './types/snapshot.js';

/**
 * Runtime-neutral interface for a per-session realtime room.
 *
 * - Node: implemented by `NodeSessionRoom` (in-process, optional Valkey
 *   pub/sub for multi-container scale-out).
 * - Workers: implementable by a Cloudflare Durable Object actor in a
 *   downstream consumer.
 *
 * Both implementations:
 * - Maintain a hot in-memory `SessionSnapshot`
 * - Serialize `mutate(command)` calls to avoid race conditions
 * - Persist durable state transitions to Postgres
 * - Broadcast `SessionEvent`s to connected clients
 *
 * See docs/agent-brief.md §"Realtime and caching architecture".
 */
export interface RealtimeRoom {
  /** Session ID this room is bound to. */
  readonly sessionId: string;

  /**
   * Register a client. The room sends the current snapshot to the new client
   * and includes them in subsequent broadcasts.
   */
  connect(client: RealtimeClient): Promise<void>;

  /** Disconnect a client. Idempotent — disconnecting an unknown clientId is a no-op. */
  disconnect(clientId: string): Promise<void>;

  /** Read the current snapshot. Cheap; no I/O required for hot fields. */
  getSnapshot(): Promise<SessionSnapshot>;

  /** Broadcast an event to all connected clients. Used by mutate() internally. */
  publish(event: SessionEvent): Promise<void>;

  /**
   * Apply a command. Implementations:
   * 1. Validate against current snapshot (idempotency, conflict detection)
   * 2. Persist the durable consequence to Postgres
   * 3. Update the in-memory snapshot
   * 4. Broadcast the resulting SessionEvent(s)
   *
   * The return type is parameterized so commands like `enqueue` can return
   * the assigned QueueItem id, while `end_session` may return void.
   */
  mutate<T = unknown>(command: SessionCommand): Promise<T>;
}
