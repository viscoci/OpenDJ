import { describe, expect, it } from 'vitest';
import { LyricsApi } from '../../src/api/lyrics.js';

describe('LyricsApi.lookup', () => {
  it('queries by trackName/artistName and unwraps the match field', async () => {
    const calls: Array<{ path: string; query: unknown }> = [];
    const doc = { id: 'x', source: 'lrclib', isSynced: true, lines: [] };
    const http = {
      request: (path: string, opts: { query?: unknown }) => {
        calls.push({ path, query: opts?.query });
        return Promise.resolve({ match: doc });
      },
    };
    const api = new LyricsApi(http as never);
    const res = await api.lookup({ trackName: 'A', artistName: 'B', durationMs: 200000 });
    expect(calls[0]!.path).toBe('/api/v1/lyrics/lookup');
    expect(calls[0]!.query).toMatchObject({ trackName: 'A', artistName: 'B', durationMs: 200000 });
    expect(res).toBe(doc);
  });

  it('returns null when the backend reports no match', async () => {
    const http = { request: () => Promise.resolve({ match: null }) };
    const api = new LyricsApi(http as never);
    expect(await api.lookup({ trackName: 'A', artistName: 'B' })).toBeNull();
  });
});
