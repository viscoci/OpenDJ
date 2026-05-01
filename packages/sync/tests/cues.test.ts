import { describe, expect, it } from 'vitest';
import { findActiveCues, findUpcomingCues } from '../src/cues.js';
import type { SyncCue } from '../src/types.js';

function cue(
  id: string,
  startsAtMs: number,
  endsAtMs?: number,
  kind: SyncCue['kind'] = 'lyric',
): SyncCue {
  return endsAtMs !== undefined
    ? { id, startsAtMs, endsAtMs, kind, payload: null }
    : { id, startsAtMs, kind, payload: null };
}

describe('findActiveCues', () => {
  it('returns cues whose [start, end) brackets the position', () => {
    const cues = [cue('a', 0, 1000), cue('b', 1000, 2000), cue('c', 2000, 3000)];
    expect(findActiveCues(1500, cues).map((c) => c.id)).toEqual(['b']);
  });

  it('treats start as inclusive and end as exclusive', () => {
    const cues = [cue('a', 1000, 2000)];
    expect(findActiveCues(1000, cues).map((c) => c.id)).toEqual(['a']);
    expect(findActiveCues(2000, cues)).toEqual([]);
  });

  it('keeps open-ended cues (no endsAtMs) active forever after start', () => {
    const cues = [cue('a', 1000)];
    expect(findActiveCues(1000, cues).map((c) => c.id)).toEqual(['a']);
    expect(findActiveCues(999_999, cues).map((c) => c.id)).toEqual(['a']);
  });

  it('returns multiple overlapping cues in input order', () => {
    const cues = [cue('lyric', 1000, 5000, 'lyric'), cue('light', 1500, 4500, 'lighting')];
    expect(findActiveCues(2000, cues).map((c) => c.id)).toEqual(['lyric', 'light']);
  });

  it('returns empty list before the first cue', () => {
    const cues = [cue('a', 1000, 2000)];
    expect(findActiveCues(500, cues)).toEqual([]);
  });

  it('returns empty list for empty cue array', () => {
    expect(findActiveCues(0, [])).toEqual([]);
  });
});

describe('findUpcomingCues', () => {
  it('returns cues that start within (positionMs, positionMs + windowMs)', () => {
    const cues = [cue('a', 1000), cue('b', 1500), cue('c', 5000)];
    expect(findUpcomingCues(900, cues, 2000).map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('excludes cues that have already started', () => {
    const cues = [cue('a', 500), cue('b', 1500)];
    expect(findUpcomingCues(1000, cues, 5000).map((c) => c.id)).toEqual(['b']);
  });

  it('excludes the boundary at positionMs (start strictly > positionMs)', () => {
    const cues = [cue('a', 1000), cue('b', 1001)];
    expect(findUpcomingCues(1000, cues, 5000).map((c) => c.id)).toEqual(['b']);
  });

  it('excludes the boundary at horizon (start strictly < horizon)', () => {
    const cues = [cue('a', 2000), cue('b', 3000)];
    expect(findUpcomingCues(1000, cues, 2000).map((c) => c.id)).toEqual(['a']);
  });

  it('returns empty list when window is 0 or negative', () => {
    const cues = [cue('a', 1100)];
    expect(findUpcomingCues(1000, cues, 0)).toEqual([]);
    expect(findUpcomingCues(1000, cues, -100)).toEqual([]);
  });
});
