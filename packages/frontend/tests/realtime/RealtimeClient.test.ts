/**
 * RealtimeClient — uses a hand-rolled mock WebSocket so we don't pull in an
 * `ws` dep. The mock implements just the surface the client touches:
 * addEventListener('open' | 'message' | 'close' | 'error'), close(code, reason).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionEvent } from '@opendj/realtime';
import { RealtimeClient } from '../../src/realtime/RealtimeClient.js';

type Listeners = {
  open: Set<(event: Event) => void>;
  message: Set<(event: MessageEvent) => void>;
  close: Set<(event: CloseEvent) => void>;
  error: Set<(event: Event) => void>;
};

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  readonly url: string;
  closed = false;
  closeCode: number | null = null;
  closeReason: string | null = null;
  readonly listeners: Listeners = {
    open: new Set(),
    message: new Set(),
    close: new Set(),
    error: new Set(),
  };
  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }
  addEventListener<K extends keyof Listeners>(
    type: K,
    listener: K extends 'message' ? (e: MessageEvent) => void : (e: Event) => void,
  ): void {
    (this.listeners[type] as Set<unknown>).add(listener);
  }
  close(code = 1000, reason = ''): void {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
    this.dispatch('close', {
      code,
      reason,
      wasClean: true,
    } as unknown as CloseEvent);
  }
  /** Fire a fake server message. */
  emitMessage(data: unknown): void {
    const event = { data: typeof data === 'string' ? data : JSON.stringify(data) } as MessageEvent;
    for (const listener of this.listeners.message) listener(event);
  }
  /** Fire 'open' as if the server accepted. */
  emitOpen(): void {
    for (const listener of this.listeners.open) listener({} as Event);
  }
  /** Fire an unclean close (server crashed / network drop). */
  emitUncleanClose(): void {
    this.closed = true;
    for (const listener of this.listeners.close) {
      listener({ code: 1006, reason: '', wasClean: false } as unknown as CloseEvent);
    }
  }
  private dispatch<K extends keyof Listeners>(
    type: K,
    event: K extends 'message' ? MessageEvent : K extends 'close' ? CloseEvent : Event,
  ): void {
    for (const listener of this.listeners[type] as Set<(e: typeof event) => void>) {
      listener(event);
    }
  }
}

beforeEach(() => {
  MockWebSocket.instances = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('RealtimeClient — connection lifecycle', () => {
  it('opens a socket on connect() and emits status transitions', () => {
    const statuses: string[] = [];
    const client = new RealtimeClient({
      url: 'wss://api.test/api/v1/sessions/s1/realtime',
      webSocketImpl: MockWebSocket as unknown as typeof WebSocket,
    });
    client.onStatus((s) => statuses.push(s));
    client.connect();
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(statuses).toContain('connecting');
    MockWebSocket.instances[0]!.emitOpen();
    expect(statuses).toContain('open');
    expect(client.getStatus()).toBe('open');
  });

  it('close() suppresses reconnect', () => {
    const client = new RealtimeClient({
      url: 'wss://api.test/realtime',
      webSocketImpl: MockWebSocket as unknown as typeof WebSocket,
    });
    client.connect();
    MockWebSocket.instances[0]!.emitOpen();
    client.close();
    expect(client.getStatus()).toBe('closed');
    vi.advanceTimersByTime(20_000);
    // Only the original socket exists — no reconnection attempt
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('reconnects with exponential backoff on unclean close', () => {
    const client = new RealtimeClient({
      url: 'wss://api.test/realtime',
      webSocketImpl: MockWebSocket as unknown as typeof WebSocket,
      reconnectInitialDelayMs: 100,
      reconnectMaxDelayMs: 1000,
    });
    client.connect();
    MockWebSocket.instances[0]!.emitOpen();
    MockWebSocket.instances[0]!.emitUncleanClose();
    expect(client.getStatus()).toBe('reconnecting');
    vi.advanceTimersByTime(100);
    expect(MockWebSocket.instances).toHaveLength(2);
    MockWebSocket.instances[1]!.emitUncleanClose();
    vi.advanceTimersByTime(200);
    expect(MockWebSocket.instances).toHaveLength(3);
  });
});

describe('RealtimeClient — event dispatch', () => {
  it('parses JSON messages and fires onEvent for every SessionEvent', () => {
    const events: SessionEvent[] = [];
    const client = new RealtimeClient({
      url: 'wss://x/realtime',
      webSocketImpl: MockWebSocket as unknown as typeof WebSocket,
    });
    client.onEvent((e) => events.push(e));
    client.connect();
    MockWebSocket.instances[0]!.emitOpen();
    MockWebSocket.instances[0]!.emitMessage({ type: 'session.ended' });
    expect(events).toEqual([{ type: 'session.ended' }]);
  });

  it('on(type, ...) only fires for matching event types', () => {
    const ended: SessionEvent[] = [];
    const skip: SessionEvent[] = [];
    const client = new RealtimeClient({
      url: 'wss://x/realtime',
      webSocketImpl: MockWebSocket as unknown as typeof WebSocket,
    });
    client.on('session.ended', (e) => ended.push(e));
    client.on('skip_vote.updated', (e) => skip.push(e));
    client.connect();
    MockWebSocket.instances[0]!.emitOpen();
    MockWebSocket.instances[0]!.emitMessage({ type: 'session.ended' });
    MockWebSocket.instances[0]!.emitMessage({
      type: 'skip_vote.updated',
      itemId: 'q1',
      votes: 1,
      threshold: 5,
    });
    expect(ended).toHaveLength(1);
    expect(skip).toHaveLength(1);
  });

  it('emits to onError on non-JSON messages and stays connected', () => {
    const errors: unknown[] = [];
    const client = new RealtimeClient({
      url: 'wss://x/realtime',
      webSocketImpl: MockWebSocket as unknown as typeof WebSocket,
    });
    client.onError((err) => errors.push(err));
    client.connect();
    MockWebSocket.instances[0]!.emitOpen();
    MockWebSocket.instances[0]!.emitMessage('garbage');
    expect(errors).toHaveLength(1);
    expect(client.getStatus()).toBe('open');
  });

  it('on() returns an unsubscribe function', () => {
    const events: SessionEvent[] = [];
    const client = new RealtimeClient({
      url: 'wss://x/realtime',
      webSocketImpl: MockWebSocket as unknown as typeof WebSocket,
    });
    const unsub = client.on('session.ended', (e) => events.push(e));
    client.connect();
    MockWebSocket.instances[0]!.emitOpen();
    MockWebSocket.instances[0]!.emitMessage({ type: 'session.ended' });
    unsub();
    MockWebSocket.instances[0]!.emitMessage({ type: 'session.ended' });
    expect(events).toHaveLength(1);
  });
});
