import { describe, expect, it } from 'vitest';
import { clamp, normalizeProgress } from '../src/normalize.js';

describe('clamp', () => {
  it('returns the value when within range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  it('clamps below the minimum', () => {
    expect(clamp(-3, 0, 10)).toBe(0);
  });

  it('clamps above the maximum', () => {
    expect(clamp(15, 0, 10)).toBe(10);
  });

  it('returns min when min == max == value', () => {
    expect(clamp(5, 5, 5)).toBe(5);
  });
});

describe('normalizeProgress', () => {
  it('returns 0..1 for a normal track', () => {
    expect(normalizeProgress(0, 200_000)).toBe(0);
    expect(normalizeProgress(100_000, 200_000)).toBe(0.5);
    expect(normalizeProgress(200_000, 200_000)).toBe(1);
  });

  it('clamps to 1 when progress exceeds duration', () => {
    expect(normalizeProgress(300_000, 200_000)).toBe(1);
  });

  it('clamps to 0 for negative progress', () => {
    expect(normalizeProgress(-100, 200_000)).toBe(0);
  });

  it('returns 0 for durationMs === 0 (avoid divide-by-zero)', () => {
    expect(normalizeProgress(0, 0)).toBe(0);
    expect(normalizeProgress(1000, 0)).toBe(0);
  });

  it('returns 0 for negative durationMs', () => {
    expect(normalizeProgress(1000, -5)).toBe(0);
  });

  it('returns 0 for non-finite progress', () => {
    expect(normalizeProgress(Infinity, 100)).toBe(0);
    expect(normalizeProgress(NaN, 100)).toBe(0);
  });
});
