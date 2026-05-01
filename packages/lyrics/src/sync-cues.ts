import type { PredictedPlaybackPosition, SyncCue } from '@opendj/sync';
import type { LyricsDocument, LyricsLine } from './types.js';

/**
 * Convert a synced LyricsDocument's lines into SyncCue payloads with
 * `kind: 'lyric'`. Lines without a startsAtMs are dropped — there's nothing
 * useful to render in time. Returns an empty array for unsynced documents.
 */
export function lyricsDocumentToSyncCues(document: LyricsDocument): Array<SyncCue<LyricsLine>> {
  if (!document.isSynced) return [];
  const cues: Array<SyncCue<LyricsLine>> = [];
  for (const line of document.lines) {
    if (line.startsAtMs === undefined) continue;
    const cue: SyncCue<LyricsLine> = {
      id: line.id,
      startsAtMs: line.startsAtMs,
      kind: 'lyric',
      payload: line,
    };
    if (line.endsAtMs !== undefined) {
      cue.endsAtMs = line.endsAtMs;
    }
    cues.push(cue);
  }
  return cues;
}

/**
 * Compute the active lyric line plus a window of previous/upcoming lines for
 * the current playback position.
 *
 * Useful for the TV/live view: typically `previousCount=1, nextCount=2` shows
 * the previous line, the active line (highlighted), and the next two coming up.
 *
 * Returns lines in chronological order. Empty array if the document is unsynced
 * or there are no synced lines.
 */
export function getActiveLyricWindow(
  position: PredictedPlaybackPosition,
  lyrics: LyricsDocument,
  previousCount = 1,
  nextCount = 2,
): LyricsLine[] {
  if (!lyrics.isSynced) return [];

  const synced = lyrics.lines.filter((l): l is LyricsLine & { startsAtMs: number } => {
    return l.startsAtMs !== undefined;
  });
  if (synced.length === 0) return [];

  // Find the index of the active line (last line whose startsAtMs <= position).
  let activeIndex = -1;
  for (let i = 0; i < synced.length; i += 1) {
    const line = synced[i]!;
    if (line.startsAtMs <= position.progressMs) {
      activeIndex = i;
    } else {
      break;
    }
  }

  // Before the first line: still show upcoming context, no previous.
  if (activeIndex === -1) {
    return synced.slice(0, Math.max(0, nextCount));
  }

  const start = Math.max(0, activeIndex - Math.max(0, previousCount));
  const end = Math.min(synced.length, activeIndex + 1 + Math.max(0, nextCount));
  return synced.slice(start, end);
}
