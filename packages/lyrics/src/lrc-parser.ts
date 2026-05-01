import type { LyricsLine } from './types.js';

/**
 * Parse an LRC-formatted string into LyricsLine[].
 *
 * Supported:
 * - `[mm:ss]`, `[mm:ss.xx]`, `[mm:ss.xxx]` timestamps
 * - Multiple timestamps on one line (`[00:01.00][00:05.00]Same line text`)
 * - LRC metadata tags (`[ar:Artist]`, `[ti:Title]`, `[al:Album]`, `[length:mm:ss]`,
 *   `[by:author]`, `[offset:ms]`) — recognized and skipped
 *
 * Rules:
 * - Lines are sorted ascending by startsAtMs
 * - Each line's `endsAtMs` is set to the next line's `startsAtMs`; the last
 *   line is left open-ended
 * - Empty lyric text is preserved (LRC files use it as visible silence)
 * - Lines with no timestamp tag are skipped
 */

const TIMESTAMP_TAG = /\[(\d{1,3}):([0-5]?\d)(?:[.:](\d{1,3}))?\]/g;

const METADATA_TAGS = new Set(['ar', 'ti', 'al', 'au', 'by', 'length', 'offset', 're', 've']);

function parseTimestamp(min: string, sec: string, frac?: string): number {
  const m = Number.parseInt(min, 10);
  const s = Number.parseInt(sec, 10);
  let ms = 0;
  if (frac !== undefined && frac.length > 0) {
    // LRC fraction may be 1-3 digits; treat as left-aligned decimal
    const padded = frac.padEnd(3, '0').slice(0, 3);
    ms = Number.parseInt(padded, 10);
  }
  return m * 60_000 + s * 1_000 + ms;
}

interface ParsedRow {
  startsAtMs: number;
  text: string;
}

function isMetadataLine(line: string): boolean {
  // Match exactly one bracketed token; treat as metadata if its prefix before ':' is a known tag
  const match = /^\[([a-z]{1,8}):/i.exec(line);
  return match !== null && METADATA_TAGS.has(match[1]!.toLowerCase());
}

export function parseLrc(raw: string): LyricsLine[] {
  const rows: ParsedRow[] = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.length === 0) continue;
    if (isMetadataLine(line)) continue;

    const stamps: number[] = [];
    let lastIndex = 0;
    TIMESTAMP_TAG.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TIMESTAMP_TAG.exec(line)) !== null) {
      stamps.push(parseTimestamp(m[1]!, m[2]!, m[3]));
      lastIndex = TIMESTAMP_TAG.lastIndex;
    }
    if (stamps.length === 0) continue;
    const text = line.slice(lastIndex).trimStart();
    for (const startsAtMs of stamps) {
      rows.push({ startsAtMs, text });
    }
  }

  rows.sort((a, b) => a.startsAtMs - b.startsAtMs);

  const lines: LyricsLine[] = rows.map((row, index) => {
    const next = rows[index + 1];
    const line: LyricsLine = {
      id: `line-${index}`,
      text: row.text,
      startsAtMs: row.startsAtMs,
    };
    if (next) {
      line.endsAtMs = next.startsAtMs;
    }
    return line;
  });

  return lines;
}
