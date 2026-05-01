import { describe, expect, it } from 'vitest';
import { generateSessionToken, hashSessionToken } from '../src/session-token.js';

describe('generateSessionToken', () => {
  it('returns a 64-char lowercase hex string (256-bit entropy)', () => {
    const token = generateSessionToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces different tokens on each call (entropy sanity)', () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      tokens.add(generateSessionToken());
    }
    expect(tokens.size).toBe(100);
  });
});

describe('hashSessionToken', () => {
  it('returns a stable SHA-256 hex digest for the same input', async () => {
    const a = await hashSessionToken('hello');
    const b = await hashSessionToken('hello');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('matches the published SHA-256 of the empty string', async () => {
    expect(await hashSessionToken('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('produces different hashes for different inputs', async () => {
    const a = await hashSessionToken('hello');
    const b = await hashSessionToken('world');
    expect(a).not.toBe(b);
  });
});
