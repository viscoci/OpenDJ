import { describe, expect, it } from 'vitest';
import { constantTimeEqual, detectHashAlgorithm } from '../src/password.js';

describe('detectHashAlgorithm', () => {
  it('extracts argon2id', () => {
    expect(detectHashAlgorithm('$argon2id$v=19$m=65536,t=3,p=4$salt$hash')).toBe('argon2id');
  });

  it('extracts argon2i / argon2d', () => {
    expect(detectHashAlgorithm('$argon2i$v=19$...')).toBe('argon2i');
    expect(detectHashAlgorithm('$argon2d$v=19$...')).toBe('argon2d');
  });

  it('extracts bcrypt 2y / 2b / 2a variants', () => {
    expect(detectHashAlgorithm('$2y$10$...')).toBe('2y');
    expect(detectHashAlgorithm('$2b$10$...')).toBe('2b');
    expect(detectHashAlgorithm('$2a$10$...')).toBe('2a');
  });

  it('lowercases the result', () => {
    expect(detectHashAlgorithm('$ARGON2ID$...')).toBe('argon2id');
  });

  it('returns null for unrecognized formats', () => {
    expect(detectHashAlgorithm('plain-text-hash')).toBeNull();
    expect(detectHashAlgorithm('')).toBeNull();
    expect(detectHashAlgorithm('$$bad')).toBeNull();
  });
});

describe('constantTimeEqual', () => {
  it('returns true for identical strings', () => {
    expect(constantTimeEqual('abc123', 'abc123')).toBe(true);
  });

  it('returns false for different strings of the same length', () => {
    expect(constantTimeEqual('abc123', 'abc124')).toBe(false);
  });

  it('returns false for different lengths', () => {
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('', 'a')).toBe(false);
  });

  it('returns true for two empty strings', () => {
    expect(constantTimeEqual('', '')).toBe(true);
  });
});
