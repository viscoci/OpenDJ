/**
 * Re-ranks Deezer search hits. Deezer's raw order is cluttered with remixes,
 * live takes, karaoke and cover versions, and knock-off artists, so the
 * source asks for more hits than it needs and re-ranks them here:
 *
 * 1. Duplicates collapse to one hit per (title core, primary artist), keeping
 *    the highest Deezer `rank` (popularity). The title core drops neutral
 *    qualifiers (remaster, explicit, feat., `From "..."`) but keeps variant
 *    ones, so a remix never collapses into its original.
 * 2. Each hit scores `log(rank + 1)` normalised to the batch's top rank (0-1),
 *    minus `VARIANT_PENALTY` when a title qualifier (a `(...)` / `[...]`
 *    group or a ` - ...` suffix) or the artist name carries a variant marker
 *    the query didn't ask for, plus `ALL_TOKENS_BONUS` when every query word
 *    starts a word of the title or artist, plus `REQUESTED_BONUS` when the
 *    local catalog says guests requested that ISRC.
 * 3. Ties keep Deezer's order.
 *
 * `isConfidentAnswer` says whether the top of a ranked batch holds a
 * plausible original: a non-variant hit matching every query word whose
 * Deezer rank is at least the confidence threshold. Deezer lacks some
 * originals and answers only covers and remixes for them; such answers are
 * not confident.
 */

import type { SourceTrack } from './SearchSource.js';

export const VARIANT_PENALTY = 0.5;
export const ALL_TOKENS_BONUS = 0.25;
export const REQUESTED_BONUS = 0.3;

/**
 * Variant markers, matched as whole words in a title qualifier. A group is
 * excused when the query contains any of its words.
 */
const TITLE_MARKER_GROUPS: ReadonlyArray<ReadonlyArray<string>> = [
  ['live'],
  ['remix', 'remixed'],
  ['mix'],
  ['edit'],
  ['karaoke'],
  ['cover'],
  ['tribute'],
  ['instrumental'],
  ['acoustic'],
  ['orchestra', 'orchestral'],
  ['tv size'],
  ['sped up'],
  ['slowed', 'reverb'],
  ['version', 'ver'],
  ['made famous'],
  ['originally performed'],
  ['in the style of'],
];

/** Markers that also flag an artist name (karaoke and tribute acts). */
const ARTIST_MARKER_GROUPS: ReadonlyArray<ReadonlyArray<string>> = [
  ['karaoke'],
  ['cover', 'covers'],
  ['tribute'],
  ['made famous'],
  ['originally performed'],
  ['in the style of'],
];

/** Qualifiers that never make a hit a variant and are dropped from the title core. */
const NEUTRAL_QUALIFIER =
  /^(?:from |feat |ft |featuring |with |taylor s version$|(?:\d{4} )?(?:digital(?:ly)? )?remaster(?:ed)?(?: \d{4})?(?: version| edition)?$|explicit$|clean$|mono$|stereo$|(?:original|album|single) (?:mix|version)$)/;

/** Lowercase, accents dropped, punctuation turned to spaces, spaces collapsed. */
export function normalizeText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

interface SplitTitle {
  /** Normalised title without any qualifier. */
  base: string;
  /** Normalised qualifiers: `(...)`, `[...]` groups and a ` - ...` suffix. */
  qualifiers: string[];
}

function splitTitle(title: string): SplitTitle {
  const qualifiers: string[] = [];
  let rest = title.replace(/[([]([^()[\]]*)[)\]]/g, (_m, inner: string) => {
    qualifiers.push(normalizeText(inner));
    return ' ';
  });
  const dash = /\s[-–—]\s/.exec(rest);
  if (dash) {
    for (const part of rest.slice(dash.index + dash[0].length).split(/\s[-–—]\s/)) {
      qualifiers.push(normalizeText(part));
    }
    rest = rest.slice(0, dash.index);
  }
  return { base: normalizeText(rest), qualifiers: qualifiers.filter((q) => q !== '') };
}

const hasPhrase = (padded: string, phrase: string): boolean => padded.includes(` ${phrase} `);

function carriesMarker(
  text: string,
  groups: ReadonlyArray<ReadonlyArray<string>>,
  paddedQuery: string,
): boolean {
  const padded = ` ${text} `;
  return groups.some(
    (group) =>
      group.some((word) => hasPhrase(padded, word)) &&
      !group.some((word) => hasPhrase(paddedQuery, word)),
  );
}

