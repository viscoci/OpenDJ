/**
 * RealtimeClient — WebSocket subscriber for `/api/v1/sessions/:id/realtime`.
 *
 * Responsibilities:
 * - Open a WebSocket and emit decoded `SessionEvent`s
 * - Auto-reconnect with exponential backoff (capped) on unclean close
 * - Surface lifecycle to listeners: 'open', 'close', 'error', 'event'
 * - Allow targeted listeners by `SessionEvent['type']`
 *
 * Designed to be Angular-free. Components wrap the listener API in
 * signals/observables.
 *
 * The wire format mirrors what the backend's `RealtimeRoomManager` writes —
 * each `WebSocket.send` carries one JSON-encoded `SessionEvent`. Anything
 * unparseable is surfaced via the 'error' channel; the connection stays open.
 */

import type { SessionEvent, SessionEventType, SessionSnapshot } from '@opendj/realtime';

export type RealtimeStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface RealtimeClientOptions {
  /**
   * Full WebSocket URL — typically `wss://your-app.example/api/v1/sessions/<id>/realtime`.
   * The caller composes it (the client knows nothing about your base URL).
   */
  url: string;
  /**
   * WebSocket factory. Defaults to `globalThis.WebSocket`. SSR/tests pass a
   * mock implementation matching the standard WebSocket interface.
   */
  webSocketImpl?: { new (url: string, protocols?: string | string[]): WebSocket };
  /** Reconnect on unclean close. Default true. */
  reconnect?: boolean;
  /** Initial reconnect delay (ms). Default 500. */
  reconnectInitialDelayMs?: number;
  /** Max reconnect delay (ms). Default 15_000. */
  reconnectMaxDelayMs?: number;
  /** Max reconnect attempts before giving up. Default Infinity. */
  reconnectMaxAttempts?: number;
}

export type RealtimeListener<T = unknown> = (payload: T) => void;

interface InternalListeners {
  open: Set<RealtimeListener<void>>;
  close: Set<RealtimeListener<{ code: number; reason: string; clean: boolean }>>;
  error: Set<RealtimeListener<unknown>>;
  status: Set<RealtimeListener<RealtimeStatus>>;
  event: Set<RealtimeListener<SessionEvent>>;
  /**
   * The room sends a `{ type: '_snapshot', snapshot, sessionId }` frame on
   * connect so subscribers can render initial state without an extra REST
   * call. It is NOT a `SessionEvent` — this channel keeps it separate.
   */
  snapshot: Set<RealtimeListener<SessionSnapshot>>;
}

interface SnapshotFrame {
  type: '_snapshot';
  snapshot: SessionSnapshot;
  sessionId: string;
}

export class RealtimeClient {
  private socket: WebSocket | null = null;
  private status: RealtimeStatus = 'idle';
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByCaller = false;
  private readonly typedListeners = new Map<
    SessionEventType,
    Set<RealtimeListener<SessionEvent>>
  >();
  private readonly listeners: InternalListeners = {
    open: new Set(),
    close: new Set(),
    error: new Set(),
    status: new Set(),
    event: new Set(),
    snapshot: new Set(),
  };
  private readonly options: Required<Omit<RealtimeClientOptions, 'url' | 'webSocketImpl'>> & {
    url: string;
    webSocketImpl: NonNullable<RealtimeClientOptions['webSocketImpl']>;
  };

  constructor(opts: RealtimeClientOptions) {
    const wsImpl = opts.webSocketImpl ?? (globalThis as { WebSocket: typeof WebSocket }).WebSocket;
    if (!wsImpl) {
      throw new Error('RealtimeClient: no WebSocket implementation available.');
    }
    this.options = {
      url: opts.url,
      webSocketImpl: wsImpl,
      reconnect: opts.reconnect ?? true,
      reconnectInitialDelayMs: opts.reconnectInitialDelayMs ?? 500,
      reconnectMaxDelayMs: opts.reconnectMaxDelayMs ?? 15_000,
      reconnectMaxAttempts: opts.reconnectMaxAttempts ?? Number.POSITIVE_INFINITY,
    };
  }

  getStatus(): RealtimeStatus {
    return this.status;
  }

  /** Open the connection. No-op if already connecting/open. */
  connect(): void {
    if (this.status === 'connecting' || this.status === 'open') return;
    this.closedByCaller = false;
    this.openSocket();
  }

  /** Close the connection. Suppresses reconnect. Idempotent. */
  close(code = 1000, reason = 'client-close'): void {
    this.closedByCaller = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close(code, reason);
    this.setStatus('closed');
  }

  /** Subscribe to a specific event type. Returns an unsubscribe function. */
  on<T extends SessionEventType>(
    type: T,
    listener: (event: Extract<SessionEvent, { type: T }>) => void,
  ): () => void {
    let set = this.typedListeners.get(type);
    if (!set) {
      set = new Set();
      this.typedListeners.set(type, set);
    }
    set.add(listener as RealtimeListener<SessionEvent>);
    return () => {
      set!.delete(listener as RealtimeListener<SessionEvent>);
    };
  }

