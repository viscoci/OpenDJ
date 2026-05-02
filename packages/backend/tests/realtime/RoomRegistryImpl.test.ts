import { describe, expect, it } from 'vitest';
import { RoomRegistryImpl } from '../../src/realtime/RoomRegistryImpl.js';

describe('RoomRegistryImpl', () => {
  it('starts empty', () => {
    const registry = new RoomRegistryImpl();
    expect(registry.size()).toBe(0);
    expect(registry.forSession('sess-1')).toBeNull();
  });

  it('ensureRoom materializes a NodeSessionRoom on first call', () => {
    const registry = new RoomRegistryImpl();
    const room = registry.ensureRoom('sess-1');
    expect(room.sessionId).toBe('sess-1');
    expect(registry.size()).toBe(1);
    expect(registry.forSession('sess-1')).toBe(room);
  });

  it('ensureRoom is idempotent — second call returns the same instance', () => {
    const registry = new RoomRegistryImpl();
    const a = registry.ensureRoom('sess-1');
    const b = registry.ensureRoom('sess-1');
    expect(a).toBe(b);
    expect(registry.size()).toBe(1);
  });

  it('keeps separate rooms per sessionId', () => {
    const registry = new RoomRegistryImpl();
    const a = registry.ensureRoom('sess-1');
    const b = registry.ensureRoom('sess-2');
    expect(a).not.toBe(b);
    expect(a.sessionId).toBe('sess-1');
    expect(b.sessionId).toBe('sess-2');
    expect(registry.size()).toBe(2);
  });

  it('removeRoom drops the entry', () => {
    const registry = new RoomRegistryImpl();
    registry.ensureRoom('sess-1');
    registry.removeRoom('sess-1');
    expect(registry.size()).toBe(0);
    expect(registry.forSession('sess-1')).toBeNull();
  });

  it('removeRoom on unknown sessionId is a no-op', () => {
    const registry = new RoomRegistryImpl();
    expect(() => registry.removeRoom('nope')).not.toThrow();
  });

  it('forSession returns the same instance ensureRoom returned', () => {
    const registry = new RoomRegistryImpl();
    const ensured = registry.ensureRoom('sess-1');
    const fetched = registry.forSession('sess-1');
    expect(fetched).toBe(ensured);
  });
});
