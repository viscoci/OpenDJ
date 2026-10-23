import { describe, expect, it } from 'vitest';
import { bearerFromAuthHeader } from '../../src/routes/bearer.js';

describe('bearerFromAuthHeader', () => {
  it.each([
    [undefined, null],
    ['', null],
    ['Basic abc', null],
    ['Bearer', null],
    ['Bearer abc', 'abc'],
    ['bearer   tok-1  ', 'tok-1'],
    ['BEARER x y', 'x y'],
  ])('parses %j as %j', (header, expected) => {
    expect(bearerFromAuthHeader(header)).toBe(expected);
  });
});
