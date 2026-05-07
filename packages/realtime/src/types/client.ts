/**
 * Realtime connection metadata.
 *
 * Concrete RealtimeRoom implementations (NodeSessionRoom for Node deploys,
 * a Durable Object actor for Workers deploys) hold a transport-specific
 * socket reference separately and use this struct only as identity +
 * addressing context.
 */
export type RealtimeClientKind = 'guest' | 'host' | 'tv' | 'service';

export interface RealtimeClient {
  /** Unique within a single room instance (e.g. UUID). */
  clientId: string;
  kind: RealtimeClientKind;
  sessionId: string;
  /** Linked when the client is an authenticated user (host or logged-in guest). */
  userId?: string;
  /** Linked when the client owns a guest slot. */
  guestId?: string;
  /** Wall-clock time of connection. */
  connectedAtEpochMs: number;
}