  /** Subscribe to ALL events. Returns an unsubscribe function. */
  onEvent(listener: RealtimeListener<SessionEvent>): () => void {
    this.listeners.event.add(listener);
    return () => this.listeners.event.delete(listener);
  }

  /**
   * Subscribe to the initial-state snapshot the room sends on connect.
   * Fires exactly once per WS open (and again on reconnect). Use it to seed
   * page state so the UI doesn't render blank until the first delta event.
   */
  onSnapshot(listener: RealtimeListener<SessionSnapshot>): () => void {
    this.listeners.snapshot.add(listener);
    return () => this.listeners.snapshot.delete(listener);
  }

  onOpen(listener: RealtimeListener<void>): () => void {
    this.listeners.open.add(listener);
    return () => this.listeners.open.delete(listener);
  }

  onClose(
    listener: RealtimeListener<{ code: number; reason: string; clean: boolean }>,
  ): () => void {
    this.listeners.close.add(listener);
    return () => this.listeners.close.delete(listener);
  }

  onError(listener: RealtimeListener<unknown>): () => void {
    this.listeners.error.add(listener);
    return () => this.listeners.error.delete(listener);
  }

  onStatus(listener: RealtimeListener<RealtimeStatus>): () => void {
    this.listeners.status.add(listener);
    return () => this.listeners.status.delete(listener);
  }

  // ─── internals ───────────────────────────────────────────────────────────

  private openSocket(): void {
    this.setStatus(this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting');
    let socket: WebSocket;
    try {
      socket = new this.options.webSocketImpl(this.options.url);
    } catch (err) {
      this.emit('error', err);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.reconnectAttempts = 0;
      this.setStatus('open');
      this.emit('open', undefined);
    });

    socket.addEventListener('message', (msg) => this.handleMessage(msg));

    socket.addEventListener('error', (err) => {
      this.emit('error', err);
    });

    socket.addEventListener('close', (event) => {
      this.socket = null;
      const closeData = {
        code: event.code,
        reason: event.reason,
        clean: event.wasClean,
      };
      this.emit('close', closeData);
      if (this.closedByCaller) {
        this.setStatus('closed');
        return;
      }
      if (!this.options.reconnect || this.reconnectAttempts >= this.options.reconnectMaxAttempts) {
        this.setStatus('closed');
        return;
      }
      this.scheduleReconnect();
    });
  }

  private handleMessage(msg: MessageEvent): void {
    let payload: unknown;
    try {
      payload = typeof msg.data === 'string' ? JSON.parse(msg.data) : JSON.parse(String(msg.data));
    } catch (err) {
      this.emit('error', err);
      return;
    }
    // The realtime route sends an initial `{type: '_snapshot', snapshot, sessionId}`
    // frame on every WS open. It's structurally similar to a SessionEvent
    // (has `.type`) but it is NOT one — fan out separately so onEvent
    // listeners don't receive it as if it were a delta.
    if (isSnapshotFrame(payload)) {
      for (const listener of this.listeners.snapshot) {
        try {
          listener(payload.snapshot);
        } catch (err) {
          this.emit('error', err);
        }
      }
      return;
    }
    if (!isSessionEvent(payload)) {
      this.emit('error', new Error('RealtimeClient: dropped non-SessionEvent payload'));
      return;
    }
    for (const listener of this.listeners.event) {
      try {
        listener(payload);
      } catch (err) {
        this.emit('error', err);
      }
    }
    const targeted = this.typedListeners.get(payload.type);
    if (targeted) {
      for (const listener of targeted) {
        try {
          listener(payload);
        } catch (err) {
          this.emit('error', err);
        }
      }
    }
  }

  private scheduleReconnect(): void {
    this.reconnectAttempts += 1;
    const baseDelay = this.options.reconnectInitialDelayMs * 2 ** (this.reconnectAttempts - 1);
    const delay = Math.min(baseDelay, this.options.reconnectMaxDelayMs);
    this.setStatus('reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  private setStatus(status: RealtimeStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const listener of this.listeners.status) {
      try {
        listener(status);
      } catch {
        // status listeners shouldn't throw — if one does, drop.
      }
    }
  }

  private emit(channel: 'open', payload: void): void;
  private emit(channel: 'close', payload: { code: number; reason: string; clean: boolean }): void;
  private emit(channel: 'error', payload: unknown): void;
  private emit(channel: keyof InternalListeners, payload: unknown): void {
    const set = this.listeners[channel] as Set<RealtimeListener<unknown>>;
    for (const listener of set) {
      try {
        listener(payload);
      } catch {
        // never let one bad listener crash the dispatch loop
      }
    }
  }
}

function isSessionEvent(value: unknown): value is SessionEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string' &&
    (value as { type: string }).type !== '_snapshot'
  );
}

function isSnapshotFrame(value: unknown): value is SnapshotFrame {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === '_snapshot' &&
    typeof (value as { snapshot?: unknown }).snapshot === 'object' &&
    (value as { snapshot?: unknown }).snapshot !== null
  );
}
