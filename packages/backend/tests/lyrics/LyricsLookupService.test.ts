import { describe, expect, it, vi } from 'vitest';
import type { LyricsDocument, LyricsProvider } from '@opendj/lyrics';
import { LyricsLookupService } from '../../src/lyrics/LyricsLookupService.js';
import {
  InMemoryLyricsCacheRepository,
  InMemoryLyricsFeedbackRepository,
} from '../../src/repositories/in-memory/index.js';

const NOW = new Date('2026-04-30T12:00:00Z').getTime();

function fakeProvider(impl: {
  getBestMatch?: (input: {
    trackName: string;
    artistName: string;
  }) => Promise<LyricsDocument | null>;
}): LyricsProvider {
  return {
    providerId: 'lrclib',
    search: vi.fn(async () => []),
    getBestMatch: vi.fn(impl.getBestMatch ?? (async () => null)),
  };
}

const SAMPLE_DOC: LyricsDocument = {
  id: 'lrclib:1',
  source: 'lrclib',
  providerLyricsId: 1,
  trackName: 'Hello',
  artistName: 'World',
  isSynced: true,
  lines: [{ id: 'l-0', text: 'hello', startsAtMs: 1000 }],
  rawLrc: '[00:01.00]hello',
  attribution: 'Lyrics from LRCLIB',
  matchConfidence: 'high',
};

function setup(provider: LyricsProvider) {
  const clock = { now: () => new Date(NOW) };
  const cache = new InMemoryLyricsCacheRepository(clock);
  const feedback = new InMemoryLyricsFeedbackRepository(clock);
  const service = new LyricsLookupService({
    provider,
    cache,
    feedback,
    nowEpochMs: () => NOW,
  });
  return { service, cache, feedback, provider };
}

describe('LyricsLookupService.lookup — cache miss', () => {
  it('calls the provider, persists the result, returns it', async () => {
    const provider = fakeProvider({ getBestMatch: async () => SAMPLE_DOC });
    const { service, cache } = setup(provider);
    const out = await service.lookup({ trackName: 'Hello', artistName: 'World' });
    expect(out?.id).toBe('lrclib:1');
    expect(cache.rows.size).toBe(1);
    const row = [...cache.rows.values()][0]!;
    expect(row.isSynced).toBe(true);
    expect(row.syncedLrc).toBe('[00:01.00]hello');
    expect(row.lastUsedAt?.getTime()).toBe(NOW);
  });

  it('persists a negative result when provider returns null', async () => {
    const provider = fakeProvider({ getBestMatch: async () => null });
    const { service, cache } = setup(provider);
    const out = await service.lookup({ trackName: 'Hello', artistName: 'World' });
    expect(out).toBeNull();
    expect(cache.rows.size).toBe(1);
    const row = [...cache.rows.values()][0]!;
    expect(row.isSynced).toBe(false);
    expect(row.syncedLrc).toBeNull();
    expect(row.matchConfidence).toBe('low');
  });

  it('returns null silently when the provider throws', async () => {
    const provider = fakeProvider({
      getBestMatch: async () => {
        throw new Error('network down');
      },
    });
    const { service, cache } = setup(provider);
    const out = await service.lookup({ trackName: 'X', artistName: 'Y' });
    expect(out).toBeNull();
    // Provider errors do NOT poison the cache — next call retries.
    expect(cache.rows.size).toBe(0);
  });
});

describe('LyricsLookupService.lookup — cache hit', () => {
  it('does NOT call the provider on subsequent identical lookups', async () => {
    const provider = fakeProvider({ getBestMatch: async () => SAMPLE_DOC });
    const { service } = setup(provider);
    await service.lookup({ trackName: 'Hello', artistName: 'World' });
    await service.lookup({ trackName: 'Hello', artistName: 'World' });
    expect(provider.getBestMatch).toHaveBeenCalledTimes(1);
  });

  it('uses the same cache key for normalization-equivalent inputs', async () => {
    const provider = fakeProvider({ getBestMatch: async () => SAMPLE_DOC });
    const { service } = setup(provider);
    await service.lookup({ trackName: 'Hello (Remastered 2011)', artistName: 'WORLD' });
    await service.lookup({ trackName: 'hello', artistName: 'world' });
    expect(provider.getBestMatch).toHaveBeenCalledTimes(1);
  });

  it('returns null when the cached entry is suppressed', async () => {
    const provider = fakeProvider({ getBestMatch: async () => SAMPLE_DOC });
    const { service, cache } = setup(provider);
    await service.lookup({ trackName: 'Hello', artistName: 'World' });
    const row = [...cache.rows.values()][0]!;
    await cache.suppress(row.id, 'manual', NOW);
    const fresh = await service.lookup({ trackName: 'Hello', artistName: 'World' });
    expect(fresh).toBeNull();
  });
});

describe('LyricsLookupService.recordFeedback', () => {
  it('persists a feedback row', async () => {
    const provider = fakeProvider({});
    const { service, feedback } = setup(provider);
    await service.recordFeedback({
      kind: 'wrong_song',
      sessionId: 'sess-1',
      lyricsDocumentId: 'doc-1',
    });
    expect(feedback.rows).toHaveLength(1);
    expect(feedback.rows[0]?.kind).toBe('wrong_song');
  });

  it('auto-suppresses the cache entry after 3 wrong_song reports', async () => {
    const provider = fakeProvider({ getBestMatch: async () => SAMPLE_DOC });
    const { service, cache } = setup(provider);
    await service.lookup({ trackName: 'Hello', artistName: 'World' });
    const cacheId = [...cache.rows.values()][0]!.id;

    await service.recordFeedback({ kind: 'wrong_song', lyricsDocumentId: cacheId });
    await service.recordFeedback({ kind: 'wrong_song', lyricsDocumentId: cacheId });
    expect([...cache.rows.values()][0]!.suppressedAt).toBeNull();

    await service.recordFeedback({ kind: 'wrong_song', lyricsDocumentId: cacheId });
    expect([...cache.rows.values()][0]!.suppressedAt).not.toBeNull();
    expect([...cache.rows.values()][0]!.suppressedReason).toBe('auto:wrong_song');
  });

  it('does NOT auto-suppress for kinds outside the suppression set', async () => {
    const provider = fakeProvider({ getBestMatch: async () => SAMPLE_DOC });
    const { service, cache } = setup(provider);
    await service.lookup({ trackName: 'Hello', artistName: 'World' });
    const cacheId = [...cache.rows.values()][0]!.id;
    for (let i = 0; i < 5; i += 1) {
      await service.recordFeedback({ kind: 'missing_lyrics', lyricsDocumentId: cacheId });
    }
    expect([...cache.rows.values()][0]!.suppressedAt).toBeNull();
  });

  it('counts only the matching kind for the auto-suppression threshold', async () => {
    const provider = fakeProvider({ getBestMatch: async () => SAMPLE_DOC });
    const { service, cache } = setup(provider);
    await service.lookup({ trackName: 'Hello', artistName: 'World' });
    const cacheId = [...cache.rows.values()][0]!.id;

    // 2 of one kind + 2 of another — neither hits the 3-threshold individually
    await service.recordFeedback({ kind: 'wrong_song', lyricsDocumentId: cacheId });
    await service.recordFeedback({ kind: 'wrong_song', lyricsDocumentId: cacheId });
    await service.recordFeedback({ kind: 'bad_timing', lyricsDocumentId: cacheId });
    await service.recordFeedback({ kind: 'bad_timing', lyricsDocumentId: cacheId });
    expect([...cache.rows.values()][0]!.suppressedAt).toBeNull();
  });
});
