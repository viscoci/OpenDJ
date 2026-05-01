import type { LyricsLookupInput } from './types.js';

/**
 * Normalize lookup input into a stable, lowercased, whitespace-collapsed
 * representation used as a cache key.
 *
 * Normalization rules:
 * - Lowercase
 * - Strip leading/trailing whitespace
 * - Collapse internal whitespace runs to single spaces
 * - Drop common parenthetical noise: "(feat. ...)", "(remastered ...)", "[Live]"
 * - Replace curly/typographic quotes with ASCII
 * - Remove leading/trailing punctuation
 *
 * Duration is bucketed to the nearest second (lossy) since LRCLIB matches by
 * duration with ±2s tolerance and we want the cache to hit across small drift.
 */
export interface NormalizedLookup {
  trackName: string;
  artistName: string;
  albumName: string | null;
  /** Duration rounded to seconds; null when not provided. */
  durationSeconds: number | null;
  isrc: string | null;
  providerTrackUri: string | null;
}

const NOISE_PATTERNS = [
  /\(\s*feat\.?\s+[^)]*\)/gi,
  /\(\s*ft\.?\s+[^)]*\)/gi,
  /\(\s*featuring\s+[^)]*\)/gi,
  /\(\s*with\s+[^)]*\)/gi,
  /\(\s*remaster(?:ed)?(?:\s+\d{4})?\s*\)/gi,
  /\(\s*\d{4}\s*remaster(?:ed)?\s*\)/gi,
  /\(\s*live\s*\)/gi,
  /\(\s*remix\s*\)/gi,
  /\[\s*live\s*\]/gi,
  /\[\s*remaster(?:ed)?(?:\s+\d{4})?\s*\]/gi,
];

const CURLY_QUOTES = /[‘’“”]/g;

function normalizeText(value: string): string {
  let out = value.toLowerCase().replace(CURLY_QUOTES, "'");
  for (const pattern of NOISE_PATTERNS) {
    out = out.replace(pattern, ' ');
  }
  out = out.replace(/[\s_]+/g, ' ');
  out = out.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  return out;
}

export function normalizeLookup(input: LyricsLookupInput): NormalizedLookup {
  const durationSeconds =
    input.durationMs != null && Number.isFinite(input.durationMs) && input.durationMs > 0
      ? Math.round(input.durationMs / 1000)
      : null;
  return {
    trackName: normalizeText(input.trackName),
    artistName: normalizeText(input.artistName),
    albumName: input.albumName ? normalizeText(input.albumName) : null,
    durationSeconds,
    isrc: input.isrc?.trim().toUpperCase() ?? null,
    providerTrackUri: input.providerTrackUri ?? null,
  };
}

/**
 * Stable cache key for a normalized lookup. Format:
 *   <track>|<artist>|<album?>|<seconds?>|<isrc?>
 * URI is intentionally NOT in the key — the same track from different
 * providers should hit the same lyrics cache entry.
 */
export function lookupCacheKey(normalized: NormalizedLookup): string {
  return [
    normalized.trackName,
    normalized.artistName,
    normalized.albumName ?? '',
    normalized.durationSeconds ?? '',
    normalized.isrc ?? '',
  ].join('|');
}
