import { describe, expect, it } from 'vitest';
import type { PredictedPlaybackPosition } from '@opendj/sync';
import { getActiveLyricWindow, lyricsDocumentToSyncCues } from '../src/sync-cues.js';
import type { LyricsDocument, LyricsLine } from '../src/types.js';

function syncedDocument(lines: LyricsLine[]): LyricsDocument {
  return {
    id: 'lrclib:1',
    source: 'lrclib',
    trackName: 't',
    artistName: 'a',
    isSynced: true,
    lines,
    matchConfidence: 'high',
  };
}

function position(progressMs: number): PredictedPlaybackPosition {
  return {
    trackUri: 'spotify:track:abc',
    progressMs,
    normalizedProgress: 0,
    remainingMs: 0,
    isPlaying: true,
    confidence: 'high',
    predictedAtEpochMs: 0,
  };
}

describe('lyricsDocumentToSyncCues', () => {
  it('returns empty list for unsynced documents', () => {
    const doc: LyricsDocument = {
      id: 'x',
      source: 'lrclib',
      trackName: 't',
      artistName: 'a',
      isSynced: false,
      lines: [{ id: 'l-0', text: 'plain only' }],
      matchConfidence: 'low',
    };
    expect(lyricsDocumentToSyncCues(doc)).toEqual([]);
  });

  it('skips lines without startsAtMs', () => {
    const doc = syncedDocument([
      { id: 'l-0', text: 'no time' },
      { id: 'l-1', text: 'timed', startsAtMs: 1000 },
    ]);
    const cues = lyricsDocumentToSyncCues(doc);
    expect(cues.map((c) => c.id)).toEqual(['l-1']);
  });

  it('preserves endsAtMs when present', () => {
    const doc = syncedDocument([{ id: 'l-0', text: 'a', startsAtMs: 1000, endsAtMs: 2000 }]);
    expect(lyricsDocumentToSyncCues(doc)[0]).toMatchObject({
      id: 'l-0',
      startsAtMs: 1000,
      endsAtMs: 2000,
      kind: 'lyric',
    });
  });

  it('omits endsAtMs when absent', () => {
    const doc = syncedDocument([{ id: 'l-0', text: 'a', startsAtMs: 1000 }]);
    expect(lyricsDocumentToSyncCues(doc)[0]?.endsAtMs).toBeUndefined();
  });

  it('attaches the original LyricsLine as payload', () => {
    const line: LyricsLine = { id: 'l-0', text: 'hello', startsAtMs: 1000 };
    const cue = lyricsDocumentToSyncCues(syncedDocument([line]))[0];
    expect(cue?.payload).toBe(line);
    expect(cue?.kind).toBe('lyric');
  });
});

describe('getActiveLyricWindow', () => {
  const lines: LyricsLine[] = [
    { id: 'l-0', text: 'one', startsAtMs: 1000 },
    { id: 'l-1', text: 'two', startsAtMs: 2000 },
    { id: 'l-2', text: 'three', startsAtMs: 3000 },
    { id: 'l-3', text: 'four', startsAtMs: 4000 },
    { id: 'l-4', text: 'five', startsAtMs: 5000 },
  ];

  it('returns empty for unsynced documents', () => {
    const doc: LyricsDocument = {
      id: 'x',
      source: 'lrclib',
      trackName: 't',
      artistName: 'a',
      isSynced: false,
      lines,
      matchConfidence: 'low',
    };
    expect(getActiveLyricWindow(position(2500), doc)).toEqual([]);
  });

  it('returns prev=1 + active + next=2 by default', () => {
    const doc = syncedDocument(lines);
    const out = getActiveLyricWindow(position(3500), doc);
    expect(out.map((l) => l.id)).toEqual(['l-1', 'l-2', 'l-3', 'l-4']);
  });

  it('clamps the window at the start of the document', () => {
    const doc = syncedDocument(lines);
    const out = getActiveLyricWindow(position(1500), doc);
    expect(out.map((l) => l.id)).toEqual(['l-0', 'l-1', 'l-2']);
  });

  it('clamps the window at the end of the document', () => {
    const doc = syncedDocument(lines);
    const out = getActiveLyricWindow(position(5500), doc);
    expect(out.map((l) => l.id)).toEqual(['l-3', 'l-4']);
  });

  it('before the first line, returns up to next N upcoming lines', () => {
    const doc = syncedDocument(lines);
    const out = getActiveLyricWindow(position(500), doc, 1, 2);
    expect(out.map((l) => l.id)).toEqual(['l-0', 'l-1']);
  });

  it('respects custom previousCount/nextCount', () => {
    const doc = syncedDocument(lines);
    const out = getActiveLyricWindow(position(3500), doc, 2, 1);
    expect(out.map((l) => l.id)).toEqual(['l-0', 'l-1', 'l-2', 'l-3']);
  });

  it('drops lines without startsAtMs', () => {
    const mixed: LyricsLine[] = [
      { id: 'l-0', text: 'no time' },
      { id: 'l-1', text: 'one', startsAtMs: 1000 },
      { id: 'l-2', text: 'two', startsAtMs: 2000 },
    ];
    const doc = syncedDocument(mixed);
    const out = getActiveLyricWindow(position(1500), doc, 1, 1);
    expect(out.map((l) => l.id)).toEqual(['l-1', 'l-2']);
  });
});
