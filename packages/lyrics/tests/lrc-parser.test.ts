import { describe, expect, it } from 'vitest';
import { parseLrc } from '../src/lrc-parser.js';

describe('parseLrc', () => {
  it('parses minimal mm:ss timestamps', () => {
    const out = parseLrc(`
[00:01]first
[00:03]second
`);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ text: 'first', startsAtMs: 1000 });
    expect(out[1]).toMatchObject({ text: 'second', startsAtMs: 3000 });
  });

  it('parses centisecond fractions ([mm:ss.xx])', () => {
    const out = parseLrc('[00:01.50]half');
    expect(out[0]?.startsAtMs).toBe(1500);
  });

  it('parses millisecond fractions ([mm:ss.xxx])', () => {
    const out = parseLrc('[00:01.234]ms');
    expect(out[0]?.startsAtMs).toBe(1234);
  });

  it('left-aligns 1-digit fraction (e.g. .5 -> 500ms)', () => {
    const out = parseLrc('[00:01.5]half');
    expect(out[0]?.startsAtMs).toBe(1500);
  });

  it('handles multiple timestamps on one line (repeats)', () => {
    const out = parseLrc('[00:01.000][00:05.000]repeat');
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ text: 'repeat', startsAtMs: 1000 });
    expect(out[1]).toMatchObject({ text: 'repeat', startsAtMs: 5000 });
  });

  it('sorts lines ascending by startsAtMs', () => {
    const out = parseLrc(`
[00:05]later
[00:01]earlier
`);
    expect(out.map((l) => l.startsAtMs)).toEqual([1000, 5000]);
  });

  it('sets endsAtMs to next line startsAtMs', () => {
    const out = parseLrc(`
[00:01]a
[00:03]b
[00:05]c
`);
    expect(out[0]?.endsAtMs).toBe(3000);
    expect(out[1]?.endsAtMs).toBe(5000);
    expect(out[2]?.endsAtMs).toBeUndefined();
  });

  it('skips metadata tags', () => {
    const out = parseLrc(`
[ar:Test Artist]
[ti:Test Title]
[al:Test Album]
[length:03:30]
[by:OpenDJ Tests]
[offset:0]
[00:01]actual line
`);
    expect(out).toHaveLength(1);
    expect(out[0]?.text).toBe('actual line');
  });

  it('skips lines with no timestamp', () => {
    const out = parseLrc(`
just plain text
[00:01]timed line
also plain
`);
    expect(out).toHaveLength(1);
    expect(out[0]?.text).toBe('timed line');
  });

  it('preserves empty lyric text (silence beats)', () => {
    const out = parseLrc(`
[00:01]a
[00:03]
[00:05]b
`);
    expect(out).toHaveLength(3);
    expect(out[1]?.text).toBe('');
  });

  it('returns empty array for empty input', () => {
    expect(parseLrc('')).toEqual([]);
    expect(parseLrc('   \n  \n')).toEqual([]);
  });

  it('assigns sequential ids', () => {
    const out = parseLrc(`
[00:01]a
[00:03]b
`);
    expect(out.map((l) => l.id)).toEqual(['line-0', 'line-1']);
  });
});
