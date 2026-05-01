import { describe, expect, it } from 'vitest';
import { isCommandOfType, type SessionCommand } from '../src/types/command.js';

describe('isCommandOfType', () => {
  it('narrows enqueue commands', () => {
    const cmd: SessionCommand = {
      type: 'enqueue',
      track: {
        uri: 'spotify:track:abc',
        name: 't',
        artist: 'a',
        albumArt: null,
        durationMs: 200_000,
      },
      guestId: 'g',
    };
    if (isCommandOfType(cmd, 'enqueue')) {
      expect(cmd.guestId).toBe('g');
      expect(cmd.track.uri).toBe('spotify:track:abc');
    } else {
      expect.fail('narrowing should succeed');
    }
  });

  it('narrows moderate commands', () => {
    const cmd: SessionCommand = {
      type: 'moderate',
      itemId: 'i-1',
      decision: 'approved',
      moderatedByUserId: 'u-1',
    };
    if (isCommandOfType(cmd, 'moderate')) {
      expect(cmd.decision).toBe('approved');
    } else {
      expect.fail('narrowing should succeed');
    }
  });

  it('returns false for mismatched types', () => {
    const cmd: SessionCommand = { type: 'end_session', endedByUserId: 'u' };
    expect(isCommandOfType(cmd, 'enqueue')).toBe(false);
  });
});
