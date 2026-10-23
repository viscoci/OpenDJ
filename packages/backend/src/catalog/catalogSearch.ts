/**
 * Matching and ranking for the local track catalog, shared by the in-process
 * index (`TrackCatalog`) and both catalog repositories so every path ranks
 * the same rows the same way.
 *
 * Text is compared normalised: lowercase, accents stripped, apostrophes
 * dropped, any other punctuation turned into a space, spaces collapsed. A
 * track matches when every query token is a prefix of some word of
 * "name artist". Matches rank by exact phrase (the whole normalised query
 * appears as whole words), then times requested, then times seen, then
 * most recently seen.
 */

import type { TrackCatalogRecord, TrackCatalogUpsert } from '../repositories/types.js';

/** Lowercase, strip accents and punctuation, collapse spaces. */
export function normalizeSearchText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/['’‘`´]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** A catalog record with its normalised search text, ready to match. */
export interface IndexedCatalogEntry {
  record: TrackCatalogRecord;
  /** Normalised "name artist". */
  text: string;
  words: ReadonlyArray<string>;
}

export function indexCatalogRecord(record: TrackCatalogRecord): IndexedCatalogEntry {
  const text = normalizeSearchText(`${record.trackName} ${record.artistName}`);
  return { record, text, words: text === '' ? [] : text.split(' ') };
}

/** Ranked matches for `query` among already-indexed entries, at most `limit`. */
export function matchIndexedEntries(
  entries: Iterable<IndexedCatalogEntry>,
  query: string,
  limit: number,
): TrackCatalogRecord[] {
  const phrase = normalizeSearchText(query);
  if (phrase === '' || limit < 1) return [];
  const tokens = phrase.split(' ');
  const paddedPhrase = ` ${phrase} `;

  const matches: Array<{ record: TrackCatalogRecord; exact: boolean }> = [];
  for (const entry of entries) {
    if (!tokens.every((token) => entry.words.some((word) => word.startsWith(token)))) continue;
    matches.push({ record: entry.record, exact: ` ${entry.text} `.includes(paddedPhrase) });
  }
  matches.sort(
    (a, b) =>
      Number(b.exact) - Number(a.exact) ||
      b.record.timesRequested - a.record.timesRequested ||
      b.record.timesSeen - a.record.timesSeen ||
      b.record.lastSeenAt.getTime() - a.record.lastSeenAt.getTime() ||
      compare(a.record.trackName, b.record.trackName) ||
      compare(a.record.trackUri, b.record.trackUri),
  );
  return matches.slice(0, limit).map((m) => m.record);
}

/** Ranked matches for `query` among plain records (indexes them on the fly). */
export function rankCatalogMatches(
  records: Iterable<TrackCatalogRecord>,
  query: string,
  limit: number,
): TrackCatalogRecord[] {
  const entries: IndexedCatalogEntry[] = [];
  for (const record of records) entries.push(indexCatalogRecord(record));
  return matchIndexedEntries(entries, query, limit);
}

/**
 * Fold duplicate `(providerId, trackUri)` writes in one batch into one (a
 * single SQL upsert can't touch the same row twice). Increments add up; the
 * later write's metadata wins, except a missing album art or duration never
 * replaces a known one; `seenAt` is the later of the two. First-seen order is kept.
 */
export function mergeCatalogUpserts(
  entries: ReadonlyArray<TrackCatalogUpsert>,
): TrackCatalogUpsert[] {
  const merged = new Map<string, TrackCatalogUpsert>();
  for (const entry of entries) {
    const key = catalogKey(entry.providerId, entry.trackUri);
    const prev = merged.get(key);
    if (!prev) {
      merged.set(key, { ...entry });
      continue;
    }
    merged.set(key, {
      ...entry,
      albumArtUrl: entry.albumArtUrl ?? prev.albumArtUrl,
      durationMs: entry.durationMs ?? prev.durationMs,
      seenIncrement: prev.seenIncrement + entry.seenIncrement,
      requestedIncrement: prev.requestedIncrement + entry.requestedIncrement,
      seenAt: laterOf(prev.seenAt, entry.seenAt),
    });
  }
  return [...merged.values()];
}

/** The row after applying `upsert` to `existing` (or inserting it). Same rules as the SQL upsert. */
export function applyCatalogUpsert(
  existing: TrackCatalogRecord | undefined,
  upsert: TrackCatalogUpsert,
): TrackCatalogRecord {
  return {
    providerId: upsert.providerId,
    trackUri: upsert.trackUri,
    trackName: upsert.trackName,
    artistName: upsert.artistName,
    albumArtUrl: upsert.albumArtUrl ?? existing?.albumArtUrl ?? null,
    durationMs: upsert.durationMs ?? existing?.durationMs ?? null,
    timesSeen: (existing?.timesSeen ?? 0) + upsert.seenIncrement,
    timesRequested: (existing?.timesRequested ?? 0) + upsert.requestedIncrement,
    lastSeenAt: existing ? laterOf(existing.lastSeenAt, upsert.seenAt) : upsert.seenAt,
  };
}

export function catalogKey(providerId: string, trackUri: string): string {
  return `${providerId}\u0000${trackUri}`;
}

function laterOf(a: Date, b: Date): Date {
  return b.getTime() > a.getTime() ? b : a;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
