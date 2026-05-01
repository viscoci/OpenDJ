import { describe, expect, it } from 'vitest';
import { lookupCacheKey, normalizeLookup } from '../src/lookup-key.js';

describe('normalizeLookup', () => {
  it('lowercases and trims track + artist', () => {
    const n = normalizeLookup({ trackName: '  Hello World  ', artistName: 'BAND' });
    expect(n.trackName).toBe('hello world');
    expect(n.artistName).toBe('band');
  });

  it('collapses whitespace + underscores to single spaces', () => {
    const n = normalizeLookup({ trackName: 'hello\t\tworld_song', artistName: 'a b' });
    expect(n.trackName).toBe('hello world song');
  });

  it('strips (feat. ...) noise', () => {
    const n = normalizeLookup({ trackName: 'Song (feat. Other Artist)', artistName: 'X' });
    expect(n.trackName).toBe('song');
  });

  it('strips remaster/live/remix tags', () => {
    expect(
      normalizeLookup({ trackName: 'Song (Remastered 2011)', artistName: 'X' }).trackName,
    ).toBe('song');
    expect(normalizeLookup({ trackName: 'Song (2011 Remaster)', artistName: 'X' }).trackName).toBe(
      'song',
    );
    expect(normalizeLookup({ trackName: 'Song [Live]', artistName: 'X' }).trackName).toBe('song');
    expect(normalizeLookup({ trackName: 'Song (Remix)', artistName: 'X' }).trackName).toBe('song');
  });

  it('replaces curly quotes with ASCII apostrophes', () => {
    const n = normalizeLookup({ trackName: 'don’t', artistName: 'x' });
    expect(n.trackName).toBe("don't");
  });

  it('strips leading/trailing punctuation', () => {
    expect(normalizeLookup({ trackName: '!!Song!!', artistName: 'x' }).trackName).toBe('song');
  });

  it('rounds duration to seconds', () => {
    expect(
      normalizeLookup({ trackName: 'a', artistName: 'b', durationMs: 200_400 }).durationSeconds,
    ).toBe(200);
    expect(
      normalizeLookup({ trackName: 'a', artistName: 'b', durationMs: 200_500 }).durationSeconds,
    ).toBe(201);
  });

  it('returns null durationSeconds for missing/invalid duration', () => {
    expect(normalizeLookup({ trackName: 'a', artistName: 'b' }).durationSeconds).toBeNull();
    expect(
      normalizeLookup({ trackName: 'a', artistName: 'b', durationMs: 0 }).durationSeconds,
    ).toBeNull();
    expect(
      normalizeLookup({ trackName: 'a', artistName: 'b', durationMs: -100 }).durationSeconds,
    ).toBeNull();
  });

  it('uppercases ISRC', () => {
    const n = normalizeLookup({ trackName: 'a', artistName: 'b', isrc: 'usrc12345678' });
    expect(n.isrc).toBe('USRC12345678');
  });

  it('preserves providerTrackUri verbatim (case + punctuation)', () => {
    const n = normalizeLookup({
      trackName: 'a',
      artistName: 'b',
      providerTrackUri: 'spotify:track:ABC',
    });
    expect(n.providerTrackUri).toBe('spotify:track:ABC');
  });
});

describe('lookupCacheKey', () => {
  it('produces stable, deterministic keys', () => {
    const k1 = lookupCacheKey(normalizeLookup({ trackName: 'Hello', artistName: 'World' }));
    const k2 = lookupCacheKey(normalizeLookup({ trackName: 'hello', artistName: 'world' }));
    expect(k1).toBe(k2);
  });

  it('keys differ when track names differ', () => {
    const k1 = lookupCacheKey(normalizeLookup({ trackName: 'a', artistName: 'x' }));
    const k2 = lookupCacheKey(normalizeLookup({ trackName: 'b', artistName: 'x' }));
    expect(k1).not.toBe(k2);
  });

  it('does not include providerTrackUri (cross-provider cache hits)', () => {
    const a = lookupCacheKey(
      normalizeLookup({ trackName: 'a', artistName: 'b', providerTrackUri: 'spotify:track:1' }),
    );
    const b = lookupCacheKey(
      normalizeLookup({ trackName: 'a', artistName: 'b', providerTrackUri: 'apple:song:2' }),
    );
    expect(a).toBe(b);
  });
});
