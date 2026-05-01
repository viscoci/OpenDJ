import { describe, expect, it } from 'vitest';
import { dedupeQueue } from '../../src/queue/dedupeQueue.js';
import { makeItem } from '../helpers/fixtures.js';

describe('dedupeQueue', () => {
  it('keeps only the first occurrence of each trackUri among non-rejected items', () => {
    const items = [
      makeItem({ id: 'a', trackUri: 'spotify:track:1', status: 'pending' }),
      makeItem({ id: 'b', trackUri: 'spotify:track:1', status: 'pending' }),
      makeItem({ id: 'c', trackUri: 'spotify:track:2', status: 'pending' }),
    ];
    const result = dedupeQueue(items);
    expect(result.map((i) => i.id)).toEqual(['a', 'c']);
  });

  it('preserves input order', () => {
    const items = [
      makeItem({ id: 'a', trackUri: 'spotify:track:1' }),
      makeItem({ id: 'b', trackUri: 'spotify:track:2' }),
      makeItem({ id: 'c', trackUri: 'spotify:track:3' }),
      makeItem({ id: 'd', trackUri: 'spotify:track:1' }),
    ];
    const result = dedupeQueue(items);
    expect(result.map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('keeps rejected items even if their trackUri appeared earlier', () => {
    const items = [
      makeItem({ id: 'a', trackUri: 'spotify:track:1', status: 'pending' }),
      makeItem({ id: 'b', trackUri: 'spotify:track:1', status: 'rejected' }),
    ];
    const result = dedupeQueue(items);
    expect(result.map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('keeps multiple rejected items with the same trackUri', () => {
    const items = [
      makeItem({ id: 'a', trackUri: 'spotify:track:1', status: 'rejected' }),
      makeItem({ id: 'b', trackUri: 'spotify:track:1', status: 'rejected' }),
    ];
    const result = dedupeQueue(items);
    expect(result.map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('does not let a rejected item shadow a later live item with same uri', () => {
    const items = [
      makeItem({ id: 'a', trackUri: 'spotify:track:1', status: 'rejected' }),
      makeItem({ id: 'b', trackUri: 'spotify:track:1', status: 'pending' }),
    ];
    const result = dedupeQueue(items);
    expect(result.map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('returns an empty list for empty input', () => {
    expect(dedupeQueue([])).toEqual([]);
  });

  it('does not mutate the input', () => {
    const items = [
      makeItem({ id: 'a', trackUri: 'spotify:track:1' }),
      makeItem({ id: 'b', trackUri: 'spotify:track:1' }),
    ];
    const before = items.length;
    dedupeQueue(items);
    expect(items.length).toBe(before);
  });
});