/** The first credited artist, normalised. */
function primaryArtist(artist: string): string {
  const first = artist.split(/,|&| feat\.? | ft\.? | featuring | x /i)[0] ?? artist;
  return normalizeText(first);
}

export interface RankableHit {
  track: SourceTrack;
  /** Deezer's popularity `rank`; 0 when missing. */
  rank: number;
}

/** A re-ranked hit with the facts its score was built from. */
export interface ScoredHit {
  track: SourceTrack;
  rank: number;
  /** Carries a variant marker the query didn't ask for. */
  variant: boolean;
  /** Every query word starts a word of the title or artist. */
  allTokens: boolean;
}

/**
 * `hits` (in Deezer's order) deduplicated and re-ranked for `query`.
 * `requested` maps an ISRC to how often guests requested it.
 */
export function rankDeezerHits(
  query: string,
  hits: ReadonlyArray<RankableHit>,
  requested: ReadonlyMap<string, number> = new Map(),
): SourceTrack[] {
  return scoreDeezerHits(query, hits, requested).map((h) => h.track);
}

/** Queries with fewer non-space characters are always confident (partial typing). */
export const MIN_CONFIDENCE_QUERY_CHARS = 3;

/**
 * Whether the first `limit` of `scored` (from `scoreDeezerHits`) hold a
 * non-variant hit that matches every query word with a Deezer rank of at
 * least `minRank`. Queries shorter than `MIN_CONFIDENCE_QUERY_CHARS`
 * non-space characters are always confident.
 */
export function isConfidentAnswer(
  query: string,
  scored: ReadonlyArray<ScoredHit>,
  limit: number,
  minRank: number,
): boolean {
  if (query.replace(/\s/g, '').length < MIN_CONFIDENCE_QUERY_CHARS) return true;
  return scored.slice(0, limit).some((hit) => !hit.variant && hit.allTokens && hit.rank >= minRank);
}

/** `rankDeezerHits` with each hit's rank, variant, and all-words facts. */
export function scoreDeezerHits(
  query: string,
  hits: ReadonlyArray<RankableHit>,
  requested: ReadonlyMap<string, number> = new Map(),
): ScoredHit[] {
  const deduped = dedupeHits(hits);
  const paddedQuery = ` ${normalizeText(query)} `;
  const queryTokens = normalizeText(query).split(' ').filter(Boolean);
  const maxLog = Math.log(Math.max(0, ...deduped.map((h) => h.rank)) + 1);

  const scored = deduped.map((hit) => {
    const { qualifiers } = splitTitle(hit.track.trackName);
    const variant =
      qualifiers.some(
        (q) => !NEUTRAL_QUALIFIER.test(q) && carriesMarker(q, TITLE_MARKER_GROUPS, paddedQuery),
      ) || carriesMarker(normalizeText(hit.track.artistName), ARTIST_MARKER_GROUPS, paddedQuery);
    const words = normalizeText(`${hit.track.trackName} ${hit.track.artistName}`).split(' ');
    const allTokens =
      queryTokens.length > 0 && queryTokens.every((t) => words.some((w) => w.startsWith(t)));
    const isrc = hit.track.isrc;
    const wasRequested = isrc !== undefined && (requested.get(isrc) ?? 0) > 0;
    const score =
      (maxLog > 0 ? Math.log(hit.rank + 1) / maxLog : 0) -
      (variant ? VARIANT_PENALTY : 0) +
      (allTokens ? ALL_TOKENS_BONUS : 0) +
      (wasRequested ? REQUESTED_BONUS : 0);
    return { track: hit.track, rank: hit.rank, variant, allTokens, score, index: hit.index };
  });

  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map(({ track, rank, variant, allTokens }) => ({ track, rank, variant, allTokens }));
}

/** One hit per (title core, primary artist): the highest rank, at its own position. */
function dedupeHits(hits: ReadonlyArray<RankableHit>): Array<RankableHit & { index: number }> {
  const best = new Map<string, RankableHit & { index: number }>();
  hits.forEach((hit, index) => {
    const { base, qualifiers } = splitTitle(hit.track.trackName);
    const core = [base, ...qualifiers.filter((q) => !NEUTRAL_QUALIFIER.test(q))].join(' | ');
    const key = `${core}\u0000${primaryArtist(hit.track.artistName)}`;
    const kept = best.get(key);
    if (!kept || hit.rank > kept.rank) best.set(key, { ...hit, index });
  });
  return [...best.values()];
}
